import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { DecisionRecord } from '@devpilot/shared';
import type { DecisionRow } from '@devpilot/storage';
import {
  countContextPackDecisionsByDecisionId,
  findProjectByRootPath,
  getDecisionById,
  insertDecision,
  listDecisions,
  openGlobalRegistryDb,
  openProjectDb,
  updateDecisionStatus,
  writeDecisionFile,
} from '@devpilot/storage';
import { extractKeywords } from '../context/keywords.js';
import { logSessionEvent } from '../sessions/sessionEventLogger.js';

// Decision Records (04, "memoria de largo plazo que sobrevive a cualquier
// sesión futura") — `devpilot decide` (07, Incremento 2, primera pieza de
// "Project Memory"). La tabla `decisions` existía en el esquema desde el
// Incremento 0 sin usarse; este es su primer consumidor real, mismo patrón
// que `tool_invocations` (devpilot apply) y `task_benchmarks` (devpilot
// benchmark) en el Incremento 1.

export class EmptyDecisionFieldError extends Error {
  readonly code = 'EMPTY_DECISION_FIELD';
  readonly field: 'title' | 'context' | 'decision';

  constructor(field: 'title' | 'context' | 'decision') {
    const label = field === 'title' ? 'título' : field === 'context' ? '--context' : '--decision';
    super(
      `El campo ${label} no puede estar vacío. \`devpilot decide\` necesita ese contenido para ` +
        'crear una Decision Record con sentido (ver 04, formato tipo ADR).',
    );
    this.name = 'EmptyDecisionFieldError';
    this.field = field;
  }
}

/**
 * Igual que \`assertNonEmptyTask\` en contextPackBuilder.ts (mismo patrón:
 * falla explícito antes de tocar disco/SQLite en vez de dejar pasar un
 * título o contexto en blanco). \`consequences\`, \`relatedFiles\` y \`tags\`
 * son opcionales por diseño, así que no se validan acá.
 */
export function assertNonEmptyDecisionParams(
  params: Pick<CreateDecisionParams, 'title' | 'context' | 'decisionText'>,
): void {
  if (params.title.trim().length === 0) throw new EmptyDecisionFieldError('title');
  if (params.context.trim().length === 0) throw new EmptyDecisionFieldError('context');
  if (params.decisionText.trim().length === 0) throw new EmptyDecisionFieldError('decision');
}

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

export interface CreateDecisionParams {
  rawPath: string;
  title: string;
  context: string;
  decisionText: string;
  consequences?: string;
  relatedFiles?: string[];
  tags?: string[];
  status?: 'proposed' | 'accepted' | 'superseded';
}

export interface CreateDecisionResult {
  decision: DecisionRow;
  markdownPath: string;
}

/** `devpilot decide "<título>"`: crea una Decision Record — memoria de largo plazo, nunca se borra (ver `supersedeDecision` para cómo se "cierra" una). */
export async function createDecision(params: CreateDecisionParams): Promise<CreateDecisionResult> {
  assertNonEmptyDecisionParams(params);
  const rootPath = path.resolve(params.rawPath);
  resolveProjectOrThrow(rootPath);

  const row: DecisionRow = {
    id: randomUUID(),
    title: params.title,
    context: params.context,
    decision: params.decisionText,
    consequences: params.consequences ?? null,
    status: params.status ?? 'accepted',
    relatedFiles: params.relatedFiles ?? [],
    tags: params.tags ?? [],
    createdAt: new Date().toISOString(),
  };

  // Igual que Context Packs/propuestas de cambio: el Markdown es un
  // espejo legible, no la fuente de verdad (ver decisionStore.ts) — se
  // escribe primero porque si falla (disco lleno, permisos), preferimos no
  // dejar una fila en SQLite sin su espejo, no al revés.
  const markdownPath = await writeDecisionFile(rootPath, row);

  const projectDb = openProjectDb(rootPath);
  try {
    insertDecision(projectDb, row);
  } finally {
    projectDb.close();
  }

  // Best-effort: si hay una sesión activa para este proyecto (04, Session
  // Memory), queda registro de que esta decisión se creó durante ella —
  // sin esto, `devpilot session show` no podría reconstruir "qué se
  // decidió mientras trabajábamos en esto". Silencioso si no hay ninguna
  // activa (ver sessionEventLogger.ts) — crear una decisión no depende de
  // tener una sesión abierta.
  await logSessionEvent(rootPath, 'decision-created', { decisionId: row.id, title: row.title });

  return { decision: row, markdownPath };
}

/** `devpilot decide list`. */
export async function listProjectDecisions(rawPath: string): Promise<DecisionRow[]> {
  const rootPath = path.resolve(rawPath);
  resolveProjectOrThrow(rootPath);
  const projectDb = openProjectDb(rootPath);
  try {
    return listDecisions(projectDb);
  } finally {
    projectDb.close();
  }
}

