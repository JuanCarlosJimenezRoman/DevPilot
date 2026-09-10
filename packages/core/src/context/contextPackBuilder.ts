import { randomUUID } from 'node:crypto';
import type { ContextPack, DecisionRecord, Project, ProjectKnowledgeDoc, ProjectSnapshot, RelevanceScore, SessionMemory, TokenEstimate } from '@devpilot/shared';
import { planRelevantFiles } from './relevancePlanner.js';
import { safeReadTextFile, truncateForPack } from './fileReading.js';
import { estimateTokens } from './tokenEstimate.js';
import { RESPONSE_INSTRUCTIONS_ES } from './responseContract.js';

// Ensambla el `ContextPack` — ver 04 "Context Pack — construcción final".
// Desde el Incremento 2 (07): las Decision Records reales (`devpilot
// decide`) se buscan por relevancia a la tarea (ver decisionService.ts,
// `findRelevantDecisions`) y se suman a las confirmadas escritas a mano; la
// Session Memory de la sesión activa (si hay una, ver sessionService.ts) se
// incluye como ingrediente aparte; y Project Knowledge (ver
// knowledgeService.ts) se incluye siempre completo, sin filtrar por
// relevancia (ver el comentario en `knowledgeDocs` más abajo).
export const DEFAULT_MAX_FILES = 8;

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
   * siempre sepa. Vacío por defecto.
   */
  knowledgeDocs?: { doc: ProjectKnowledgeDoc; content: string }[];
  maxFiles?: number;
}

export interface BuildContextPackResult {
  pack: ContextPack;
  candidateCount: number; // cuántos archivos encontró el planner antes de compactar a maxFiles
  keywords: string[];
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
    maxFiles = DEFAULT_MAX_FILES,
  } = params;

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

  const { keywords, candidates } = planRelevantFiles(project.rootPath, taskText);

  // Context Compaction (ver 04, punto 3): cortar por umbral de relevancia
  // (top-N) en vez de incluir todo lo que superó el Nivel 2. v1 no trunca
  // por símbolos (Incremento 2) — trunca el contenido de cada archivo
  // grande individualmente (ver fileReading.ts).
  const selected = candidates.slice(0, maxFiles);

  const relevantFiles: ContextPack['relevantFiles'] = [];
  for (const candidate of selected) {
    const content = safeReadTextFile(candidate.absPath);
    if (content === null) continue; // desapareció o es binario entre el escaneo y ahora — se omite, no se rompe el pack
    const score: RelevanceScore = {
      filePath: candidate.relPath,
      score: candidate.score,
      reasons: candidate.reasons,
    };
    relevantFiles.push({ path: candidate.relPath, content: truncateForPack(content), score });
  }

  const sessionMemoryText = sessionMemory
    ? [
        sessionMemory.taskSummary ?? '',
        ...sessionMemory.events.map((e) => `${e.kind}${e.detail ? ' ' + JSON.stringify(e.detail) : ''}`),
      ].join('\n')
    : '';

  // Mismo patrón que `businessDecisions.confirmed` respecto de
  // `decisionsConsidered`: `knowledgeDocs` (con contenido) se aplana a
  // texto para el prompt/tokenParts; el pack solo guarda la metadata
  // (`ProjectKnowledgeDoc[]`, sin contenido — ver 02/03, el archivo real
  // sigue siendo la fuente de verdad).
  const projectKnowledgeText = knowledgeDocs
    .map(({ doc, content }) => `## ${doc.title}\n\n${content}`)
    .join('\n\n---\n\n');

  const tokenParts = [
    { label: 'tarea', text: taskText },
    { label: 'decisiones', text: [...allConfirmedDecisions, ...openDecisions, ...constraints].join('\n') },
    { label: 'instrucciones', text: RESPONSE_INSTRUCTIONS_ES },
    ...(projectKnowledgeText ? [{ label: 'project knowledge', text: projectKnowledgeText }] : []),
    ...(sessionMemoryText ? [{ label: 'memoria de sesión', text: sessionMemoryText }] : []),
    ...relevantFiles.map((f) => ({ label: f.path, text: f.content })),
  ];
  const tokenEstimate: TokenEstimate = estimateTokens(tokenParts);

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
    tokenEstimate,
    ...(sessionMemory ? { sessionMemory } : {}),
    ...(projectKnowledgeText ? { projectKnowledgeText } : {}),
  };

  return { pack, candidateCount: candidates.length, keywords };
}
