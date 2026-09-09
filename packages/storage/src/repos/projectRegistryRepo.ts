import type { DatabaseSync } from 'node:sqlite';
import type { Project } from '@devpilot/shared';

// Repositorio sobre `~/.devpilot/registry.db` (tabla `projects`, ver 03).
// Cada función recibe la conexión ya abierta (por `openGlobalRegistryDb`) —
// este módulo no gestiona el ciclo de vida de la conexión, solo las
// consultas.

interface ProjectRow {
  id: string;
  name: string;
  root_path: string;
  vcs: string;
  created_at: string;
  updated_at: string;
  last_opened_at: string | null;
}

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.root_path,
    vcs: row.vcs === 'git' ? 'git' : 'none',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function findProjectByRootPath(db: DatabaseSync, rootPath: string): Project | null {
  const row = db.prepare('SELECT * FROM projects WHERE root_path = ?').get(rootPath) as
    | unknown
    | undefined;
  return row ? rowToProject(row as ProjectRow) : null;
}

export function findProjectById(db: DatabaseSync, id: string): Project | null {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as unknown | undefined;
  return row ? rowToProject(row as ProjectRow) : null;
}

export function insertProject(db: DatabaseSync, project: Project): void {
  db.prepare(
    `INSERT INTO projects (id, name, root_path, vcs, created_at, updated_at, last_opened_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    project.id,
    project.name,
    project.rootPath,
    project.vcs,
    project.createdAt,
    project.updatedAt,
    project.updatedAt,
  );
}

/** Actualiza `updated_at` y `last_opened_at` (ej. cada `devpilot project add` sobre un proyecto ya registrado). */
export function touchProjectOpened(db: DatabaseSync, id: string, timestamp: string): void {
  db.prepare('UPDATE projects SET updated_at = ?, last_opened_at = ? WHERE id = ?').run(
    timestamp,
    timestamp,
    id,
  );
}

export function listProjects(db: DatabaseSync): Project[] {
  const rows = db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as unknown[];
  return rows.map((row) => rowToProject(row as ProjectRow));
}
