import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { ProjectSnapshot } from '@devpilot/shared';
import { getProjectSnapshotPath, getProjectStateDir } from '../db/paths.js';

// `.devpilot/state/snapshot.json` — el Project Snapshot completo en disco,
// legible/versionable con Git si el usuario decide commitear `.devpilot/`
// (ver 03). `project_state.snapshot_path` en SQLite solo apunta aquí.

export async function writeSnapshotFile(
  rootPath: string,
  snapshot: ProjectSnapshot,
): Promise<string> {
  await mkdir(getProjectStateDir(rootPath), { recursive: true });
  const filePath = getProjectSnapshotPath(rootPath);
  await writeFile(filePath, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
  return filePath;
}

export async function readSnapshotFile(rootPath: string): Promise<ProjectSnapshot | null> {
  try {
    const raw = await readFile(getProjectSnapshotPath(rootPath), 'utf8');
    return JSON.parse(raw) as ProjectSnapshot;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}
