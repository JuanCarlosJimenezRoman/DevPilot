import { randomUUID } from 'node:crypto';
import type { ContextPack, Project, ProjectSnapshot, RelevanceScore, TokenEstimate } from '@devpilot/shared';
import { planRelevantFiles } from './relevancePlanner.js';
import { safeReadTextFile, truncateForPack } from './fileReading.js';
import { estimateTokens } from './tokenEstimate.js';
import { RESPONSE_INSTRUCTIONS_ES } from './responseContract.js';

// Ensambla el `ContextPack` — ver 04 "Context Pack — construcción final".
// En el Incremento 1, Project Knowledge / Session Memory / Decision
// Records todavía no existen (Incremento 2, ver 07): el pack se arma solo
// con el Project State/Snapshot resumido + archivos seleccionados + la
// tarea + Decisiones confirmadas/abiertas que el usuario escribe a mano.
export const DEFAULT_MAX_FILES = 8;

export interface BuildContextPackParams {
  project: Project;
  snapshot: ProjectSnapshot;
  taskText: string;
  confirmedDecisions: string[];
  openDecisions: string[];
  constraints: string[];
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
    maxFiles = DEFAULT_MAX_FILES,
  } = params;

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

  const tokenParts = [
    { label: 'tarea', text: taskText },
    { label: 'decisiones', text: [...confirmedDecisions, ...openDecisions, ...constraints].join('\n') },
    { label: 'instrucciones', text: RESPONSE_INSTRUCTIONS_ES },
    ...relevantFiles.map((f) => ({ label: f.path, text: f.content })),
  ];
  const tokenEstimate: TokenEstimate = estimateTokens(tokenParts);

  const pack: ContextPack = {
    id: randomUUID(),
    projectId: project.id,
    // Session Memory real es Incremento 2 (ver 07) — este id identifica
    // solo esta invocación de `devpilot context`, no una fila persistida
    // en `sessions` todavía.
    sessionId: randomUUID(),
    createdAt: new Date().toISOString(),
    task: {
      rawText: taskText,
      extractedKeywords: keywords,
    },
    projectKnowledge: [], // Incremento 2
    relevantFiles,
    decisionsConsidered: [], // Decision Records reales, Incremento 2 — hoy son las listas de abajo, escritas a mano
    businessDecisions: {
      confirmed: confirmedDecisions,
      open: openDecisions,
    },
    constraints,
    responseInstructions: RESPONSE_INSTRUCTIONS_ES,
    tokenEstimate,
  };

  return { pack, candidateCount: candidates.length, keywords };
}
