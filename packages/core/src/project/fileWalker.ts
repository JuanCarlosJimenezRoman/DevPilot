import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { detectLanguage } from './languageExtensions.js';

// El paquete `ignore` es CommonJS puro (sin campo "exports"/"types" en su
// package.json) y su default export no interopera de forma confiable con
// `import ignore from 'ignore'` bajo module/moduleResolution NodeNext en
// este monorepo (TS resuelve el símbolo como el namespace del módulo, no
// como la función). Se importa vía `createRequire` para evitar el
// problema — funciona igual en runtime ESM de Node.
const require = createRequire(import.meta.url);

interface IgnoreInstance {
  add(patterns: string | string[]): IgnoreInstance;
  ignores(pathname: string): boolean;
}
const ignoreFactory = require('ignore') as () => IgnoreInstance;

// Recorrido de árbol de archivos (Scanner y Context Planner, ver 04):
// respeta `.gitignore` y un `.devpilotignore` adicional del proyecto, más
// una lista de ignorados por defecto que no depende de que el usuario
// tenga un `.gitignore` bien configurado (ej. proyectos sin `node_modules`
// en su `.gitignore` porque nunca lo necesitaron hasta ahora).
const DEFAULT_IGNORES = [
  '.git',
  '.devpilot',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.pnpm-store',
];

export interface WalkResult {
  fileCount: number;
  languageCounts: Record<string, number>;
}

export interface ProjectFileEntry {
  relPath: string; // separadores '/' siempre, sin importar la plataforma
  absPath: string;
  sizeBytes: number;
}

function loadIgnoreFile(rootPath: string, fileName: string): string[] {
  try {
    const raw = readFileSync(path.join(rootPath, fileName), 'utf8');
    return raw.split('\n');
  } catch {
    return [];
  }
}

function buildIgnore(rootPath: string): IgnoreInstance {
  const ig = ignoreFactory();
  ig.add(DEFAULT_IGNORES);
  ig.add(loadIgnoreFile(rootPath, '.gitignore'));
  ig.add(loadIgnoreFile(rootPath, '.devpilotignore'));
  return ig;
}

/**
 * Expuesto para el Indexer (indexer.ts): el reindexado incremental no
 * recorre el árbol (por eso es incremental), pero cada ruta que
 * `git diff --name-status` reporta como cambiada igual debe pasar por las
 * mismas reglas de ignorados que un recorrido completo -- si no, una ruta
 * ignorada (ej. `.devpilot/` sin `.gitignore` que la excluya, o cualquier
 * cosa bajo `node_modules/` si alguna vez terminó comiteada por error)
 * que git sí ve como "cambiada" entraría al índice igual, dando un
 * resultado distinto entre reindexado completo e incremental para el
 * mismo estado del repo -- encontrado probando este mismo archivo (ver
 * 07-roadmap.md).
 */
export function createIgnoreMatcher(rootPath: string): (relPath: string, isDirectory?: boolean) => boolean {
  const ig = buildIgnore(rootPath);
  return (relPath: string, isDirectory = false) => {
    const posixRelPath = relPath.split(path.sep).join('/');
    const checkPath = isDirectory ? `${posixRelPath}/` : posixRelPath;
    return ig.ignores(checkPath);
  };
}

/**
 * Recorrido síncrono compartido: invoca `onFile` para cada archivo no
 * ignorado. Los proyectos objetivo de v1 son de tamaño normal, no
 * monorepos gigantes (ver 04) — recorrido síncrono recursivo es
 * suficiente.
 */
function walkTree(rootPath: string, onFile: (relPath: string, absPath: string) => void): void {
  const ig = buildIgnore(rootPath);

  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const absPath = path.join(dir, entry);
      const relPath = path.relative(rootPath, absPath);
      const posixRelPath = relPath.split(path.sep).join('/');

      let stat;
      try {
        stat = statSync(absPath);
      } catch {
        continue;
      }

      const checkPath = stat.isDirectory() ? `${posixRelPath}/` : posixRelPath;
      if (ig.ignores(checkPath)) continue;

      if (stat.isDirectory()) {
        walk(absPath);
      } else if (stat.isFile()) {
        onFile(posixRelPath, absPath);
      }
    }
  };

  walk(rootPath);
}

/**
 * Usado por el Scanner: cuenta archivos y lenguajes sin devolver la lista
 * completa de rutas (el índice detallado en SQLite es responsabilidad del
 * Indexer, no del Scanner — ver 04).
 */
export function walkProjectFiles(rootPath: string): WalkResult {
  let fileCount = 0;
  const languageCounts: Record<string, number> = {};

  walkTree(rootPath, (relPath) => {
    fileCount += 1;
    const language = detectLanguage(relPath);
    if (language) {
      languageCounts[language] = (languageCounts[language] ?? 0) + 1;
    }
  });

  return { fileCount, languageCounts };
}

/**
 * Usado por el Context Planner (Nivel 1 — ver 04): lista de candidatos
 * sobre la que correr la búsqueda textual. Devuelve rutas, no contenido —
 * el llamador decide qué leer y cómo (tamaño máximo, detección de
 * binarios, etc.).
 */
export function listProjectFiles(rootPath: string): ProjectFileEntry[] {
  const files: ProjectFileEntry[] = [];
  walkTree(rootPath, (relPath, absPath) => {
    let sizeBytes = 0;
    try {
      sizeBytes = statSync(absPath).size;
    } catch {
      return;
    }
    files.push({ relPath, absPath, sizeBytes });
  });
  return files;
}
