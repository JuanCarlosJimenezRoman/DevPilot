import type { ProjectKnowledgeDoc, RelevanceScore, TokenEstimate } from '@devpilot/shared';
import { extractSymbols } from '../project/symbolExtractor.js';
import { estimateTokens } from './tokenEstimate.js';

// Context Compaction (04, Incremento 3): las tres estrategias documentadas,
// en el orden que 04 las lista, aplicadas SOLO cuando el pack se pasa de
// 🟢 (mismo criterio que el doc: "para cuando el pack se pasa de
// verde/amarillo"). Un pack 🟢 sale de acá sin tocar — `compaction` queda
// `undefined`, nunca un objeto vacío, para que sea fácil de chequear desde
// el CLI/markdownRenderer.ts si hubo compactación o no.
//
// Nunca es una caja negra (04/02): cada estrategia aplicada deja una nota
// en texto plano explicando qué se compactó/excluyó y por qué — el usuario
// puede pedir el archivo completo aparte si el algoritmo se equivocó.

export interface CompactableFile {
  path: string;
  /** Contenido a usar cuando NO se compacta (ya truncado por fileReading.ts si hacía falta, ver contextPackBuilder.ts). */
  content: string;
  /**
   * Contenido COMPLETO, sin truncar — bug real encontrado en la
   * validación de esta pieza contra el propio repo de DevPilot: la
   * estrategia 1 corría `extractSymbols` contra `content` (ya truncado por
   * `truncateForPack`, que corta el archivo y pega un comentario de aviso
   * en el medio). Sobre un archivo real por encima de MAX_FILE_CONTENT_CHARS,
   * eso partía una declaración a la mitad; el parser de TypeScript se
   * recupera del error pero desalinea el resto del archivo, produciendo
   * símbolos fantasma con números de línea sin sentido (validado: un
   * `const` local, declarado DENTRO de una función, apareció listado como
   * si fuera top-level, con la línea de otra declaración real). Corregido
   * extrayendo símbolos siempre contra el contenido original.
   */
  rawContent: string;
  score: RelevanceScore;
  compactedToSignatures?: boolean;
}

export interface KnowledgeItem {
  doc: ProjectKnowledgeDoc;
  content: string;
}

export interface CompactionInput {
  /** Ya en orden de score descendente, contenido COMPLETO (truncado solo por el límite de tamaño de fileReading.ts, no por compaction todavía). */
  files: CompactableFile[];
  knowledge: KnowledgeItem[];
  /** ids de knowledge docs ya enviados en un Context Pack anterior de la MISMA sesión (ver contextService.ts) — estrategia 2. */
  alreadySentKnowledgeDocIds: Set<string>;
  /** Partes del pack que no son archivos ni knowledge (tarea, decisiones, instrucciones, memoria de sesión...) — no se tocan, solo entran al cálculo de tokens para saber si sigue en 🔴 tras cada estrategia. */
  otherParts: { label: string; text: string }[];
  /** Piso de la estrategia 3 — nunca se baja de esta cantidad de archivos aunque el pack siga en 🔴. */
  minFiles: number;
}

export interface CompactionResult {
  files: CompactableFile[];
  knowledgeText: string;
  tokenEstimate: TokenEstimate;
  compaction?: {
    strategiesApplied: ('signatures-only' | 'knowledge-dedup' | 'drop-lowest-score')[];
    notes: string[];
  };
}

// Los primeros N candidatos (ya vienen ordenados por score descendente) se
// mandan siempre completos, incluso con el pack en 🔴 — son los que con
// más probabilidad hay que editar de verdad; perder su contenido completo
// justo cuando más se necesita sería peor que un pack grande.
const HIGH_SCORE_KEEP_FULL = 3;

function renderKnowledgeText(knowledge: KnowledgeItem[]): string {
  return knowledge.map(({ doc, content }) => `## ${doc.title}\n\n${content}`).join('\n\n---\n\n');
}

function buildParts(
  files: CompactableFile[],
  knowledgeText: string,
  otherParts: { label: string; text: string }[],
): { label: string; text: string }[] {
  return [
    ...otherParts,
    ...(knowledgeText ? [{ label: 'project knowledge', text: knowledgeText }] : []),
    ...files.map((f) => ({ label: f.path, text: f.content })),
  ];
}

