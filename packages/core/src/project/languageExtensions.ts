// Mapa extensión → lenguaje para el Scanner (ver 04). Deliberadamente
// centrado en TypeScript/JavaScript (único alcance real de v1, ver 01),
// con algunas extensiones comunes adicionales para que el conteo de
// lenguajes del snapshot no sea engañoso en proyectos mixtos reales.
export const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.json': 'json',
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.css': 'css',
  '.scss': 'css',
  '.html': 'html',
  '.prisma': 'prisma',
  '.sql': 'sql',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.yml': 'yaml',
  '.yaml': 'yaml',
};

export function detectLanguage(filePath: string): string | null {
  const dot = filePath.lastIndexOf('.');
  if (dot === -1) return null;
  const ext = filePath.slice(dot).toLowerCase();
  return LANGUAGE_BY_EXTENSION[ext] ?? null;
}
