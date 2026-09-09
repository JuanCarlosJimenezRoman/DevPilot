import { existsSync } from 'node:fs';
import path from 'node:path';
import type { FileChangeProposal, ParsedResponse } from '@devpilot/shared';
import { safeReadTextFile } from './fileReading.js';
import { recoverSearchReplaceSplit } from './markerRecovery.js';

// ChangeParser — Capa 2 del contrato de tres capas (ver 06). Reconoce
// FORMA, no juzga contenido ni seguridad — eso es el ChangeValidator
// (Capa 3). Reconoce, en orden, varios formatos con tolerancia sintáctica;
// texto que no calza con ningún patrón nunca se descarta, se acumula en
// `unparsedNotes`.

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

function normalizeMarkerLine(line: string): string {
  return line.replace(/\s+/g, '');
}

// Tolerantes a prefijos de comentario (`# <<<<<<< SEARCH`, hallazgo real
// del Paso 0 con ChatGPT) y a espacios internos en las flechas
// (`> > > > > > > REPLACE`) — normalizeMarkerLine ya quitó todos los
// espacios antes de probar estas regex.
const SEARCH_MARKER_RE = /^[#/*>-]*<{3,}SEARCH$/i;
const DIVIDER_RE = /^[#/*>-]*={3,}$/;
const REPLACE_MARKER_RE = /^[#/*>-]*>{3,}REPLACE$/i;

/** Extrae el patch SEARCH/REPLACE del contenido entre `<DEVPILOT_CHANGE ...>` y `</DEVPILOT_CHANGE>`, con recuperación si falta el divisor. `null` si no hay ni siquiera un `SEARCH`/`REPLACE` reconocible (no es un patch, punto). */
function extractPatchFromBlock(
  blockContent: string,
  realFileContent: string | null,
): FileChangeProposal['patch'] | null {
  const lines = blockContent.split('\n');
  let searchLineIdx = -1;
  let dividerLineIdx = -1;
  let replaceLineIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const norm = normalizeMarkerLine(lines[i] ?? '');
    if (searchLineIdx === -1 && SEARCH_MARKER_RE.test(norm)) {
      searchLineIdx = i;
      continue;
    }
    if (searchLineIdx !== -1 && replaceLineIdx === -1 && dividerLineIdx === -1 && DIVIDER_RE.test(norm)) {
      dividerLineIdx = i;
      continue;
    }
    if (searchLineIdx !== -1 && replaceLineIdx === -1 && REPLACE_MARKER_RE.test(norm)) {
      replaceLineIdx = i;
      continue;
    }
  }

  if (searchLineIdx === -1 || replaceLineIdx === -1 || replaceLineIdx <= searchLineIdx) return null;

  if (dividerLineIdx !== -1 && dividerLineIdx > searchLineIdx && dividerLineIdx < replaceLineIdx) {
    return {
      search: lines.slice(searchLineIdx + 1, dividerLineIdx).join('\n'),
      replace: lines.slice(dividerLineIdx + 1, replaceLineIdx).join('\n'),
      markerOrigin: 'markers',
    };
  }

  // Divisor perdido — recuperación heurística (06, Hallazgo A). Sin el
  // archivo real no hay contra qué recuperar: sin recuperación, no es un
  // patch reconocible.
  if (!realFileContent) return null;
  const between = lines.slice(searchLineIdx + 1, replaceLineIdx).join('\n');
  const recovered = recoverSearchReplaceSplit(between, realFileContent);
  if (!recovered) return null;
  return { ...recovered, markerOrigin: 'recovered-prefix' };
}

const DEVPILOT_CHANGE_RE = /<DEVPILOT_CHANGE\s+([^>]*)>([\s\S]*?)<\/DEVPILOT_CHANGE>/g;

function parseAttrs(attrString: string): { path: string | null; operation: string | null } {
  const pathMatch = attrString.match(/path\s*=\s*"([^"]*)"/);
  const opMatch = attrString.match(/operation\s*=\s*"([^"]*)"/);
  return { path: pathMatch?.[1] ?? null, operation: opMatch?.[1] ?? null };
}

