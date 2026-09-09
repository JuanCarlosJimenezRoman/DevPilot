import path from 'node:path';
import type { RelevanceReason } from '@devpilot/shared';
import { listProjectFiles } from '../project/fileWalker.js';
import { extractKeywords } from './keywords.js';
import { resolveLocalImports } from './importGraph.js';
import { safeReadTextFile } from './fileReading.js';

// Context Planner — Nivel 1 (texto) + Nivel 2 (imports), ver 04. **Simple y
// medible, no "superinteligente"**: cada score es una suma de
// contribuciones explicables (`RelevanceReason[]`), nunca una caja negra.
// Los pesos son deliberadamente literales aquí (no en `.devpilot/config.json`
// todavía — ese archivo no existe hasta que algún incremento lo necesite de
// verdad, ver 04 "Relevance Scoring"). Nivel 3 (símbolos/AST) y Nivel 4
// (Git) quedan con peso 0 — Incremento 2/3.
const WEIGHTS = {
  textMatchMax: 55,
  pathNameMatch: 15,
  importHop1: 30,
  importHop2: 15,
};

// Cuántos de los mejores candidatos de Nivel 1 se usan como semilla para
// expandir el grafo de imports — acota el costo de Nivel 2 en proyectos
// grandes sin perder los casos que importan.
const MAX_SEED_FILES = 8;

export interface RelevanceCandidate {
  relPath: string;
  absPath: string;
  score: number;
  reasons: RelevanceReason[];
}

