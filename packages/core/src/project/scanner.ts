import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from '@devpilot/shared';
import { walkProjectFiles } from './fileWalker.js';

const logger = createLogger('core:scanner');

// Detección de stack por heurísticas sobre archivos de configuración (no
// IA) — ver docs/architecture/04-context-engine.md, tabla de señales.

/** Resultado crudo del Scanner, sin los campos que decide projectService (projectId/version/createdAt). */
export interface ProjectScanResult {
  language: string[];
  framework?: string;
  packageManager?: 'pnpm' | 'npm' | 'yarn' | 'bun';
  orm?: string;
  database?: string;
  hasDocker: boolean;
  scripts: Record<string, string>;
  fileCount: number;
  gitCommit: string | null;
}

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

// Subcarpetas comunes de monorepos que no tienen un package.json en la
// raíz (ej. "backend/" + "frontend/" en vez de un root con workspaces) —
// el mismo patrón que Camino al Deporte, encontrado durante el Paso 0.
const MONOREPO_SIBLING_DIRS = ['backend', 'frontend', 'server', 'client', 'api', 'web'];

function readJsonSafe<T>(filePath: string): T | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function findPackageJsonFiles(rootPath: string): string[] {
  const found: string[] = [];
  const rootPkg = path.join(rootPath, 'package.json');
  if (existsSync(rootPkg)) found.push(rootPkg);

  for (const dir of MONOREPO_SIBLING_DIRS) {
    const candidate = path.join(rootPath, dir, 'package.json');
    if (existsSync(candidate)) found.push(candidate);
  }

  for (const globDir of ['apps', 'packages']) {
    const base = path.join(rootPath, globDir);
    if (!existsSync(base)) continue;
    try {
      for (const entry of readdirSync(base)) {
        const candidate = path.join(base, entry, 'package.json');
        if (existsSync(candidate)) found.push(candidate);
      }
    } catch {
      // ignorar — no crítico para el snapshot
    }
  }

  return found;
}

function mergeDependencies(pkgs: PackageJson[]): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const pkg of pkgs) {
    Object.assign(merged, pkg.dependencies, pkg.devDependencies);
  }
  return merged;
}

function mergeScripts(pkgs: PackageJson[]): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const pkg of pkgs) {
    for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
      if (!(name in merged)) merged[name] = cmd;
    }
  }
  return merged;
}

function detectPackageManager(
  rootPath: string,
  pkgJsonPaths: string[],
): ProjectScanResult['packageManager'] | undefined {
  const candidates = [rootPath, ...pkgJsonPaths.map((p) => path.dirname(p))];
  const lockfiles: [string, ProjectScanResult['packageManager']][] = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['package-lock.json', 'npm'],
    ['yarn.lock', 'yarn'],
    ['bun.lockb', 'bun'],
  ];
  for (const dir of candidates) {
    for (const [lockfile, manager] of lockfiles) {
      if (existsSync(path.join(dir, lockfile))) return manager;
    }
  }
  return undefined;
}

// Orden de prioridad: señales más específicas primero, para no confundir
// ej. "usa Express dentro de un monorepo Next.js" con framework=express.
const FRAMEWORK_SIGNALS: {
  name: string;
  matches: (rootPath: string, deps: Record<string, string>) => boolean;
}[] = [
  {
    name: 'next',
    matches: (root, deps) =>
      'next' in deps || existsSync(path.join(root, 'next.config.js')) || existsSync(path.join(root, 'next.config.mjs')) || existsSync(path.join(root, 'next.config.ts')),
  },
  {
    name: 'nestjs',
    matches: (root, deps) => existsSync(path.join(root, 'nest-cli.json')) || '@nestjs/core' in deps,
  },
  {
    name: 'nuxt',
    matches: (root, deps) => 'nuxt' in deps || existsSync(path.join(root, 'nuxt.config.ts')),
  },
  {
    name: 'angular',
    matches: (root) => existsSync(path.join(root, 'angular.json')),
  },
  {
    name: 'vue',
    matches: (_root, deps) => 'vue' in deps,
  },
  {
    name: 'react',
    matches: (_root, deps) => 'react' in deps,
  },
  {
    name: 'fastify',
    matches: (_root, deps) => 'fastify' in deps,
  },
  {
    name: 'express',
    matches: (_root, deps) => 'express' in deps,
  },
];

function detectFramework(rootPath: string, deps: Record<string, string>): string | undefined {
  for (const signal of FRAMEWORK_SIGNALS) {
    if (signal.matches(rootPath, deps)) return signal.name;
  }
  return undefined;
}

