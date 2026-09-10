import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { SessionEvent } from '@devpilot/shared';
import type { SessionRow } from '@devpilot/storage';
import {
  appendSessionEvent,
  endSession as endSessionRow,
  findProjectByRootPath,
  getActiveSession,
  getSessionById,
  insertSession,
  listSessions,
  openGlobalRegistryDb,
  openProjectDb,
  readSessionEvents,
} from '@devpilot/storage';
import { createDecision } from '../decisions/decisionService.js';
import type { CreateDecisionResult } from '../decisions/decisionService.js';

// Session Memory real (04, "Session Memory") — `devpilot session` (07,
// Incremento 2, segunda pieza de "Project Memory"). La tabla `sessions`
// existía en el esquema desde el Incremento 0 sin usarse (mismo patrón que
// `decisions`/`task_benchmarks` en piezas anteriores): hasta ahora,
// `context_packs.session_id`/`tool_invocations.session_id` siempre se
// insertaban en NULL porque no había ninguna sesión real a la cual
// apuntar (ver contextPackRepo.ts/applyService.ts antes de esta pieza).
//
// "Una sesión = una invocación conceptual de trabajo... puede abarcar
// varios comandos CLI" (04) — a lo sumo una activa a la vez por proyecto
// (se rechaza `session start` si ya hay una, en vez de permitir
// superponerlas). El detalle turno-a-turno vive en
// `.devpilot/sessions/<id>.jsonl` (ver sessionEventStore.ts); esta capa
// además hace que `devpilot context`/`import`/`apply`/`decide` agreguen
// eventos automáticamente a la sesión activa mientras corren (ver
// sessionEventLogger.ts), así que el log termina siendo un timeline real,
// no algo que el usuario tiene que llenar a mano.

function resolveProjectOrThrow(rootPath: string): void {
  const registryDb = openGlobalRegistryDb();
  try {
    const project = findProjectByRootPath(registryDb, rootPath);
    if (!project) {
      throw new Error(`Este proyecto no está registrado todavía. Corre \`devpilot project add ${rootPath}\` primero.`);
    }
  } finally {
    registryDb.close();
  }
}

const DEFAULT_SESSION_LIST_LIMIT = 20;

export interface StartSessionParams {
  rawPath: string;
  taskSummary?: string;
  providerUsed?: string;
}

/** `devpilot session start "<resumen>"`: abre una sesión nueva. Falla si ya hay una activa — no tiene sentido superponer dos "invocaciones conceptuales de trabajo" (04); hay que cerrar la anterior primero con `devpilot session end`. */
export async function startSession(params: StartSessionParams): Promise<SessionRow> {
  const rootPath = path.resolve(params.rawPath);
  resolveProjectOrThrow(rootPath);

  const projectDb = openProjectDb(rootPath);
  let row: SessionRow;
  try {
    const active = getActiveSession(projectDb);
    if (active) {
      throw new Error(
        `Ya hay una sesión activa (${active.id}, iniciada ${active.startedAt}${active.taskSummary ? ` — "${active.taskSummary}"` : ''}). Cerrala primero con \`devpilot session end\` antes de empezar una nueva.`,
      );
    }
    row = {
      id: randomUUID(),
      startedAt: new Date().toISOString(),
      endedAt: null,
      taskSummary: params.taskSummary ?? null,
      providerUsed: params.providerUsed ?? null,
      // Determinístico por id (ver getProjectSessionEventsPath en paths.ts)
      // — no hace falta persistir la ruta, igual que el espejo de
      // decisiones no persiste su propia ruta.
      eventsPath: null,
    };
    insertSession(projectDb, row);
  } finally {
    projectDb.close();
  }

  await appendSessionEvent(rootPath, row.id, {
    timestamp: row.startedAt,
    kind: 'session-started',
    detail: params.taskSummary ? { taskSummary: params.taskSummary } : undefined,
  });

  return row;
}

export interface EndSessionParams {
  rawPath: string;
  summary?: string;
}

/** `devpilot session end`: cierra la sesión activa del proyecto (no hace falta pasar un id — solo puede haber una activa a la vez). */
export async function endActiveSession(params: EndSessionParams): Promise<SessionRow> {
  const rootPath = path.resolve(params.rawPath);
  resolveProjectOrThrow(rootPath);

  const projectDb = openProjectDb(rootPath);
  let updated: SessionRow;
  try {
    const active = getActiveSession(projectDb);
    if (!active) {
      throw new Error('No hay ninguna sesión activa para cerrar. Usa `devpilot session start "<resumen>"` para empezar una.');
    }
    const endedAt = new Date().toISOString();
    endSessionRow(projectDb, active.id, { endedAt, taskSummary: params.summary });
    updated = { ...active, endedAt, taskSummary: params.summary ?? active.taskSummary };
  } finally {
    projectDb.close();
  }

  await appendSessionEvent(rootPath, updated.id, {
    timestamp: updated.endedAt as string,
    kind: 'session-ended',
    detail: params.summary ? { summary: params.summary } : undefined,
  });

  return updated;
}

