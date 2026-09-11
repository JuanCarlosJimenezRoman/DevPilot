import { execFileSync } from 'node:child_process';
import type { GitCommit, GitDiff, GitStatus, GitStatusEntry } from '@devpilot/shared';

// GitAdapter (Incremento 3 — ver docs/architecture/02-architecture-and-repo-structure.md
// "Integración con Git" y 07-roadmap.md): capa delgada sobre el binario
// `git` del sistema, invocado vía subprocess — nunca una librería como
// `simple-git` (02 es explícito: "para minimizar dependencias y
// comportamientos inesperados"). Mismo patrón de `execFileSync` +
// try/catch que ya usa indexer.ts para `getCurrentGitCommit`/
// `getGitDiffNameStatus`, pero deliberadamente NO comparte código con esas
// dos funciones: son internas al Indexer (no exportadas), ya validadas en
// el Incremento 2, y esta pieza no necesita tocarlas para no arriesgar esa
// validación — GitAdapter es un módulo nuevo y más general, pensado para
// el CLI (`devpilot git ...`) y el Nivel 4 del Context Planner
// (relevancePlanner.ts), no un reemplazo de esas dos funciones internas.
//
// 02 documenta la interfaz completa con seis métodos, incluido
// `commit(message, paths)` ("requiere aprobación, Tool Engine"). v1 de
// esta pieza implementa los cinco de solo lectura (`isRepo`/`status`/
// `diff`/`log`/`currentCommit`) — son los que el roadmap (07, Incremento
// 3) pide y los que Nivel 4 necesita. `commit()` se deja afuera
// deliberadamente: mismo criterio ya documentado en permissionGuard.ts
// para `run_command`/`git_commit` ("no existen todavía como código — no
// hay ninguna pieza del roadmap que los necesite aún"). Wirearlo sin un
// consumidor real violaría ese mismo principio que el resto del código ya
// sigue (ver 07-roadmap.md, nota de esta pieza).

export interface GitAdapter {
  isRepo(): Promise<boolean>;
  status(): Promise<GitStatus>;
  diff(opts?: { from?: string; to?: string; paths?: string[] }): Promise<GitDiff>;
  log(opts?: { since?: string; limit?: number }): Promise<GitCommit[]>;
  currentCommit(): Promise<string | null>;
}

const DEFAULT_LOG_LIMIT = 30;
// Un diff/log de un repo real puede ser grande (ver validación contra
// Camino al Deporte) — el límite por defecto de `execFileSync` (1MB) corta
// la salida a mitad de un patch. 20MB es generoso para un solo `git diff`/
// `git log` de un proyecto de tamaño normal (04) sin arriesgar memoria sin
// límite.
const MAX_GIT_OUTPUT_BYTES = 20 * 1024 * 1024;

function runGit(rootPath: string, args: string[]): string | null {
  try {
    const output = execFileSync('git', args, {
      cwd: rootPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
    });
    return output.trim();
  } catch {
    // `git` no instalado, `rootPath` no es un repo, comando inválido para
    // el estado actual del repo (ej. `diff <ref>` contra un ref que no
    // existe) — todos tratados igual, ver cada método: nunca se lanza,
    // siempre se representa como "sin señal" (null/[]/estado vacío).
    return null;
  }
}

function isRepoSync(rootPath: string): boolean {
  return runGit(rootPath, ['rev-parse', '--is-inside-work-tree']) === 'true';
}

function currentCommitSync(rootPath: string): string | null {
  return runGit(rootPath, ['rev-parse', 'HEAD']);
}

/**
 * Parsea `git status --porcelain=v1 -b --untracked-files=all`. Formato de
 * cada línea de estado: dos caracteres de código (X = índice, Y = working
 * tree) + espacio + ruta (o `origen -> destino` para renombres/copias, del
 * cual se toma el destino). La primera línea (`## ...`) es la rama —
 * `-b` es lo que la agrega. Ver 02 "Integración con Git".
 */
