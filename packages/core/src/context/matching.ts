// Comparación de contenido tolerante a indentación — ver 06, Hallazgo B:
// "la indentación no sobrevivió el trayecto" (columnas alineadas de Prisma,
// indentación de 4 espacios colapsada a 1 o nula). `search-match` "ya no
// exige coincidencia byte-a-byte" pero "sigue siendo estricto sobre el
// contenido real de cada línea, que es lo que importa para no aplicar algo
// sobre un archivo que ya cambió". Se usa tanto por la recuperación de
// marcadores (parser) como por el check `search-match` (validador) — misma
// noción de "coincide", un solo lugar que la implementa.

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/** Construye el patrón de regex compartido por `dedentTolerantIncludes` y `findDedentTolerantMatch`: cada línea del candidato, comparada por su contenido recortado (trim), con indentación de cabecera libre en el archivo real. `null` si el candidato es puro espacio en blanco (nunca "coincide" — evita falsos positivos triviales). */
function buildDedentTolerantPattern(candidate: string): string | null {
  const candidateLines = normalizeNewlines(candidate).split('\n');
  if (candidateLines.every((l) => l.trim() === '')) return null;
  return candidateLines.map((line) => `[ \\t]*${escapeRegExp(line.trim())}`).join('\\n');
}

/**
 * ¿`candidate` aparece, línea por línea, dentro de `fileContent`? Cada
 * línea del candidato se compara por su contenido recortado (trim), con
 * indentación de cabecera libre en el archivo real — más permisivo que un
 * dedent estricto, pero sigue exigiendo el mismo contenido en el mismo
 * orden, que es la garantía real que importa (no aplicar sobre algo que ya
 * cambió). Bloques en blanco o vacíos nunca "coinciden" — evita falsos
 * positivos triviales.
 */
export function dedentTolerantIncludes(candidate: string, fileContent: string): boolean {
  const pattern = buildDedentTolerantPattern(candidate);
  if (pattern === null) return false;
  try {
    const re = new RegExp(pattern);
    return re.test(normalizeNewlines(fileContent));
  } catch {
    return false;
  }
}

export interface DedentTolerantMatch {
  /** Offset de inicio/fin (exclusivo) del match, en `fileContent` ya normalizado a `\n` (ver `normalizeNewlines` — quien construya el reemplazo debe normalizar `fileContent` con el mismo criterio antes de usar estos offsets). */
  start: number;
  end: number;
}

/**
 * Igual que `dedentTolerantIncludes`, pero devuelve dónde coincidió en vez
 * de solo si coincidió — lo que necesita `devpilot diff`/`devpilot apply`
 * (ver `diffService.ts`) para reconstruir el archivo completo reemplazando
 * exactamente esa región por el bloque `REPLACE`, en vez de solo confirmar
 * que el `SEARCH` era válido (que es todo lo que necesitaba el
 * `ChangeValidator`). Misma noción de "coincide" que `search-match` — un
 * solo patrón compartido entre ambas funciones, para no arriesgar que
 * diverjan silenciosamente.
 */
export function findDedentTolerantMatch(candidate: string, fileContent: string): DedentTolerantMatch | null {
  const pattern = buildDedentTolerantPattern(candidate);
  if (pattern === null) return null;
  try {
    const re = new RegExp(pattern);
    const match = re.exec(normalizeNewlines(fileContent));
    if (!match) return null;
    return { start: match.index, end: match.index + match[0].length };
  } catch {
    return null;
  }
}
