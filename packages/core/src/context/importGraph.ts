import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

// Grafo de imports — Context Planner Nivel 2 (ver 04). "Lexer ligero, no
// AST completo": una regex razonable para import/require/export-from/
// import() dinámico. Suficiente para expandir 1-2 saltos desde los
// archivos del Nivel 1; la extracción real de símbolos vía AST es
// Incremento 2.
const IMPORT_SPECIFIER_RE =
  /(?:\bfrom\s+|\brequire\(\s*|\bimport\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;

const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

// TypeScript + NodeNext (el estilo que usa este propio monorepo, ver 02)
// escribe imports con extensión `.js` en el specifier aunque el archivo
// real en disco sea `.ts` — el compilador reescribe la extensión, el
// código fuente no. Sin este mapeo, `import './scanner.js'` nunca
// resuelve a `scanner.ts` y el grafo de imports se queda corto.
const JS_TO_TS_EXT: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

function tryResolveFile(candidate: string): string | null {
  if (existsSync(candidate)) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      return null;
    }
  }

  const specifierExt = path.extname(candidate);
  const tsCandidates = JS_TO_TS_EXT[specifierExt];
  if (tsCandidates) {
    const base = candidate.slice(0, -specifierExt.length);
    for (const tsExt of tsCandidates) {
      const swapped = base + tsExt;
      if (existsSync(swapped)) return swapped;
    }
  }

  for (const ext of RESOLVE_EXTENSIONS) {
    const withExt = candidate + ext;
    if (existsSync(withExt)) return withExt;
  }
  for (const ext of RESOLVE_EXTENSIONS) {
    const indexFile = path.join(candidate, `index${ext}`);
    if (existsSync(indexFile)) return indexFile;
  }
  return null;
}

/**
 * Extrae los especificadores de import/require relativos (`./...`,
 * `../...`) de `content` y los resuelve a rutas absolutas reales dentro
 * de `rootPath`. Ignora paquetes de npm (especificadores sin punto inicial)
 * — no son "archivos del proyecto" que el Context Planner deba incluir.
 */
export function resolveLocalImports(fileAbsPath: string, content: string, rootPath: string): string[] {
  const resolved = new Set<string>();
  const dir = path.dirname(fileAbsPath);

  let match: RegExpExecArray | null;
  IMPORT_SPECIFIER_RE.lastIndex = 0;
  while ((match = IMPORT_SPECIFIER_RE.exec(content)) !== null) {
    const specifier = match[1];
    if (!specifier || !specifier.startsWith('.')) continue; // solo imports locales

    const candidate = path.resolve(dir, specifier);
    // no salir del proyecto (ej. imports relativos hacia arriba del root)
    if (!candidate.startsWith(path.resolve(rootPath))) continue;

    const resolvedFile = tryResolveFile(candidate);
    if (resolvedFile) resolved.add(resolvedFile);
  }

  return [...resolved];
}