function extractDevpilotChangeBlocks(
  text: string,
  projectRoot: string,
): { changes: FileChangeProposal[]; remaining: string } {
  const changes: FileChangeProposal[] = [];
  const remaining = text.replace(DEVPILOT_CHANGE_RE, (full, attrString: string, blockContent: string) => {
    const { path: rawPath, operation } = parseAttrs(attrString);
    if (!rawPath || !operation) return ''; // bloque irreconocible — se descarta el fence, no rompe nada más

    const trimmedContent = blockContent.replace(/^\n+|\n+$/g, '');
    const absPath = path.resolve(projectRoot, rawPath);
    const realFileContent = existsSync(absPath) ? safeReadTextFile(absPath) : null;

    if (operation === 'patch') {
      const patch = extractPatchFromBlock(trimmedContent, realFileContent);
      changes.push({
        path: rawPath,
        operation: 'patch',
        format: 'devpilot-block',
        patch: patch ?? undefined,
      });
    } else if (operation === 'create' || operation === 'edit' || operation === 'delete') {
      changes.push({
        path: rawPath,
        operation,
        format: 'devpilot-block',
        newContent: operation === 'delete' ? undefined : trimmedContent,
      });
    } else {
      return full; // operación no reconocida — se deja como texto sin parsear
    }
    return '';
  });
  return { changes, remaining };
}

// El paréntesis final ("(no confirmadas por el contexto)") es el formato
// recomendado (06) pero no obligatorio — un modelo puede usar solo
// "## Decisiones que asumí" a secas. Ojo: `\([^)]*\)?` NO es "paréntesis
// completo opcional" (el `?` solo aplica al `)` de cierre, el `(` de
// apertura queda obligatorio) — bug real encontrado al importar una
// respuesta realista sin paréntesis contra camino-al-deporte: la sección
// completa caía en `unparsedNotes` en vez de en `assumedDecisions`. El
// grupo `(?:...)?` envuelve el paréntesis entero como una unidad opcional.
const ASSUMED_DECISIONS_RE = /##\s*Decisiones que asum[ií]\s*(?:\([^)]*\))?\s*\n([\s\S]*?)(?=\n##\s|\n```|$)/i;

function extractAssumedDecisions(text: string): { assumedDecisions: string[]; remaining: string } {
  const match = ASSUMED_DECISIONS_RE.exec(text);
  if (!match) return { assumedDecisions: [], remaining: text };

  const body = match[1] ?? '';
  const bulletRe = /^[ \t]*[-*]\s+(.+)$/gm;
  const assumedDecisions: string[] = [];
  let bulletMatch: RegExpExecArray | null;
  while ((bulletMatch = bulletRe.exec(body)) !== null) {
    const item = bulletMatch[1]?.trim();
    if (item && !/^ninguna\.?$/i.test(item)) assumedDecisions.push(item);
  }

  const remaining = text.slice(0, match.index) + text.slice(match.index + match[0].length);
  return { assumedDecisions, remaining };
}

const MARKDOWN_FILE_HEADING_RE = /^###\s+File:\s*(\S.*)$/gim;
const FENCE_RE = /```[ \t]*([a-zA-Z0-9_-]*)\n([\s\S]*?)\n?```/;
const DIFF_HALLMARK_RE = /^(@@ |--- |\+\+\+ )/m;

function extractMarkdownFileBlocks(text: string): { changes: FileChangeProposal[]; remaining: string } {
  const changes: FileChangeProposal[] = [];
  let output = '';
  let cursor = 0;

  MARKDOWN_FILE_HEADING_RE.lastIndex = 0;
  let headingMatch: RegExpExecArray | null;
  while ((headingMatch = MARKDOWN_FILE_HEADING_RE.exec(text)) !== null) {
    const headingEnd = headingMatch.index + headingMatch[0].length;
    const afterHeading = text.slice(headingEnd);
    const fenceMatch = FENCE_RE.exec(afterHeading);
    // El fence debe estar razonablemente cerca del encabezado (unas pocas
    // líneas en blanco/prosa corta) — si no, no lo tratamos como parte de
    // este encabezado; se deja tal cual (la regex global sigue buscando el
    // próximo encabezado por su cuenta, `lastIndex` ya avanzó solo).
    if (!fenceMatch || fenceMatch.index > 200) continue;

    const filePath = headingMatch[1]?.trim() ?? '';
    const fenceContent = fenceMatch[2] ?? '';
    const isDiff = DIFF_HALLMARK_RE.test(fenceContent);

    changes.push(
      isDiff
        ? { path: filePath, operation: 'edit', format: 'diff', diff: fenceContent }
        : { path: filePath, operation: 'edit', format: 'markdown-file', newContent: fenceContent },
    );

    output += text.slice(cursor, headingMatch.index);
    cursor = headingEnd + fenceMatch.index + fenceMatch[0].length;
    MARKDOWN_FILE_HEADING_RE.lastIndex = cursor;
  }
  output += text.slice(cursor);

  return { changes, remaining: output };
}

