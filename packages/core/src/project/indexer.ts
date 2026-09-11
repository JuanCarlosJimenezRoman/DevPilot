import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createLogger } from '@devpilot/shared';
import {
  countFileIndexRows,
  deleteFileIndexRowByPath,
  listFileIndexPaths,
  upsertFileIndexRow,
  type FileIndexRow,
} from '@devpilot/storage';
import { detectLanguage } from './languageExtensions.js';
import { createIgnoreMatcher, listProjectFiles } from './fileWalker.js';

const logger = createLogger('core:indexer');

// El Indexer (04, "Reindexado incremental"): mantiene la tabla `files`
// (hash + metadata por archivo, ver fileIndexRepo.ts) sin tener que
// recorrer y re-hashear todo el árbol en cada `devpilot project add`.
// `project_state.last_indexed_commit` -- una columna que existía desde el
// Incremento 0 pero que projectService.ts nunca escribía con un valor
// real (solo lo copiaba de sí mismo, siempre null, ver git blame de esa
// función) -- es lo que hace posible saber si "ya está al día" sin volver
// a mirar ni un solo archivo.

export type ReindexMode = 'skipped' | 'incremental' | 'full';

export interface ReindexResult {
  mode: ReindexMode;
  /** Commit git usado como referencia para este reindexado, o null si el proyecto no es git (o es git sin commits todavía). */
  currentCommit: string | null;
  filesAdded: number;
  filesUpdated: number;
  filesRemoved: number;
  /** Total de filas en `files` después de esta operación -- útil para reportar "296 archivos indexados" incluso en modo `skipped`. */
  totalIndexed: number;
}

function hashFileContent(absPath: string): string {
  // Buffer, no texto: un archivo binario que un `.gitignore` mal
  // configurado deja pasar no debe romper el hash (a diferencia de
  // `safeReadTextFile`, del Context Planner, que sí necesita decodificar
  // como texto para poder buscar palabras clave adentro).
  const buf = readFileSync(absPath);
  return createHash('sha256').update(buf).digest('hex');
}

function indexOneFile(
  db: DatabaseSync,
  relPath: string,
  absPath: string,
  currentCommit: string | null,
): void {
  const stat = statSync(absPath);
  const row: FileIndexRow = {
    id: randomUUID(),
    path: relPath,
    hash: hashFileContent(absPath),
    language: detectLanguage(relPath),
    sizeBytes: stat.size,
    lastModified: stat.mtime.toISOString(),
    lastSeenCommit: currentCommit,
    indexedAt: new Date().toISOString(),
  };
  upsertFileIndexRow(db, row);
}

function getCurrentGitCommit(rootPath: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: rootPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // repo git sin commits todavía, o `git` no disponible -- tratado igual
    // que "no hay referencia posible para diffear", ver reindexProject.
    return null;
  }
}

interface GitDiffChange {
  status: string; // 'A' | 'M' | 'D' | 'C' -- ver --no-renames más abajo
  path: string;
}

/**
 * `--no-renames`: sin esta bandera, git reporta un archivo movido como
 * una sola línea `R100  ruta-vieja  ruta-nueva`, que exigiría lógica
 * aparte (mover la fila del índice en vez de borrar+crear). Con
 * `--no-renames`, git reporta el mismo caso como `D ruta-vieja` +
 * `A ruta-nueva` -- dos líneas ya cubiertas por el resto de esta función.
 * Simplificación deliberada para v1: un archivo movido paga el costo de
 * un re-hash como si fuera nuevo, en vez de una operación más barata de
 * "renombrar fila" -- aceptable porque mover archivos es mucho menos
 * frecuente que editarlos, y el resultado final del índice es idéntico.
 */
function getGitDiffNameStatus(
  rootPath: string,
  fromCommit: string,
  toCommit: string,
): GitDiffChange[] | null {
  try {
    const output = execFileSync(
      'git',
      ['diff', '--name-status', '--no-renames', `${fromCommit}..${toCommit}`],
      { cwd: rootPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const tabIndex = line.indexOf('\t');
        if (tabIndex === -1) return null;
        return { status: line.slice(0, tabIndex), path: line.slice(tabIndex + 1) };
      })
      .filter((change): change is GitDiffChange => change !== null && change.path.length > 0);
  } catch {
    // El commit anterior ya no existe en el historial local (rebase,
    // force-push, o un clon superficial que podó ese commit) -- no hay
    // diff posible. `reindexProject` lo interpreta como "hace falta un
    // reindexado completo", nunca como un error fatal: perder
    // `last_indexed_commit` como referencia no debe romper `project add`.
    return null;
  }
}

