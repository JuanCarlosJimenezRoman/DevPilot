import { randomUUID } from 'node:crypto';
import type {
  ContextPack,
  DecisionRecord,
  GitCommit,
  GitDiff,
  Project,
  ProjectKnowledgeDoc,
  ProjectSnapshot,
  RelevanceScore,
  SessionMemory,
} from '@devpilot/shared';
import { normalizeIncludePath, planRelevantFiles, type SymbolIndexEntry } from './relevancePlanner.js';
import { safeReadTextFile, truncateForPack } from './fileReading.js';
import { RESPONSE_INSTRUCTIONS_ES } from './responseContract.js';
import { compactContextPack, type CompactableFile } from './contextCompaction.js';

// Ensambla el `ContextPack` — ver 04 "Context Pack — construcción final".
// Desde el Incremento 2 (07): las Decision Records reales (`devpilot
// decide`) se buscan por relevancia a la tarea (ver decisionService.ts,
// `findRelevantDecisions`) y se suman a las confirmadas escritas a mano; la
// Session Memory de la sesión activa (si hay una, ver sessionService.ts) se
// incluye como ingrediente aparte; y Project Knowledge (ver
// knowledgeService.ts) se incluye siempre completo, sin filtrar por
// relevancia (ver el comentario en `knowledgeDocs` más abajo).
//
// Desde el Incremento 3 (07, "Git Intelligence"): Nivel 3/4 del Context
// Planner (`symbolIndex`/`recentCommits`, ver relevancePlanner.ts),
// `recentChanges` (GitAdapter.diff() del working tree, ver
// contextService.ts) y Context Compaction real (contextCompaction.ts) en
// vez del truncado plano por top-N que había antes — ver el comentario
// junto a `compactContextPack` más abajo.
export const DEFAULT_MAX_FILES = 8;

// Piso de la estrategia 3 de Context Compaction (contextCompaction.ts):
// nunca se baja de esta cantidad de archivos aunque el pack siga en 🔴,
// para no terminar con un pack casi vacío en un proyecto con muchos
// candidatos grandes.
const MIN_FILES_AFTER_COMPACTION = 3;

/**
 * Error de validación de entrada del Context Pack. Se lanza ANTES de
 * generar nada (ni planner, ni lectura de archivos, ni compaction) cuando
 * `taskText` no es una tarea real. El caller (hoy `devpilot context`, ver
 * apps/cli/src/commands/context.ts) debe mostrarlo tal cual al usuario en
 * vez de propagar un stack trace.
 */
export class EmptyTaskError extends Error {
  readonly code = 'EMPTY_TASK';
  constructor() {
    super(
      'La tarea está vacía. `devpilot context` necesita una descripción de la tarea ' +
        'para decidir qué archivos incluir en el Context Pack — pasala como argumento ' +
        '(ej. `devpilot context "agregar validación de max-files"`).',
    );
    this.name = 'EmptyTaskError';
  }
}

/**
 * Guard de entrada compartido por `buildContextPack` y por el CLI (ver
 * apps/cli/src/commands/context.ts): una tarea vacía o hecha solo de
 * espacios no es una tarea, y generar un pack con `<tarea>` en blanco es
 * peor que fallar rápido (el pack se ve "válido" pero no tiene de dónde
 * inferir relevancia). Exportado para que el borde del CLI pueda fallar
 * ANTES de tocar el planner/lectura de archivos, no recién adentro.
 */
export function assertNonEmptyTask(taskText: string): void {
  if (taskText.trim().length === 0) {
    throw new EmptyTaskError();
  }
}