export interface DecisionWithUsage extends DecisionRow {
  /** En cuántos Context Packs distintos se consideró esta decisión hasta ahora (ver `context_pack_decisions`, 03) — una señal simple de qué tan viva sigue siendo. */
  usedInPacksCount: number;
}

/** `devpilot decide show <id>`. */
export async function getProjectDecision(rawPath: string, id: string): Promise<DecisionWithUsage | null> {
  const rootPath = path.resolve(rawPath);
  resolveProjectOrThrow(rootPath);
  const projectDb = openProjectDb(rootPath);
  try {
    const row = getDecisionById(projectDb, id);
    if (!row) return null;
    return { ...row, usedInPacksCount: countContextPackDecisionsByDecisionId(projectDb, id) };
  } finally {
    projectDb.close();
  }
}

/**
 * `devpilot decide supersede <id>`: una Decision Record superada nunca se
 * borra — sigue siendo historia real del proyecto (04) — solo deja de
 * ofrecerse como "confirmada" en Context Packs nuevos (ver
 * `findRelevantDecisions` de abajo, que filtra `status === 'superseded'`).
 */
export async function supersedeDecision(rawPath: string, id: string): Promise<DecisionRow> {
  const rootPath = path.resolve(rawPath);
  resolveProjectOrThrow(rootPath);

  const projectDb = openProjectDb(rootPath);
  let updated: DecisionRow;
  try {
    const existing = getDecisionById(projectDb, id);
    if (!existing) {
      throw new Error(`No existe ninguna decisión con id ${id} en este proyecto. Usa \`devpilot decide list\` para ver los ids disponibles.`);
    }
    if (existing.status === 'superseded') {
      throw new Error(`La decisión "${existing.title}" (${id}) ya estaba marcada como superseded.`);
    }
    updateDecisionStatus(projectDb, id, 'superseded');
    updated = { ...existing, status: 'superseded' };
  } finally {
    projectDb.close();
  }

  // Re-escribe el espejo Markdown con el estado nuevo — misma ruta
  // determinística por id, así que esto es un overwrite, no un archivo
  // nuevo.
  await writeDecisionFile(rootPath, updated);
  return updated;
}

const DEFAULT_MAX_RELEVANT_DECISIONS = 5;

/**
 * Matching Nivel 1 (04) aplicado a decisiones en vez de archivos: mismas
 * keywords que ya usa el Context Planner (`extractKeywords`, ver
 * keywords.ts) contra título/contexto/decisión/consecuencias/tags/archivos
 * relacionados. Deliberadamente simple — cuenta cuántas keywords aparecen
 * como substring, sin scoring ponderado; con pocas decisiones por proyecto
 * (a diferencia de cientos de archivos) no hace falta más para v1.
 * `superseded` nunca se ofrece como "confirmada" — una decisión superada
 * ya no es la respuesta correcta a la tarea actual.
 */
export function findRelevantDecisions(
  taskText: string,
  decisions: DecisionRow[],
  maxResults: number = DEFAULT_MAX_RELEVANT_DECISIONS,
): DecisionRow[] {
  const active = decisions.filter((d) => d.status !== 'superseded');
  if (active.length === 0) return [];

  const keywords = extractKeywords(taskText).map((k) => k.toLowerCase());
  if (keywords.length === 0) return [];

  const scored = active
    .map((d) => {
      const haystack = [d.title, d.context, d.decision, d.consequences ?? '', ...d.tags, ...d.relatedFiles]
        .join(' ')
        .toLowerCase();
      const matchCount = keywords.filter((k) => haystack.includes(k)).length;
      return { decision: d, matchCount };
    })
    .filter((entry) => entry.matchCount > 0);

  scored.sort((a, b) => {
    if (b.matchCount !== a.matchCount) return b.matchCount - a.matchCount;
    return new Date(b.decision.createdAt).getTime() - new Date(a.decision.createdAt).getTime();
  });

  return scored.slice(0, maxResults).map((entry) => entry.decision);
}

/** Convierte la fila de storage al tipo de dominio `DecisionRecord` (@devpilot/shared) que espera `ContextPack.decisionsConsidered` — la única diferencia es `projectId`, que no vive en la tabla por proyecto (cada proyecto tiene su propia base) y se completa acá. */
export function toDecisionRecord(row: DecisionRow, projectId: string): DecisionRecord {
  return {
    id: row.id,
    projectId,
    title: row.title,
    context: row.context,
    decision: row.decision,
    consequences: row.consequences ?? undefined,
    status: row.status as DecisionRecord['status'],
    relatedFiles: row.relatedFiles,
    tags: row.tags,
    createdAt: row.createdAt,
  };
}