/** `devpilot context`/`apply`/etc. la usan para saber a qué sesión atar lo que están haciendo — `null` si no hay ninguna activa (Session Memory es opcional). */
export async function getActiveProjectSession(rawPath: string): Promise<SessionRow | null> {
  const rootPath = path.resolve(rawPath);
  resolveProjectOrThrow(rootPath);
  const projectDb = openProjectDb(rootPath);
  try {
    return getActiveSession(projectDb);
  } finally {
    projectDb.close();
  }
}

/** `devpilot session list`. */
export async function listProjectSessions(rawPath: string, limit: number = DEFAULT_SESSION_LIST_LIMIT): Promise<SessionRow[]> {
  const rootPath = path.resolve(rawPath);
  resolveProjectOrThrow(rootPath);
  const projectDb = openProjectDb(rootPath);
  try {
    return listSessions(projectDb, limit);
  } finally {
    projectDb.close();
  }
}

export interface SessionWithEvents extends SessionRow {
  events: SessionEvent[];
}

/** `devpilot session show <id>`: el resumen (SQLite) + el log completo (`.jsonl`). */
export async function getProjectSession(rawPath: string, id: string): Promise<SessionWithEvents | null> {
  const rootPath = path.resolve(rawPath);
  resolveProjectOrThrow(rootPath);
  const projectDb = openProjectDb(rootPath);
  let row: SessionRow | null;
  try {
    row = getSessionById(projectDb, id);
  } finally {
    projectDb.close();
  }
  if (!row) return null;
  const events = await readSessionEvents(rootPath, id);
  return { ...row, events };
}

/** `devpilot session note "<texto>"`: evento manual (kind `'note'`) en la sesión activa — para algo que vale la pena recordar y que ningún comando logueó solo (ej. algo que el usuario explicó en el chat web, fuera de DevPilot). Falla si no hay sesión activa: una nota necesita una sesión a la cual pertenecer. */
export async function addSessionNote(rawPath: string, text: string): Promise<{ sessionId: string }> {
  const rootPath = path.resolve(rawPath);
  resolveProjectOrThrow(rootPath);

  const projectDb = openProjectDb(rootPath);
  let active: SessionRow | null;
  try {
    active = getActiveSession(projectDb);
  } finally {
    projectDb.close();
  }
  if (!active) {
    throw new Error('No hay ninguna sesión activa. Usa `devpilot session start "<resumen>"` primero.');
  }

  await appendSessionEvent(rootPath, active.id, {
    timestamp: new Date().toISOString(),
    kind: 'note',
    detail: { text },
  });

  return { sessionId: active.id };
}

export interface PromoteSessionEventParams {
  rawPath: string;
  sessionId: string;
  /** Índice del evento dentro del log de la sesión (0-based, mismo orden que `devpilot session show <id>` lo numera). */
  eventIndex: number;
  title: string;
  decisionText: string;
  /** Si no se pasa, se genera uno describiendo de qué evento viene (sesión + índice + kind) — igual sirve para que la Decision Record no quede sin contexto, pero vale la pena escribir uno propio cuando el evento automático no alcanza a explicar el "por qué". */
  context?: string;
  consequences?: string;
  tags?: string[];
  relatedFiles?: string[];
  status?: 'proposed' | 'accepted';
}

/**
 * `devpilot session promote <id>`: Session Memory es memoria de corto
 * plazo, "candidata a promoverse a una Decision Record si algo importante
 * se decidió" (04) — esta es esa promoción. Toma un evento puntual del log
 * de una sesión (activa o ya cerrada, no importa) y crea una Decision
 * Record real a partir de él, dejando además un evento
 * `'decision-promoted'` en esa misma sesión para no perder el rastro de
 * qué evento originó qué decisión.
 */
export async function promoteSessionEvent(params: PromoteSessionEventParams): Promise<CreateDecisionResult> {
  const rootPath = path.resolve(params.rawPath);
  resolveProjectOrThrow(rootPath);

  const events = await readSessionEvents(rootPath, params.sessionId);
  const sourceEvent = events[params.eventIndex];
  if (!sourceEvent) {
    throw new Error(
      `La sesión ${params.sessionId} no tiene ningún evento en la posición ${params.eventIndex} (tiene ${events.length} evento(s) — usa \`devpilot session show ${params.sessionId}\` para ver los índices disponibles).`,
    );
  }

  const fallbackContext = `Promovido desde la sesión ${params.sessionId}, evento #${params.eventIndex} (${sourceEvent.kind}, ${sourceEvent.timestamp})${
    sourceEvent.detail ? `: ${JSON.stringify(sourceEvent.detail)}` : ''
  }.`;

  const result = await createDecision({
    rawPath: params.rawPath,
    title: params.title,
    context: params.context ?? fallbackContext,
    decisionText: params.decisionText,
    consequences: params.consequences,
    tags: params.tags,
    relatedFiles: params.relatedFiles,
    status: params.status,
  });

  await appendSessionEvent(rootPath, params.sessionId, {
    timestamp: new Date().toISOString(),
    kind: 'decision-promoted',
    detail: {
      sourceEventIndex: params.eventIndex,
      decisionId: result.decision.id,
      decisionTitle: result.decision.title,
    },
  });

  return result;
}
