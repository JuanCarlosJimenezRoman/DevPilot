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