export interface BuildContextPackParams {
  project: Project;
  snapshot: ProjectSnapshot;
  taskText: string;
  confirmedDecisions: string[];
  openDecisions: string[];
  constraints: string[];
  /** Decision Records reales encontradas relevantes para esta tarea (ver decisionService.ts) — se suman a `confirmedDecisions` como texto y se guardan completas en `decisionsConsidered` para auditoría. Vacío por defecto (compatibilidad con quien no las pase). */
  relevantDecisions?: DecisionRecord[];
  /** Id de la sesión activa del proyecto (ver sessionService.ts) — si hay una, se usa como `sessionId` real del pack (y como `session_id` al persistirlo, ver contextService.ts). Si no se pasa, se genera un id de un solo uso, igual que antes de esta pieza (Session Memory es opcional). */
  sessionId?: string;
  /** Resumen + eventos recientes de la sesión activa (ya acotados por el llamador, ver contextService.ts) — `undefined` si no hay sesión activa. */
  sessionMemory?: SessionMemory;
  /**
   * Project Knowledge del proyecto (ver knowledgeService.ts), con el
   * contenido de cada doc ya leído — a diferencia de `relevantDecisions`,
   * NO se filtra por relevancia a la tarea: la cardinalidad es chica por
   * diseño (5 tipos canónicos + los `custom` que el usuario cree) y el
   * contenido es información de fondo (arquitectura, convenciones) útil
   * para prácticamente cualquier tarea — filtrarlo por keyword matching
   * arriesgaría dejar afuera justo lo que el usuario espera que la IA
   * siempre sepa. Vacío por defecto. Puede recortarse por Context
   * Compaction (estrategia 2, ver contextCompaction.ts) si ya se envió en
   * un pack anterior de la misma sesión — `pack.projectKnowledge` (los
   * metadatos) sigue completo siempre, solo el TEXTO puede deduplicarse.
   */
  knowledgeDocs?: { doc: ProjectKnowledgeDoc; content: string }[];
  /** ids de knowledge docs ya enviados en un Context Pack anterior de la MISMA sesión (ver contextService.ts) — Context Compaction, estrategia 2. Vacío por defecto (nada que deduplicar). */
  alreadySentKnowledgeDocIds?: Set<string>;
  /** Nivel 3 del Context Planner (04, Incremento 3) — índice de símbolos de todo el proyecto (ver symbolRepo.ts/contextService.ts). `undefined` si el proyecto no tiene símbolos indexados todavía. */
  symbolIndex?: SymbolIndexEntry[];
  /** Nivel 4 del Context Planner (04, Incremento 3) — commits recientes ya obtenidos vía GitAdapter.log() (ver contextService.ts). `undefined` si el proyecto no es git. */
  recentCommits?: GitCommit[];
  /** Diff del working tree sin commitear contra HEAD (GitAdapter.diff(), ver contextService.ts) — `undefined` si no hay cambios sin commitear o el proyecto no es git. */
  recentChanges?: GitDiff;
  maxFiles?: number;
  /** `--include <ruta>` (07, sesión 13) — ver el comentario en `PlanOptions.includePaths` de relevancePlanner.ts. Vacío por defecto (comportamiento idéntico a antes de esta pieza). */
  includePaths?: string[];
}

export interface BuildContextPackResult {
  pack: ContextPack;
  candidateCount: number; // cuántos archivos encontró el planner antes de compactar a maxFiles
  keywords: string[];
  /** Rutas de `includePaths` que se pidieron pero NO terminaron en el pack (no existen en el proyecto, o no se pudieron leer como texto — ver `safeReadTextFile`). Vacío si todas se incluyeron o no se pidió ninguna. El caller (contextService.ts/CLI) es quien avisa al usuario — acá solo se detecta. */
  missingIncludePaths: string[];
}

