import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createLogger } from '@devpilot/shared';
import type { ContextPack, SessionMemory } from '@devpilot/shared';
import type { SessionRow } from '@devpilot/storage';
import {
  findProjectByRootPath,
  getActiveSession,
  insertContextPack,
  insertContextPackDecision,
  insertTaskBenchmark,
  listAllSymbolsWithFilePath,
  listDecisions,
  openGlobalRegistryDb,
  openProjectDb,
  readSessionEvents,
  readSnapshotFile,
  writeContextPackFiles,
} from '@devpilot/storage';
import { buildContextPack, DEFAULT_MAX_FILES } from './contextPackBuilder.js';
import { renderContextPackMarkdown } from './markdownRenderer.js';
import { copyToClipboard } from './clipboard.js';
import { findRelevantDecisions, toDecisionRecord } from '../decisions/decisionService.js';
import { logSessionEvent } from '../sessions/sessionEventLogger.js';
import { listProjectKnowledgeWithContent, toProjectKnowledgeDoc } from '../knowledge/knowledgeService.js';
import { createGitAdapter } from '../project/gitAdapter.js';

// Cuántos eventos recientes de la sesión activa se incluyen en el pack
// (04: Session Memory es memoria de CORTO plazo — un resumen, no el log
// completo). Una sesión larga puede acumular decenas de eventos; solo los
// últimos son relevantes para "qué veníamos haciendo" en el momento de
// generar este Context Pack puntual.
const MAX_SESSION_EVENTS_IN_PACK = 10;

// Nivel 4 del Context Planner (04, Incremento 3): cuántos commits recientes
// se traen para el boost de recencia/afinidad — acotado por el mismo
// motivo que MAX_SEED_FILES en relevancePlanner.ts, no tiene sentido traer
// todo el historial para "refinar" candidatos que Nivel 1/2/3 ya
// encontraron.
const GIT_LOG_LIMIT_FOR_RELEVANCE = 50;

const logger = createLogger('core:context');

export interface BuildAndPersistContextParams {
  rawPath: string;
  taskText: string;
  confirmedDecisions?: string[];
  openDecisions?: string[];
  constraints?: string[];
  maxFiles?: number;
}

export interface BuildAndPersistContextResult {
  pack: ContextPack;
  markdownPath: string;
  jsonPath: string;
  copiedToClipboard: boolean;
  candidateCount: number;
}