export interface PlanResult {
  keywords: string[];
  candidates: RelevanceCandidate[]; // orden descendente por score
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isIdentifierLike(keyword: string): boolean {
  return /_/.test(keyword) || /[a-z][A-Z]/.test(keyword) || (keyword.length >= 3 && keyword === keyword.toUpperCase());
}

// Un identificador de código (`TAMANO_CHECKOUT_DEFAULT`, `TamanoPaquete`)
// que aparece en un archivo es evidencia mucho más fuerte que una palabra
// genérica del dominio (ej. "tienda", "checkout", "cotización") que
// probablemente aparece repetida en decenas de archivos de un módulo
// entero. Sin distinguirlos, un directorio completo (ej. `routes/tienda/`)
// satura el score con la misma fuerza que el archivo que de verdad
// contiene el término específico que la tarea pide modificar — validado
// con un caso real sobre Camino al Deporte (ver commit).
const IDENTIFIER_MATCH_WEIGHT = 12;
const WORD_MATCH_WEIGHT = 3;
const MAX_COUNTED_OCCURRENCES = 3; // rendimientos decrecientes tras las primeras coincidencias

function scoreKeywordMatches(content: string, keywords: string[]): { rawScore: number; matched: string[] } {
  let rawScore = 0;
  const matched: string[] = [];
  for (const keyword of keywords) {
    const identifierLike = isIdentifierLike(keyword);
    const flags = identifierLike ? 'g' : 'gi';
    const re = new RegExp(`\\b${escapeRegExp(keyword)}\\b`, flags);
    const occurrences = content.match(re);
    if (occurrences && occurrences.length > 0) {
      const perOccurrenceWeight = identifierLike ? IDENTIFIER_MATCH_WEIGHT : WORD_MATCH_WEIGHT;
      rawScore += Math.min(occurrences.length, MAX_COUNTED_OCCURRENCES) * perOccurrenceWeight;
      matched.push(keyword);
    }
  }
  return { rawScore, matched };
}

interface ScoreEntry {
  reasons: RelevanceReason[];
  // Mejor contribución vista por categoría (kind) — no la suma de todas.
  // Sin este tope, un archivo "hub" (ej. db.js, importado por decenas de
  // rutas) recibe una contribución de `import-distance` por CADA semilla
  // de Nivel 1 que lo importa y termina acumulando más puntaje que el
  // archivo realmente relevante, solo por ser un import común — no porque
  // tenga que ver con la tarea. Validado con un caso real (ver commit):
  // sobre Camino al Deporte, sin este tope, `db.js`/`asyncHandler.js`/
  // `authCliente.js` desplazaban a `envios.js` (el archivo que la tarea
  // pide modificar) fuera del top-N.
  bestByKind: Partial<Record<RelevanceReason['kind'], number>>;
}

function addContribution(scores: Map<string, ScoreEntry>, relPath: string, reason: RelevanceReason): void {
  let entry = scores.get(relPath);
  if (!entry) {
    entry = { reasons: [], bestByKind: {} };
    scores.set(relPath, entry);
  }
  entry.reasons.push(reason);
  const currentBest = entry.bestByKind[reason.kind] ?? 0;
  if (reason.weight > currentBest) entry.bestByKind[reason.kind] = reason.weight;
}

function finalScore(entry: ScoreEntry): number {
  const total = Object.values(entry.bestByKind).reduce((sum: number, w) => sum + (w ?? 0), 0);
  return Math.min(100, total);
}

/** Corre el Context Planner (Nivel 1 + 2) sobre `rootPath` para la tarea `taskText`. Devuelve candidatos ordenados por score, cada uno con sus razones — nunca "confía y ya", siempre explicable (ver 04). */
export function planRelevantFiles(rootPath: string, taskText: string): PlanResult {
  const keywords = extractKeywords(taskText);
  if (keywords.length === 0) {
    return { keywords, candidates: [] };
  }

  const files = listProjectFiles(rootPath);
  const scores = new Map<string, ScoreEntry>();

  // Nivel 1 — coincidencia de texto + nombre de ruta
  for (const file of files) {
    const content = safeReadTextFile(file.absPath);
    const pathLower = file.relPath.toLowerCase();
    const pathMatches = keywords.filter((k) => pathLower.includes(k.toLowerCase()));

    let textMatch: { rawScore: number; matched: string[] } | null = null;
    if (content !== null) {
      textMatch = scoreKeywordMatches(content, keywords);
    }

    if ((!textMatch || textMatch.rawScore === 0) && pathMatches.length === 0) continue;

    if (textMatch && textMatch.rawScore > 0) {
      const weight = Math.min(WEIGHTS.textMatchMax, textMatch.rawScore);
      addContribution(scores, file.relPath, {
        kind: 'text-match',
        weight,
        detail: `coincidencias de: ${textMatch.matched.join(', ')}`,
      });
    }
    if (pathMatches.length > 0) {
      addContribution(scores, file.relPath, {
        kind: 'path-name',
        weight: WEIGHTS.pathNameMatch,
        detail: `la ruta contiene: ${pathMatches.join(', ')}`,
      });
    }
  }

  // Nivel 2 — imports directos (1 salto) desde los mejores candidatos de Nivel 1
  const level1Best = [...scores.entries()]
    .sort((a, b) => finalScore(b[1]) - finalScore(a[1]))
    .slice(0, MAX_SEED_FILES)
    .map(([relPath]) => relPath);

  const hop1RelPaths = new Set<string>();
  for (const relPath of level1Best) {
    const absPath = path.join(rootPath, relPath);
    const content = safeReadTextFile(absPath);
    if (content === null) continue;
    for (const importedAbs of resolveLocalImports(absPath, content, rootPath)) {
      const importedRel = path.relative(rootPath, importedAbs).split(path.sep).join('/');
      if (importedRel === relPath) continue;
      hop1RelPaths.add(importedRel);
      addContribution(scores, importedRel, {
        kind: 'import-distance',
        weight: WEIGHTS.importHop1,
        detail: `import directo desde ${relPath}`,
      });
    }
  }

  // Nivel 2 — 2do salto, con peso menor
  const hop2Seeds = [...hop1RelPaths].slice(0, MAX_SEED_FILES);
  for (const relPath of hop2Seeds) {
    const absPath = path.join(rootPath, relPath);
    const content = safeReadTextFile(absPath);
    if (content === null) continue;
    for (const importedAbs of resolveLocalImports(absPath, content, rootPath)) {
      const importedRel = path.relative(rootPath, importedAbs).split(path.sep).join('/');
      if (importedRel === relPath || scores.has(importedRel)) continue; // ya tiene una señal mejor
      addContribution(scores, importedRel, {
        kind: 'import-distance',
        weight: WEIGHTS.importHop2,
        detail: `import indirecto (2 saltos) desde ${relPath}`,
      });
    }
  }

  const candidates: RelevanceCandidate[] = [...scores.entries()]
    .map(([relPath, entry]) => ({
      relPath,
      absPath: path.join(rootPath, relPath),
      score: finalScore(entry),
      reasons: entry.reasons,
    }))
    .sort((a, b) => b.score - a.score);

  return { keywords, candidates };
}
