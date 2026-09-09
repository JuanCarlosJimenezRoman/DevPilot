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

// Recorrido de árbol de archivos del Scanner (ver 04): respeta `.gitignore`
// y un `.devpilotignore` adicional del proyecto, más una lista de
// ignorados por defecto que no depende de que el usuario tenga un
// `.gitignore` bien configurado (ej. proyectos sin `node_modules` en su
// `.gitignore` porque nunca lo necesitaron hasta ahora).
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

function loadIgnoreFile(rootPath: string, fileName: string): string[] {
  try {
    const raw = readFileSync(path.join(rootPath, fileName), 'utf8');
    return raw.split('\n');
  } catch {
    return [];
  }
}

/**
 * Recorre `rootPath` de forma síncrona (los proyectos objetivo de v1 son de
 * tamaño normal, no monorepos gigantes — ver 04) contando archivos y
 * lenguajes. No devuelve la lista completa de rutas: el índice detallado
 * (tabla `files`) es responsabilidad del Indexer, no del Scanner.
 */
export function walkProjectFiles(rootPath: string): WalkResult {
  const ig = ignoreFactory();
  ig.add(DEFAULT_IGNORES);
  ig.add(loadIgnoreFile(rootPath, '.gitignore'));
  ig.add(loadIgnoreFile(rootPath, '.devpilotignore'));

  let fileCount = 0;
  const languageCounts: Record<string, number> = {};

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
        fileCount += 1;
        const language = detectLanguage(entry);
        if (language) {
          languageCounts[language] = (languageCounts[language] ?? 0) + 1;
        }
      }
    }
  };

  walk(rootPath);
  return { fileCount, languageCounts };
}