/** `devpilot context "<tarea>"` (ver 07, Incremento 1): corre el Context Planner sobre un proyecto ya registrado (`devpilot project add`) y persiste el Context Pack resultante. */
export async function buildAndPersistContext(
  params: BuildAndPersistContextParams,
): Promise<BuildAndPersistContextResult> {
  const rootPath = path.resolve(params.rawPath);

  const registryDb = openGlobalRegistryDb();
  let project;
  try {
    project = findProjectByRootPath(registryDb, rootPath);
  } finally {
    registryDb.close();
  }

  if (!project) {
    throw new Error(
      `Este proyecto no está registrado todavía. Corre \`devpilot project add ${params.rawPath}\` primero.`,
    );
  }

  const snapshot = await readSnapshotFile(rootPath);
  if (!snapshot) {
    throw new Error(
      `No hay un snapshot guardado para este proyecto. Corre \`devpilot project add ${params.rawPath}\` primero.`,
    );
  }

  // Decision Records reales relevantes a esta tarea (04, "Confirmadas se
  // llena, a partir del Incremento 2, desde `decisions`") — se abre y
  // cierra la base acá mismo, separado del open/close de más abajo (mismo
  // patrón que importService.ts, que también abre la base del proyecto
  // más de una vez dentro de la misma función).
  const decisionsDb = openProjectDb(rootPath);
  let relevantDecisionRows;
  try {
    relevantDecisionRows = findRelevantDecisions(params.taskText, listDecisions(decisionsDb));
  } finally {
    decisionsDb.close();
  }
  const relevantDecisions = relevantDecisionRows.map((row) => toDecisionRecord(row, project.id));

  // Session Memory real (04/07, Incremento 2): si hay una sesión activa
  // para este proyecto, se incluye como ingrediente del pack — resumen
  // corto + los últimos eventos de su log (04: "Session Memory relevante"
  // combinada por el ContextPackBuilder). Si no hay ninguna activa, sigue
  // el comportamiento de antes de esta pieza (sessionId de un solo uso,
  // sin sessionMemory) — Session Memory es opcional.
  const sessionDb = openProjectDb(rootPath);
  let activeSession: SessionRow | null;
  try {
    activeSession = getActiveSession(sessionDb);
  } finally {
    sessionDb.close();
  }
  let sessionMemory: SessionMemory | undefined;
  // Context Compaction, estrategia 2 (04, Incremento 3, ver
  // contextCompaction.ts): ids de knowledge docs ya enviados en un pack
  // anterior de ESTA MISMA sesión, para no repetir su texto completo si el
  // pack nuevo se pasa de 🟢. Solo tiene sentido si hay una sesión activa
  // -- sin sesión no hay "packs anteriores de la misma sesión" con los que
  // comparar. Se lee del propio log de Session Memory (cada evento
  // 'context' ya guarda `knowledgeDocIds`, ver el `logSessionEvent` al
  // final de esta función) en vez de reabrir los JSON de packs viejos.
  const alreadySentKnowledgeDocIds = new Set<string>();
  if (activeSession) {
    const allEvents = await readSessionEvents(rootPath, activeSession.id);
    sessionMemory = {
      id: activeSession.id,
      projectId: project.id,
      startedAt: activeSession.startedAt,
      endedAt: activeSession.endedAt ?? undefined,
      taskSummary: activeSession.taskSummary ?? undefined,
      providerUsed: activeSession.providerUsed ?? undefined,
      events: allEvents.slice(-MAX_SESSION_EVENTS_IN_PACK),
    };
    for (const event of allEvents) {
      if (event.kind !== 'context') continue;
      const ids = event.detail?.knowledgeDocIds;
      if (Array.isArray(ids)) {
        for (const id of ids) {
          if (typeof id === 'string') alreadySentKnowledgeDocIds.add(id);
        }
      }
    }
  }

  // Git Intelligence (04/02, Incremento 3): Nivel 3 (símbolos, ver
  // symbolRepo.ts) y Nivel 4 (Git, ver gitAdapter.ts) del Context Planner,
  // más `recentChanges` (working tree sin commitear) para el pack. Todo
  // opcional: un proyecto sin `devpilot project add` corrido todavía (sin
  // símbolos indexados) o sin git simplemente no aporta esas señales —
  // Nivel 1/2 siguen funcionando exactamente igual (ver relevancePlanner.ts).
  const symbolsDb = openProjectDb(rootPath);
  let symbolIndex;
  try {
    symbolIndex = listAllSymbolsWithFilePath(symbolsDb).map((row) => ({
      relPath: row.filePath,
      name: row.name,
      isExported: row.isExported,
    }));
  } finally {
    symbolsDb.close();
  }

  const git = createGitAdapter(rootPath);
  const isGitRepo = project.vcs === 'git' && (await git.isRepo());
  const recentCommits = isGitRepo ? await git.log({ limit: GIT_LOG_LIMIT_FOR_RELEVANCE }) : undefined;
  const recentChanges = isGitRepo ? await git.diff() : undefined;

  // Project Knowledge (04/07, Incremento 2, última pieza): siempre
  // completo, sin filtrar por relevancia (ver el comentario en
  // contextPackBuilder.ts) — cardinalidad chica por diseño, así que no
  // hace falta el mismo matching por keywords que decisions/sessions.
  const knowledgeRows = await listProjectKnowledgeWithContent(rootPath);
  const knowledgeDocs = knowledgeRows.map((row) => ({
    doc: toProjectKnowledgeDoc(row, project.id),
    content: row.content,
  }));

  const { pack, candidateCount } = buildContextPack({
    project,
    snapshot,
    taskText: params.taskText,
    confirmedDecisions: params.confirmedDecisions ?? [],
    openDecisions: params.openDecisions ?? [],
    constraints: params.constraints ?? [],
    relevantDecisions,
    sessionId: activeSession?.id,
    sessionMemory,
    knowledgeDocs,
    alreadySentKnowledgeDocIds,
    symbolIndex,
    recentCommits,
    recentChanges,
    maxFiles: params.maxFiles ?? DEFAULT_MAX_FILES,
  });

  const markdown = renderContextPackMarkdown(pack, project, snapshot);

  const { markdownPath, jsonPath } = await writeContextPackFiles(rootPath, pack, markdown);

  // Bug real encontrado al implementar `devpilot diff` en una sesión
  // distinta a la que generó el Context Pack (ver diffService.ts/07): estas
  // rutas son absolutas en el momento de escribirse, y `rootPath` puede
  // venir de un punto de montaje que no es estable entre sesiones (p.ej. el
  // puente de dispositivo de Cowork). Guardar la ruta absoluta en SQLite
  // rompe justo la garantía de portabilidad que 03 promete explícitamente
  // ("si el usuario mueve o comparte la carpeta... su conocimiento viaja
  // con ella") — si el usuario mueve el proyecto, la ruta absoluta vieja
  // ya no sirve aunque el archivo siga ahí, relativo a la nueva raíz. Se
  // persiste relativo a `rootPath`; quien lea la fila (import/diff) la
  // resuelve de vuelta a absoluta contra el `rootPath` *actual*, no el de
  // cuando se generó.
  const projectDb = openProjectDb(rootPath);
  try {
    insertContextPack(projectDb, {
      id: pack.id,
      sessionId: activeSession?.id ?? null,
      taskText: pack.task.rawText,
      createdAt: pack.createdAt,
      tokenEstimate: pack.tokenEstimate.totalTokens,
      classification: pack.tokenEstimate.classification,
      markdownPath: path.relative(rootPath, markdownPath),
      jsonPath: path.relative(rootPath, jsonPath),
    });

    // Benchmark automático por tarea (03/04, cierre del Incremento 1 — ver
    // 07): una fila por Context Pack, creada acá con lo único que ya se
    // sabe en este momento (tarea, tokens estimados, archivos incluidos).
    // `devpilot import`/`devpilot apply` la van completando después — no
    // existe un paso explícito de "cerrar tarea", el benchmark refleja el
    // estado más reciente conocido para este pack.
    insertTaskBenchmark(projectDb, {
      id: randomUUID(),
      contextPackId: pack.id,
      taskText: pack.task.rawText,
      contextTokens: pack.tokenEstimate.totalTokens,
      filesIncluded: pack.relevantFiles.length,
      filesUsed: null,
      filesUnnecessary: null,
      responseSizeChars: null,
      changesImported: 0,
      changesApplied: 0,
      outcome: 'not_applied',
      createdAt: pack.createdAt,
    });

    // `context_pack_decisions` (03): qué decisiones de negocio se
    // consideraron en este pack — separado en su propia tabla para poder
    // consultarlo con SQL (ej. `devpilot decide show` cuenta en cuántos
    // packs se usó cada Decision Record) sin tener que abrir el JSON del
    // pack. Se insertan desde las fuentes originales (no desde
    // `pack.businessDecisions.confirmed`, que ya viene aplanada a texto y
    // no distingue una Decision Record real de algo tipeado a mano).
    for (const decision of relevantDecisions) {
      insertContextPackDecision(projectDb, {
        id: randomUUID(),
        contextPackId: pack.id,
        kind: 'confirmed',
        text: `${decision.title} — ${decision.decision}`,
        resolvedDecisionId: decision.id,
      });
    }
    for (const text of params.confirmedDecisions ?? []) {
      insertContextPackDecision(projectDb, {
        id: randomUUID(),
        contextPackId: pack.id,
        kind: 'confirmed',
        text,
        resolvedDecisionId: null,
      });
    }
    for (const text of params.openDecisions ?? []) {
      insertContextPackDecision(projectDb, {
        id: randomUUID(),
        contextPackId: pack.id,
        kind: 'open',
        text,
        resolvedDecisionId: null,
      });
    }
  } finally {
    projectDb.close();
  }

  const copiedToClipboard = copyToClipboard(markdown);
  logger.debug('context pack generado', pack.id, 'archivos:', pack.relevantFiles.length);

  await logSessionEvent(rootPath, 'context', {
    contextPackId: pack.id,
    taskText: pack.task.rawText,
    filesIncluded: pack.relevantFiles.length,
    knowledgeDocsIncluded: pack.projectKnowledge.length,
    // Context Compaction, estrategia 2 (ver más arriba en esta función y
    // contextCompaction.ts): el PRÓXIMO Context Pack de esta misma sesión
    // lee esto para saber qué ya no hace falta repetir completo.
    knowledgeDocIds: pack.projectKnowledge.map((d) => d.id),
  });

  return { pack, markdownPath, jsonPath, copiedToClipboard, candidateCount };
}