export function buildContextPack(params: BuildContextPackParams): BuildContextPackResult {
  const {
    project,
    taskText,
    confirmedDecisions,
    openDecisions,
    constraints,
    relevantDecisions = [],
    sessionId,
    sessionMemory,
    knowledgeDocs = [],
    alreadySentKnowledgeDocIds = new Set<string>(),
    symbolIndex,
    recentCommits,
    recentChanges,
    maxFiles = DEFAULT_MAX_FILES,
    includePaths = [],
  } = params;

  assertNonEmptyTask(taskText);

  // Las Decision Records reales se muestran igual que las confirmadas
  // escritas a mano (mismo texto plano en el Markdown/prompt final — la IA
  // no necesita distinguir el origen), pero primero en la lista porque son
  // memoria persistente, más confiable que algo tipeado al vuelo para esta
  // tarea puntual. El objeto completo (con id, tags, archivos
  // relacionados...) igual se conserva en `decisionsConsidered` para
  // auditoría.
  const allConfirmedDecisions = [
    ...relevantDecisions.map((d) => `${d.title} — ${d.decision}`),
    ...confirmedDecisions,
  ];

  const { keywords, candidates } = planRelevantFiles(project.rootPath, taskText, {
    symbolIndex,
    recentCommits,
    includePaths,
  });

  // Semilla de archivos para Context Compaction (contextCompaction.ts):
  // top-N por score, contenido COMPLETO (truncado solo por el límite de
  // tamaño de fileReading.ts) — compactContextPack decide después, según
  // el tamaño real del pack, si hace falta recortar más. Los candidatos
  // `--include` ya vienen primero en `candidates` (ver el comparador en
  // relevancePlanner.ts), así que entran acá aunque `maxFiles` sea chico.
  const rawFiles: CompactableFile[] = [];
  const includedRelPaths = new Set<string>();
  for (const candidate of candidates.slice(0, maxFiles)) {
    const content = safeReadTextFile(candidate.absPath);
    if (content === null) continue; // desapareció o es binario entre el escaneo y ahora — se omite, no se rompe el pack
    const score: RelevanceScore = {
      filePath: candidate.relPath,
      score: candidate.score,
      reasons: candidate.reasons,
    };
    // `rawContent` sin truncar viaja aparte para que Context Compaction
    // (contextCompaction.ts, estrategia 1) pueda extraer símbolos contra
    // el archivo completo, nunca contra `content` ya truncado — ver el
    // comentario en la interfaz `CompactableFile`.
    //
    // Un archivo `--include` NUNCA se trunca por tamaño (bug real
    // encontrado en sesión 13, justo probando esta misma pieza): el
    // usuario lo pidió explícitamente porque necesita generar un patch
    // SEARCH/REPLACE contra su contenido real, y `truncateForPack` corta
    // el archivo a la mitad insertando un comentario de aviso — una IA
    // puede copiar ese comentario tal cual dentro de un bloque SEARCH
    // (no distingue "este texto es un aviso de DevPilot" de "esto es
    // código real"), lo que garantiza un `reject` en `devpilot import`
    // porque ese comentario nunca existió en el archivo real. Otros
    // archivos del pack (los que entraron por score, no por --include)
    // siguen truncándose igual que antes — el límite de tamaño sigue
    // siendo necesario para no inflar el pack sin límite.
    const isExplicitInclude = candidate.reasons.some((r) => r.kind === 'explicit-include');
    rawFiles.push({
      path: candidate.relPath,
      content: isExplicitInclude ? content : truncateForPack(content),
      rawContent: content,
      score,
    });
    includedRelPaths.add(candidate.relPath);
  }

  // `--include` que pidieron una ruta pero no se pudo leer (no existe, es
  // binaria, o — caso raro — quedó fuera de `maxFiles` porque hay más
  // `--include` que cupo) — "fail explicit, nunca silencioso" (mismo
  // principio que clipboard.ts y el resto del proyecto): el caller avisa,
  // no se traga el problema.
  const missingIncludePaths = includePaths
    .map((raw) => normalizeIncludePath(project.rootPath, raw))
    .filter((relPath) => !includedRelPaths.has(relPath));

  const sessionMemoryText = sessionMemory
    ? [
        sessionMemory.taskSummary ?? '',
        ...sessionMemory.events.map((e) => `${e.kind}${e.detail ? ' ' + JSON.stringify(e.detail) : ''}`),
      ].join('\n')
    : '';

  const otherParts = [
    { label: 'tarea', text: taskText },
    { label: 'decisiones', text: [...allConfirmedDecisions, ...openDecisions, ...constraints].join('\n') },
    { label: 'instrucciones', text: RESPONSE_INSTRUCTIONS_ES },
    ...(sessionMemoryText ? [{ label: 'memoria de sesión', text: sessionMemoryText }] : []),
  ];

  // Context Compaction (04, Incremento 3, contextCompaction.ts): aplica
  // las tres estrategias documentadas SOLO si el pack se pasa de 🟢 — un
  // pack verde sale de acá sin tocar (mismos `rawFiles`/knowledge
  // completo). Reemplaza el truncado plano por top-N que había antes de
  // esta pieza (ese top-N sigue existiendo arriba, en `candidates.slice(0,
  // maxFiles)` — es la semilla, no la compactación en sí).
  const compaction = compactContextPack({
    files: rawFiles,
    knowledge: knowledgeDocs,
    alreadySentKnowledgeDocIds,
    otherParts,
    minFiles: Math.min(MIN_FILES_AFTER_COMPACTION, maxFiles),
  });

  const relevantFiles: ContextPack['relevantFiles'] = compaction.files.map((f) => ({
    path: f.path,
    content: f.content,
    score: f.score,
    ...(f.compactedToSignatures ? { compactedToSignatures: true as const } : {}),
  }));

  const pack: ContextPack = {
    id: randomUUID(),
    projectId: project.id,
    // Si hay una sesión activa (ver sessionService.ts/contextService.ts),
    // este es su id real, persistido en `sessions` — si no, un id de un
    // solo uso, igual que antes de esta pieza (Session Memory es
    // opcional, no un requisito para generar un Context Pack).
    sessionId: sessionId ?? randomUUID(),
    createdAt: new Date().toISOString(),
    task: {
      rawText: taskText,
      extractedKeywords: keywords,
    },
    projectKnowledge: knowledgeDocs.map((k) => k.doc),
    relevantFiles,
    decisionsConsidered: relevantDecisions,
    businessDecisions: {
      confirmed: allConfirmedDecisions,
      open: openDecisions,
    },
    constraints,
    responseInstructions: RESPONSE_INSTRUCTIONS_ES,
    tokenEstimate: compaction.tokenEstimate,
    ...(sessionMemory ? { sessionMemory } : {}),
    ...(compaction.knowledgeText ? { projectKnowledgeText: compaction.knowledgeText } : {}),
    ...(recentChanges && recentChanges.files.length > 0 ? { recentChanges } : {}),
    ...(compaction.compaction ? { compaction: compaction.compaction } : {}),
  };

  return { pack, candidateCount: candidates.length, keywords, missingIncludePaths };
}
