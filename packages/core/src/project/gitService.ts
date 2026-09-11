import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { createGitAdapter, type GitAdapter } from './gitAdapter.js';

// Wrapper delgado para el consumidor directo de GitAdapter: `devpilot git
// status|log|diff` (ver apps/cli/src/commands/git.ts, 07 Incremento 3).
// A diferencia de `devpilot project add`/`devpilot context`, estos
// comandos NO requieren que el proyecto esté registrado en DevPilot --
// son una herramienta de inspección de git general, útil incluso antes de
// `project add`. Misma validación de ruta que `addProject`
// (projectService.ts) para el mismo mensaje de error familiar.

export interface GitInspection {
  rootPath: string;
  git: GitAdapter;
}

export function openGitAdapter(rawPath: string): GitInspection {
  const rootPath = path.resolve(rawPath);
  if (!existsSync(rootPath) || !statSync(rootPath).isDirectory()) {
    throw new Error(`No existe la carpeta: ${rootPath}`);
  }
  return { rootPath, git: createGitAdapter(rootPath) };
}