function parseStatusPorcelain(raw: string): GitStatus {
  const lines = raw.split('\n').filter((l) => l.length > 0);
  const headerLine = lines[0] ?? '';
  const rest = lines.slice(1);

  let branch: string | null = null;
  if (headerLine.startsWith('## ')) {
    const header = headerLine.slice(3);
    if (header.startsWith('No commits yet on ')) {
      branch = header.slice('No commits yet on '.length).trim() || null;
    } else if (header.startsWith('HEAD (no branch)')) {
      branch = null; // detached
    } else {
      // "main...origin/main [ahead 1]" -> "main"; "main" -> "main"
      const cut = header.search(/\.\.\.| \[/);
      branch = (cut === -1 ? header : header.slice(0, cut)).trim() || null;
    }
  }

  const staged: GitStatusEntry[] = [];
  const unstaged: GitStatusEntry[] = [];
  const untracked: string[] = [];

  for (const line of rest) {
    const code = line.slice(0, 2);
    const rawPath = line.slice(3);
    // Renombre/copia: "old -> new" -- nos quedamos con el destino, la ruta
    // que de verdad existe hoy en el árbol de trabajo.
    const arrowIdx = rawPath.indexOf(' -> ');
    const filePath = arrowIdx === -1 ? rawPath : rawPath.slice(arrowIdx + 4);
    if (!filePath) continue;

    if (code === '??') {
      untracked.push(filePath);
      continue;
    }
    const indexChar = code[0] ?? ' ';
    const worktreeChar = code[1] ?? ' ';
    // Un archivo con cambios parcialmente stageados (ej. "MM") aparece en
    // ambas listas a la vez -- son dos hechos ciertos simultáneamente, no
    // mutuamente excluyentes.
    if (indexChar !== ' ') staged.push({ path: filePath, code });
    if (worktreeChar !== ' ') unstaged.push({ path: filePath, code });
  }

  return {
    branch,
    clean: staged.length === 0 && unstaged.length === 0 && untracked.length === 0,
    staged,
    unstaged,
    untracked,
  };
}

function statusSync(rootPath: string): GitStatus {
  if (!isRepoSync(rootPath)) {
    return { branch: null, clean: true, staged: [], unstaged: [], untracked: [] };
  }
  const raw = runGit(rootPath, ['status', '--porcelain=v1', '-b', '--untracked-files=all']);
  if (raw === null) return { branch: null, clean: true, staged: [], unstaged: [], untracked: [] };
  return parseStatusPorcelain(raw);
}

/**
 * Header de cada archivo dentro de un diff unificado multi-archivo:
 * `diff --git a/<ruta vieja> b/<ruta nueva>`. Se usa como separador de
 * "chunks" (uno por archivo) y como fallback para la ruta cuando no hay
 * líneas `+++`/`---` (ej. archivos binarios: "Binary files a/x and b/y
 * differ", sin hunks de texto).
 */
const DIFF_HEADER_RE = /^diff --git a\/(.+?) b\/(.+)$/m;

function parseUnifiedDiff(raw: string): GitDiff {
  if (!raw || raw.trim().length === 0) return { files: [] };

  const chunks = raw.split(/(?=^diff --git )/m).filter((c) => c.trim().length > 0);
  const files: { path: string; patch: string }[] = [];
  for (const chunk of chunks) {
    const plusMatch = chunk.match(/^\+\+\+ b\/(.+)$/m);
    const minusMatch = chunk.match(/^--- a\/(.+)$/m);
    const headerMatch = chunk.match(DIFF_HEADER_RE);
    const path = plusMatch?.[1] ?? minusMatch?.[1] ?? headerMatch?.[2] ?? null;
    if (path) files.push({ path, patch: chunk.trimEnd() });
  }
  return { files };
}

function diffSync(rootPath: string, opts?: { from?: string; to?: string; paths?: string[] }): GitDiff {
  if (!isRepoSync(rootPath)) return { files: [] };

  const args = ['diff'];
  if (opts?.from && opts?.to) {
    args.push(`${opts.from}..${opts.to}`);
  } else if (opts?.to) {
    args.push(opts.to);
  } else if (opts?.from) {
    args.push(opts.from);
  } else if (currentCommitSync(rootPath) !== null) {
    // Sin refs explícitos: todo lo sin commitear (stageado + sin stagear)
    // contra HEAD -- lo más útil como "qué se está tocando ahora mismo"
    // (ver ContextPack.recentChanges, shared/domain/types.ts). Si el repo
    // todavía no tiene commits, cae al `git diff` plano de más abajo (solo
    // compara contra el índice, que es el único punto de referencia que
    // existe en ese caso).
    args.push('HEAD');
  }
  if (opts?.paths && opts.paths.length > 0) {
    args.push('--', ...opts.paths);
  }

  const raw = runGit(rootPath, args);
  if (raw === null) return { files: [] };
  return parseUnifiedDiff(raw);
}

/**
 * Archivos tocados por un commit puntual. Llamada aparte de `log()` (en
 * vez de interleavear `--name-only` con el `--pretty=format:` del log) a
 * propósito: parsear la salida combinada de git de forma robusta (sin
 * asumir cuántas líneas en blanco separan cada commit de su lista de
 * archivos) es bastante más frágil que un subprocess extra por commit --
 * aceptable porque `log()` está acotado por `limit` (30 por defecto, ver
 * DEFAULT_LOG_LIMIT), nunca recorre todo el historial.
 */
function listFilesChangedInCommit(rootPath: string, hash: string): string[] {
  const raw = runGit(rootPath, ['diff-tree', '--no-commit-id', '--name-only', '-r', hash]);
  if (raw === null || raw.length === 0) return [];
  return raw.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
}

// Separadores de control ASCII (Record/Unit Separator) en vez de un
// delimitador imprimible como "|": un mensaje de commit real puede
// contener casi cualquier carácter imprimible, pero nunca estos dos --
// evita que un commit con "|" en el subject rompa el parseo.
const FIELD_SEP = '\x1f';
const RECORD_SEP = '\x1e';

function logSync(rootPath: string, opts?: { since?: string; limit?: number }): GitCommit[] {
  if (!isRepoSync(rootPath) || currentCommitSync(rootPath) === null) return [];

  const limit = opts?.limit ?? DEFAULT_LOG_LIMIT;
  const args = [
    'log',
    '-n',
    String(limit),
    `--pretty=format:%H${FIELD_SEP}%an${FIELD_SEP}%ae${FIELD_SEP}%aI${FIELD_SEP}%s${RECORD_SEP}`,
  ];
  if (opts?.since) args.push(`--since=${opts.since}`);

  const raw = runGit(rootPath, args);
  if (raw === null || raw.length === 0) return [];

  const records = raw.split(RECORD_SEP).map((r) => r.trim()).filter((r) => r.length > 0);
  const commits: GitCommit[] = [];
  for (const record of records) {
    const parts = record.split(FIELD_SEP);
    const hash = parts[0];
    if (!hash) continue;
    commits.push({
      hash,
      authorName: parts[1] ?? '',
      authorEmail: parts[2] ?? '',
      date: parts[3] ?? '',
      message: parts[4] ?? '',
      filesChanged: listFilesChangedInCommit(rootPath, hash),
    });
  }
  return commits;
}

/** Fábrica del GitAdapter para un proyecto puntual — ver 02. Cada método es async por contrato (interfaz documentada), aunque la implementación es síncrona (subprocess de `git` corto, mismo patrón que indexer.ts). */
export function createGitAdapter(rootPath: string): GitAdapter {
  return {
    isRepo: async () => isRepoSync(rootPath),
    status: async () => statusSync(rootPath),
    diff: async (opts) => diffSync(rootPath, opts),
    log: async (opts) => logSync(rootPath, opts),
    currentCommit: async () => currentCommitSync(rootPath),
  };
}