/** Reindexado completo: recorre todo el árbol (mismo `listProjectFiles` que ya usa el Context Planner, respeta `.gitignore`/`.devpilotignore`), rehashea cada archivo, y borra del índice cualquier ruta que ya no aparezca en el recorrido. */
function fullReindex(db: DatabaseSync, rootPath: string, currentCommit: string | null): ReindexResult {
  const previousPaths = new Set(listFileIndexPaths(db));
  const currentFiles = listProjectFiles(rootPath);
  const currentPaths = new Set<string>();

  let filesAdded = 0;
  let filesUpdated = 0;

  for (const file of currentFiles) {
    currentPaths.add(file.relPath);
    indexOneFile(db, file.relPath, file.absPath, currentCommit);
    if (previousPaths.has(file.relPath)) filesUpdated += 1;
    else filesAdded += 1;
  }

  let filesRemoved = 0;
  for (const oldPath of previousPaths) {
    if (!currentPaths.has(oldPath)) {
      deleteFileIndexRowByPath(db, oldPath);
      filesRemoved += 1;
    }
  }

  logger.debug('reindexado completo', { filesAdded, filesUpdated, filesRemoved });
  return {
    mode: 'full',
    currentCommit,
    filesAdded,
    filesUpdated,
    filesRemoved,
    totalIndexed: countFileIndexRows(db),
  };
}

/** Reindexado incremental: solo toca las rutas que `git diff --name-status` marcó como cambiadas entre el último commit indexado y el commit actual -- nunca recorre el resto del árbol. */
function incrementalReindex(
  db: DatabaseSync,
  rootPath: string,
  changes: GitDiffChange[],
  currentCommit: string | null,
): ReindexResult {
  const previousPaths = new Set(listFileIndexPaths(db));
  const isIgnored = createIgnoreMatcher(rootPath);
  let filesAdded = 0;
  let filesUpdated = 0;
  let filesRemoved = 0;

  for (const change of changes) {
    if (change.status.startsWith('D')) {
      if (previousPaths.has(change.path)) {
        deleteFileIndexRowByPath(db, change.path);
        filesRemoved += 1;
      }
      continue;
    }

    // A/M/C (copy) -- git ya nos dice exactamente qué cambió, no hace
    // falta distinguir el tipo exacto de cambio más allá de A vs. D. Pero
    // sí hace falta re-aplicar las mismas reglas de ignorados que un
    // recorrido completo (ver createIgnoreMatcher): sin esto, una ruta
    // ignorada que igual aparece en `git diff` (ej. `.devpilot/` sin
    // `.gitignore` propio) entraría al índice en modo incremental aunque
    // un reindexado completo nunca la habría incluido.
    if (isIgnored(change.path)) continue;

    const absPath = path.join(rootPath, change.path);
    if (!existsSync(absPath)) continue; // ya borrado en disco pese a no venir como 'D' -- defensivo, no debería pasar
    const wasIndexed = previousPaths.has(change.path);
    indexOneFile(db, change.path, absPath, currentCommit);
    if (wasIndexed) filesUpdated += 1;
    else filesAdded += 1;
  }

  logger.debug('reindexado incremental', { filesAdded, filesUpdated, filesRemoved });
  return {
    mode: 'incremental',
    currentCommit,
    filesAdded,
    filesUpdated,
    filesRemoved,
    totalIndexed: countFileIndexRows(db),
  };
}

/**
 * `devpilot project add` llama a esto después del Scanner (ver
 * projectService.ts). Decide entre tres caminos, en este orden:
 *
 * 1. **`skipped`**: el proyecto es git, ya tiene un índice, y el commit
 *    actual es igual a `previousLastIndexedCommit` -- nada cambió desde
 *    el último reindexado, no se toca ni un archivo.
 * 2. **`incremental`**: el proyecto es git, ya tiene un índice, el commit
 *    cambió, y `git diff --name-status` contra el commit anterior
 *    funciona -- solo se (re)procesan los archivos que ese diff marca.
 * 3. **`full`**: cualquier otro caso (primer reindexado, proyecto sin
 *    git, o el commit anterior ya no existe en el historial local) --
 *    recorrido completo, igual que el comportamiento que tenía
 *    `project add` antes de esta pieza.
 *
 * Limitación de v1, documentada explícitamente (ver 07-roadmap.md): esto
 * solo mira commits ya hechos, no el working tree sin commitear. No
 * reemplaza al Context Planner, que sigue recorriendo el árbol en vivo en
 * cada `devpilot context` para no perderse ediciones todavía sin
 * commitear -- esta pieza le da un consumidor real a la tabla `files`
 * (Indexer, 04) sin arriesgar esa garantía.
 */
export function reindexProject(
  db: DatabaseSync,
  rootPath: string,
  vcs: 'git' | 'none',
  previousLastIndexedCommit: string | null,
): ReindexResult {
  if (vcs !== 'git') {
    return fullReindex(db, rootPath, null);
  }

  const currentCommit = getCurrentGitCommit(rootPath);
  const alreadyIndexed = countFileIndexRows(db) > 0;

  if (currentCommit && previousLastIndexedCommit && alreadyIndexed) {
    if (currentCommit === previousLastIndexedCommit) {
      return {
        mode: 'skipped',
        currentCommit,
        filesAdded: 0,
        filesUpdated: 0,
        filesRemoved: 0,
        totalIndexed: countFileIndexRows(db),
      };
    }

    const changes = getGitDiffNameStatus(rootPath, previousLastIndexedCommit, currentCommit);
    if (changes) {
      return incrementalReindex(db, rootPath, changes, currentCommit);
    }
  }

  return fullReindex(db, rootPath, currentCommit);
}
