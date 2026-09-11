import path from 'node:path';
import type { GitCommit, RelevanceReason } from '@devpilot/shared';
import { listProjectFiles } from '../project/fileWalker.js';
import { extractKeywords } from './keywords.js';
import { resolveLocalImports } from './importGraph.js';
import { safeReadTextFile } from './fileReading.js';

// Context Planner — Niveles 1-4, ver 04. **Simple y medible, no
// "superinteligente"**: cada score es una suma de contribuciones
// explicables (`RelevanceReason[]`), nunca una caja negra. Los pesos son
// deliberadamente literales aquí (no en `.devpilot/config.json` todavía —
// ese archivo no existe hasta que algún incremento lo necesite de verdad,
// ver 04 "Relevance Scoring").
//
// Nivel 3 (símbolos) y Nivel 4 (Git) — Incremento 3, ver 07 — son
// opcionales vía `PlanOptions`: si el caller no pasa `symbolIndex`/
// `recentCommits` (ej. el proyecto todavía no corrió `devpilot project
// add`, o no es un repo git), Nivel 1/2 siguen funcionando exactamente
// igual que antes de esta pieza. Ninguno de los dos vuelve a analizar el
// proyecto entero: Nivel 3 puede sumar un candidato nuevo si un archivo
// EXPORTA un símbolo que coincide mientras Nivel 1 no lo detectó como
// texto (caso raro, ver más abajo), pero Nivel 4 solo REFINA candidatos
// que Nivel 1/2/3 ya encontraron (04: "cada nivel solo refina el conjunto
// de candidatos del nivel anterior") — que un archivo se haya tocado hace
// poco no es, por sí solo, evidencia de que tenga que ver con la tarea.
const WEIGHTS = {
  textMatchMax: 55,
  pathNameMatch: 15,
  importHop1: 30,
  importHop2: 15,
  // Nivel 3: un archivo que EXPORTA un símbolo con el nombre exacto de un
  // keyword tipo-identificador es evidencia más fuerte que una simple
  // mención de texto (que ya suma hasta IDENTIFIER_MATCH_WEIGHT * 3 más
  // abajo) — declarar y exportar algo llamado `TamanoPaquete` es lo más
  // parecido a "este archivo es DONDE VIVE ese concepto". Un símbolo
  // declarado pero NO exportado sigue siendo más fuerte que una mención de
  // texto suelta (es una definición real, no una palabra de paso), pero
  // menos que uno exportado (no es visible desde otros archivos).
  symbolExported: 38,
  symbolInternal: 20,
  // Nivel 4: decae con la antigüedad del commit (ver GIT_RECENCY_WINDOW_DAYS)
  // y es independiente de la afinidad de mensaje — un archivo puede sumar
  // ambas si el mismo commit reciente además menciona un keyword.
  gitRecencyMax: 18,
  gitMessageAffinity: 14,
};

// Ventana de recencia (Nivel 4): un commit de hoy suma `gitRecencyMax`
// completo; a partir de este número de días el boost decae a 0. Literal
// aquí por el mismo motivo que el resto de WEIGHTS — no hay
// `.devpilot/config.json` todavía.
const GIT_RECENCY_WINDOW_DAYS = 14;

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

/** Entrada mínima que necesita Nivel 3 — ver `listAllSymbolsWithFilePath` en symbolRepo.ts (el caller aplana `SymbolWithFilePath` a esto). */
export interface SymbolIndexEntry {
  relPath: string;
  name: string;
  isExported: boolean;
}