function detectOrm(rootPath: string, deps: Record<string, string>): string | undefined {
  if (
    existsSync(path.join(rootPath, 'prisma', 'schema.prisma')) ||
    findFileInAnyPkgDir(rootPath, 'prisma/schema.prisma')
  ) {
    return 'prisma';
  }
  if (
    existsSync(path.join(rootPath, 'drizzle.config.ts')) ||
    existsSync(path.join(rootPath, 'drizzle.config.js')) ||
    'drizzle-orm' in deps
  ) {
    return 'drizzle';
  }
  if ('typeorm' in deps) return 'typeorm';
  return undefined;
}

function findFileInAnyPkgDir(rootPath: string, relFile: string): boolean {
  return MONOREPO_SIBLING_DIRS.some((dir) => existsSync(path.join(rootPath, dir, relFile)));
}

function findPrismaSchemaPath(rootPath: string): string | null {
  const rootSchema = path.join(rootPath, 'prisma', 'schema.prisma');
  if (existsSync(rootSchema)) return rootSchema;
  for (const dir of MONOREPO_SIBLING_DIRS) {
    const candidate = path.join(rootPath, dir, 'prisma', 'schema.prisma');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function detectDatabase(rootPath: string): string | undefined {
  const prismaSchemaPath = findPrismaSchemaPath(rootPath);
  if (prismaSchemaPath) {
    try {
      const content = readFileSync(prismaSchemaPath, 'utf8');
      const match = content.match(/datasource\s+\w+\s*{[^}]*provider\s*=\s*"([^"]+)"/s);
      if (match) return match[1];
    } catch {
      // seguir con el fallback de .env.example
    }
  }

  for (const envFile of ['.env.example', '.env']) {
    const envPath = path.join(rootPath, envFile);
    if (!existsSync(envPath)) continue;
    try {
      const content = readFileSync(envPath, 'utf8');
      const urlMatch = content.match(/DATABASE_URL\s*=\s*"?(\w+):\/\//);
      if (urlMatch) {
        const scheme = urlMatch[1];
        if (!scheme) continue;
        if (scheme.startsWith('postgres')) return 'postgresql';
        if (scheme.startsWith('mysql')) return 'mysql';
        if (scheme.startsWith('sqlite')) return 'sqlite';
        if (scheme.startsWith('mongodb')) return 'mongodb';
        return scheme;
      }
    } catch {
      // ignorar — no crítico
    }
  }
  return undefined;
}

function detectDocker(rootPath: string): boolean {
  if (existsSync(path.join(rootPath, 'Dockerfile'))) return true;
  const entries = ['docker-compose.yml', 'docker-compose.yaml'];
  return entries.some((f) => existsSync(path.join(rootPath, f)));
}

function detectGit(rootPath: string): { vcs: 'git' | 'none'; commit: string | null } {
  if (!existsSync(path.join(rootPath, '.git'))) {
    return { vcs: 'none', commit: null };
  }
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: rootPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return { vcs: 'git', commit };
  } catch {
    // repo git sin commits todavía (u otro error no fatal) — vcs sigue siendo 'git'
    return { vcs: 'git', commit: null };
  }
}

/** Escanea `rootPath` y devuelve el resultado crudo del stack detectado. No toca SQLite ni disco de `.devpilot/` — eso es projectService. */
export function scanProject(rootPath: string): ProjectScanResult {
  logger.debug('escaneando proyecto', rootPath);

  const pkgJsonPaths = findPackageJsonFiles(rootPath);
  const pkgJsons = pkgJsonPaths
    .map((p) => readJsonSafe<PackageJson>(p))
    .filter((p): p is PackageJson => p !== null);

  const deps = mergeDependencies(pkgJsons);
  const scripts = mergeScripts(pkgJsons);

  const { fileCount, languageCounts } = walkProjectFiles(rootPath);
  const language = Object.keys(languageCounts).sort(
    (a, b) => (languageCounts[b] ?? 0) - (languageCounts[a] ?? 0),
  );

  const { commit } = detectGit(rootPath);

  return {
    language,
    framework: detectFramework(rootPath, deps),
    packageManager: detectPackageManager(rootPath, pkgJsonPaths),
    orm: detectOrm(rootPath, deps),
    database: detectDatabase(rootPath),
    hasDocker: detectDocker(rootPath),
    scripts,
    fileCount,
    gitCommit: commit,
    // vcs no es parte de ProjectScanResult (pertenece a Project, no a
    // ProjectSnapshot) pero projectService lo necesita — se recalcula ahí
    // con detectGit() para no duplicar la llamada a git aquí. Ver
    // projectService.ts.
  } satisfies ProjectScanResult;
}

/** Expuesto aparte porque projectService necesita `vcs` (campo de `Project`, no de `ProjectSnapshot`) sin volver a invocar git. */
export function detectVcs(rootPath: string): 'git' | 'none' {
  return detectGit(rootPath).vcs;
}
