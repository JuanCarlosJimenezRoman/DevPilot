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
  const candidateLines = normalizeNewlines(candidate).split('\n');
  if (candidateLines.every((l) => l.trim() === '')) return false;

  const pattern = candidateLines.map((line) => `[ \\t]*${escapeRegExp(line.trim())}`).join('\\n');
  try {
    const re = new RegExp(pattern);
    return re.test(normalizeNewlines(fileContent));
  } catch {
    return false;
  }
}