export interface PlanOptions {
  /** Nivel 3 (04, Incremento 3). `undefined`/vacío → Nivel 3 no aporta nada, Nivel 1/2 sin cambios. */
  symbolIndex?: SymbolIndexEntry[];
  /** Nivel 4 (04, Incremento 3): ya obtenidos por el caller vía `GitAdapter.log()` (ver contextService.ts). `undefined`/vacío → Nivel 4 no aporta nada. */
  recentCommits?: GitCommit[];
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

/** Corre el Context Planner (Nivel 1-4, según qué venga en `options`) sobre `rootPath` para la tarea `taskText`. Devuelve candidatos ordenados por score, cada uno con sus razones — nunca "confía y ya", siempre explicable (ver 04). */
export function planRelevantFiles(rootPath: string, taskText: string, options: PlanOptions = {}): PlanResult {
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

  // Nivel 3 — símbolos/AST (Incremento 3): ¿algún archivo EXPORTA (o al
  // menos declara) un símbolo cuyo nombre coincide EXACTO con un keyword
  // tipo-identificador de la tarea? Solo se prueban los keywords
  // "tipo-identificador" (mismo filtro que ya usa `scoreKeywordMatches`
  // para Nivel 1) — probar palabras sueltas del lenguaje natural contra
  // nombres de símbolos no tiene sentido (nadie declara una función
  // llamada "tienda"). Puede sumar un candidato que Nivel 1 no encontró
  // como texto (ver el comentario grande al principio del archivo) —en la
  // práctica casi siempre refuerza uno que Nivel 1 ya encontró, porque la
  // propia declaración del símbolo (`export const TamanoPaquete = ...`)
  // ya es una coincidencia de texto.
  if (options.symbolIndex && options.symbolIndex.length > 0) {
    const identifierKeywords = keywords.filter((k) => isIdentifierLike(k));
    if (identifierKeywords.length > 0) {
      const keywordSet = new Set(identifierKeywords);
      for (const symbol of options.symbolIndex) {
        if (!keywordSet.has(symbol.name)) continue;
        addContribution(scores, symbol.relPath, {
          kind: 'symbol-match',
          weight: symbol.isExported ? WEIGHTS.symbolExported : WEIGHTS.symbolInternal,
          detail: symbol.isExported
            ? `exporta el símbolo \`${symbol.name}\``
            : `declara (sin exportar) el símbolo \`${symbol.name}\``,
        });
      }
    }
  }

  // Nivel 4 — Git (Incremento 3): boost a candidatos YA encontrados por
  // Nivel 1/2/3 que además fueron tocados en commits recientes, con boost
  // extra si el mensaje del commit menciona algún keyword de la tarea
  // (afinidad). Nunca introduce un archivo que ningún nivel anterior haya
  // encontrado — ver el comentario grande al principio del archivo.
  if (options.recentCommits && options.recentCommits.length > 0) {
    const now = Date.now();
    for (const commit of options.recentCommits) {
      const commitTime = Date.parse(commit.date);
      const daysAgo = Number.isNaN(commitTime) ? null : Math.max(0, (now - commitTime) / (1000 * 60 * 60 * 24));
      const recencyWeight =
        daysAgo === null ? 0 : Math.round(WEIGHTS.gitRecencyMax * Math.max(0, 1 - daysAgo / GIT_RECENCY_WINDOW_DAYS));

      const matchedInMessage = keywords.filter((k) => new RegExp(`\\b${escapeRegExp(k)}\\b`, 'i').test(commit.message));

      if (recencyWeight <= 0 && matchedInMessage.length === 0) continue;

      const shortHash = commit.hash.slice(0, 7);
      for (const relPath of commit.filesChanged) {
        if (!scores.has(relPath)) continue; // Nivel 4 solo refina, nunca introduce candidatos nuevos

        if (recencyWeight > 0) {
          addContribution(scores, relPath, {
            kind: 'git-recency',
            weight: recencyWeight,
            detail: `tocado hace ${Math.round(daysAgo ?? 0)} día(s) en el commit ${shortHash} ("${commit.message.slice(0, 60)}")`,
          });
        }
        if (matchedInMessage.length > 0) {
          addContribution(scores, relPath, {
            kind: 'git-recency',
            weight: WEIGHTS.gitMessageAffinity,
            detail: `el mensaje del commit ${shortHash} menciona: ${matchedInMessage.join(', ')}`,
          });
        }
      }
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
