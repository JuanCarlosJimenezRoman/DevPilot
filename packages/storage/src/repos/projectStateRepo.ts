import type { DatabaseSync } from 'node:sqlite';
import type { ProjectState } from '@devpilot/shared';

// Repositorio sobre `<proyecto>/.devpilot/devpilot.db` (tabla
// `project_state`, ver 03) — fila única por proyecto.

interface ProjectStateRow {
  project_id: string;
  last_indexed_commit: string | null;
  last_deep_analysis_commit: string | null;
  last_scan_at: string | null;
  snapshot_version: number;
  snapshot_path: string | null;
}

function rowToState(row: ProjectStateRow): ProjectState {
  return {
    projectId: row.project_id,
    lastIndexedCommit: row.last_indexed_commit,
    lastDeepAnalysisCommit: row.last_deep_analysis_commit,
    lastScanAt: row.last_scan_at,
    snapshotVersion: row.snapshot_version,
    snapshotPath: row.snapshot_path,
  };
}

export function getProjectState(db: DatabaseSync, projectId: string): ProjectState | null {
  const row = db.prepare('SELECT * FROM project_state WHERE project_id = ?').get(projectId) as
    | unknown
    | undefined;
  return row ? rowToState(row as ProjectStateRow) : null;
}

/**
 * Devuelve el `project_state` más reciente que ya exista en esta base local
 * de proyecto, sin necesitar conocer de antemano el `project_id` — a
 * diferencia de `getProjectState`, que exige el id.
 *
 * Usado por `addProject` (`@devpilot/core`) para reutilizar un id local ya
 * indexado en vez de generar uno nuevo cuando el registro global no conoce
 * todavía esta ruta (pasa si el registro global se resetea o nunca vio este
 * proyecto, pero `.devpilot/devpilot.db` ya tiene estado real de un
 * `project add` anterior — ver limitación #15 del handoff). Si por este
 * mismo bug en sesiones anteriores llegó a haber más de una fila
 * (project_state con varios project_id distintos para el mismo proyecto
 * físico), se queda con la de `last_scan_at` más reciente en vez de
 * elegir una al azar.
 */
export function findMostRecentProjectState(db: DatabaseSync): ProjectState | null {
  const row = db
    .prepare('SELECT * FROM project_state ORDER BY last_scan_at DESC LIMIT 1')
    .get() as unknown | undefined;
  return row ? rowToState(row as ProjectStateRow) : null;
}

export function upsertProjectState(db: DatabaseSync, state: ProjectState): void {
  db.prepare(
    `INSERT INTO project_state
       (project_id, last_indexed_commit, last_deep_analysis_commit, last_scan_at, snapshot_version, snapshot_path)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET
       last_indexed_commit = excluded.last_indexed_commit,
       last_deep_analysis_commit = excluded.last_deep_analysis_commit,
       last_scan_at = excluded.last_scan_at,
       snapshot_version = excluded.snapshot_version,
       snapshot_path = excluded.snapshot_path`,
  ).run(
    state.projectId,
    state.lastIndexedCommit,
    state.lastDeepAnalysisCommit,
    state.lastScanAt,
    state.snapshotVersion,
    state.snapshotPath,
  );
}