/**
 * Estrategia 1: en vez del contenido completo, solo la lista de símbolos
 * de nivel superior (mismo extractor que el Indexer, ver
 * symbolExtractor.ts — corrido de nuevo sobre el contenido YA LEÍDO en
 * memoria, no contra el índice en SQLite, para no arriesgar una versión
 * desactualizada). `null` si el archivo no tiene símbolos extraíbles (no
 * es TS/JS, o el parser no encontró nada) — el caller decide el fallback
 * (04, v1: "trunca o excluye", que ya pasó en fileReading.ts antes de
 * llegar acá).
 */
function renderSignaturesOnly(relPath: string, content: string): string | null {
  const symbols = extractSymbols(relPath, content);
  if (symbols.length === 0) return null;

  const lines = [...symbols]
    .sort((a, b) => a.lineStart - b.lineStart)
    .map((s) => `${s.isExported ? 'export ' : '(sin exportar) '}${s.kind} ${s.name}  // línea ${s.lineStart}`);

  return [
    '/* DevPilot — Context Compaction (04): contenido completo omitido, este pack se pasó de 🟢.',
    '   Solo se listan los símbolos de nivel superior de este archivo (ver relevancia/razones abajo).',
    '   Pedí el archivo completo aparte, o corré `devpilot context` con --max-files más bajo. */',
    '',
    ...lines,
  ].join('\n');
}

export function compactContextPack(input: CompactionInput): CompactionResult {
  const fullKnowledgeText = renderKnowledgeText(input.knowledge);
  const initialEstimate = estimateTokens(buildParts(input.files, fullKnowledgeText, input.otherParts));

  if (initialEstimate.classification === 'green') {
    return { files: input.files, knowledgeText: fullKnowledgeText, tokenEstimate: initialEstimate };
  }

  const strategiesApplied: ('signatures-only' | 'knowledge-dedup' | 'drop-lowest-score')[] = [];
  const notes: string[] = [];

  // Estrategia 1 (04, punto 1).
  let files: CompactableFile[] = input.files.map((file, idx) => {
    if (idx < HIGH_SCORE_KEEP_FULL) return file;
    // Contra `rawContent` (completo), NUNCA contra `file.content` (que
    // puede venir ya truncado por fileReading.ts) -- ver el comentario en
    // la interfaz `CompactableFile` de arriba.
    const signatures = renderSignaturesOnly(file.path, file.rawContent);
    if (signatures === null) return file;
    return { ...file, content: signatures, compactedToSignatures: true };
  });
  const compactedPaths = files.filter((f) => f.compactedToSignatures).map((f) => f.path);
  if (compactedPaths.length > 0) {
    strategiesApplied.push('signatures-only');
    notes.push(`Solo firmas (contenido completo omitido) para: ${compactedPaths.join(', ')} — pack por encima de 🟢.`);
  }

  // Estrategia 2 (04, punto 2).
  let knowledgeText = fullKnowledgeText;
  const dedupedDocs = input.knowledge.filter((k) => !input.alreadySentKnowledgeDocIds.has(k.doc.id));
  if (dedupedDocs.length < input.knowledge.length) {
    knowledgeText = renderKnowledgeText(dedupedDocs);
    const skippedTitles = input.knowledge
      .filter((k) => input.alreadySentKnowledgeDocIds.has(k.doc.id))
      .map((k) => k.doc.title);
    strategiesApplied.push('knowledge-dedup');
    notes.push(`Project Knowledge ya enviado antes en esta sesión, no repetido: ${skippedTitles.join(', ')}.`);
  }

  let estimate = estimateTokens(buildParts(files, knowledgeText, input.otherParts));

  // Estrategia 3 (04, punto 3): solo si con las dos anteriores todavía no
  // alcanzó — se van soltando los de menor score (ya vienen ordenados
  // descendente), nunca por debajo de `minFiles`.
  if (estimate.classification === 'red') {
    const dropped: string[] = [];
    while (files.length > input.minFiles && estimate.classification === 'red') {
      const last = files[files.length - 1];
      if (!last) break;
      files = files.slice(0, -1);
      dropped.push(last.path);
      estimate = estimateTokens(buildParts(files, knowledgeText, input.otherParts));
    }
    if (dropped.length > 0) {
      strategiesApplied.push('drop-lowest-score');
      notes.push(`Excluidos del pack (menor score, seguía en 🔴): ${dropped.join(', ')}.`);
    }
  }

  return {
    files,
    knowledgeText,
    tokenEstimate: estimate,
    compaction: strategiesApplied.length > 0 ? { strategiesApplied, notes } : undefined,
  };
}