const PATH_COMMENT_RE = /^[ \t]*(?:\/\/|#|--|<!--)\s*([\w./-]+\.\w+)/;

function looksLikeProjectPath(candidate: string, projectRoot: string): boolean {
  if (!candidate || candidate.includes(' ')) return false;
  return existsSync(path.resolve(projectRoot, candidate));
}

/**
 * Último recurso (Capa 2): un fence de código genérico cuya primera línea
 * es un comentario con una ruta, o es en sí misma una ruta real del
 * proyecto. Format `fence-only`, confianza baja — el caso que expuso el
 * Hallazgo C del Paso 0 (DeepSeek presentó un fragmento de `schema.prisma`
 * así, sin marcadores; tratarlo como reemplazo de archivo completo habría
 * borrado ~1700 líneas). El `ChangeValidator.whole-file-boundary-match` es
 * lo que protege contra ese caso — el parser solo reconoce forma.
 */
function extractFenceOnlyBlocks(
  text: string,
  projectRoot: string,
): { changes: FileChangeProposal[]; remaining: string } {
  const changes: FileChangeProposal[] = [];
  const genericFenceRe = /```[ \t]*([a-zA-Z0-9_-]*)\n([\s\S]*?)\n?```/g;

  const remaining = text.replace(genericFenceRe, (full, _lang: string, content: string) => {
    const contentLines = content.split('\n');
    const firstLine = (contentLines[0] ?? '').trim();
    const commentMatch = PATH_COMMENT_RE.exec(firstLine);
    const candidatePath = commentMatch?.[1] ?? firstLine;

    if (!looksLikeProjectPath(candidatePath, projectRoot)) return full; // no se reconoce — se deja como texto suelto

    // La primera línea es solo la etiqueta de ruta (comentario `// archivo.ts`
    // o la ruta pelada), no contenido real del archivo — se descarta antes de
    // usarla como `newContent`. Si no, `whole-file-boundary-match` compara el
    // inicio real del archivo contra esta etiqueta y rechaza propuestas que sí
    // son un reemplazo completo válido (falso negativo visto contra D.txt).
    const fileContent = contentLines.slice(1).join('\n');

    changes.push({
      path: candidatePath,
      operation: 'edit',
      format: 'fence-only',
      newContent: fileContent,
    });
    return '';
  });

  return { changes, remaining };
}

/** Parsea una respuesta cruda de IA según el contrato de tres capas (06). `projectRoot` se usa solo para leer archivos reales (recuperación de marcadores, resolución de rutas en `fence-only`) — el parser no valida nada, eso es `validateChange`. */
export function parseAiResponse(raw: string, projectRoot: string): ParsedResponse {
  let remaining = normalizeNewlines(raw);
  const changes: FileChangeProposal[] = [];

  const blocks = extractDevpilotChangeBlocks(remaining, projectRoot);
  changes.push(...blocks.changes);
  remaining = blocks.remaining;

  const decisions = extractAssumedDecisions(remaining);
  remaining = decisions.remaining;

  const mdFiles = extractMarkdownFileBlocks(remaining);
  changes.push(...mdFiles.changes);
  remaining = mdFiles.remaining;

  const fenceOnly = extractFenceOnlyBlocks(remaining, projectRoot);
  changes.push(...fenceOnly.changes);
  remaining = fenceOnly.remaining;

  return {
    changes,
    assumedDecisions: decisions.assumedDecisions,
    unparsedNotes: remaining.trim(),
  };
}
