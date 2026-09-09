import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from '@devpilot/shared';
import type { Project, ProjectSnapshot, ProjectState } from '@devpilot/shared';
import {
  findProjectByRootPath,
  getProjectState,
  insertProject,
  listProjects as listProjectsRepo,
  openGlobalRegistryDb,
  openProjectDb,
  touchProjectOpened,
  upsertProjectState,
  writeSnapshotFile,
} from '@devpilot/storage';
import { detectVcs, scanProject } from './scanner.js';

const logger = createLogger('core:project');

export interface AddProjectResult {
  project: Project;
  snapshot: ProjectSnapshot;
  state: ProjectState;
}

/**
 * `devpilot project add <ruta>` (ver 07, Incremento 1): registra (o
 * actualiza, si ya existía) el proyecto en el catálogo global, escanea su
 * stack, y persiste el Project Snapshot resultante — tanto en la base local
 * del proyecto como en `.devpilot/state/snapshot.json`.
 */
export async function addProject(rawPath: string): Promise<AddProjectResult> {
  const rootPath = path.resolve(rawPath);

  if (!existsSync(rootPath) || !statSync(rootPath).isDirectory()) {
    throw new Error(`No existe la carpeta: ${rootPath}`);
  }

  const now = new Date().toISOString();

  const registryDb = openGlobalRegistryDb();
  let project: Project;
  try {
    const existing = findProjectByRootPath(registryDb, rootPath);
    if (existing) {
      touchProjectOpened(registryDb, existing.id, now);
      project = { ...existing, updatedAt: now };
      logger.debug('proyecto ya registrado, re-escaneando', project.id);
    } else {
      project = {
        id: randomUUID(),
        name: path.basename(rootPath),
        rootPath,
        vcs: detectVcs(rootPath),
        createdAt: now,
        updatedAt: now,
      };
      insertProject(registryDb, project);
      logger.debug('proyecto nuevo registrado', project.id);
    }
  } finally {
    registryDb.close();
  }

  const scanResult = scanProject(rootPath);

  const projectDb = openProjectDb(rootPath);
  let state: ProjectState;
  let snapshot: ProjectSnapshot;
  try {
    const previousState = getProjectState(projectDb, project.id);
    const version = (previousState?.snapshotVersion ?? 0) + 1;

    snapshot = {
      projectId: project.id,
      version,
      createdAt: now,
      language: scanResult.language,
      framework: scanResult.framework,
      packageManager: scanResult.packageManager,
      orm: scanResult.orm,
      database: scanResult.database,
      hasDocker: scanResult.hasDocker,
      scripts: scanResult.scripts,
      fileCount: scanResult.fileCount,
      gitCommit: scanResult.gitCommit,
    };

    const snapshotPath = await writeSnapshotFile(rootPath, snapshot);

    state = {
      projectId: project.id,
      lastIndexedCommit: previousState?.lastIndexedCommit ?? null,
      lastDeepAnalysisCommit: previousState?.lastDeepAnalysisCommit ?? null,
      lastScanAt: now,
      snapshotVersion: version,
      snapshotPath,
    };
    upsertProjectState(projectDb, state);
  } finally {
    projectDb.close();
  }

  return { project, snapshot, state };
}

/** `devpilot project list` — lee solo el catálogo global, no toca las bases locales de cada proyecto. */
export function listProjects(): Project[] {
  const registryDb = openGlobalRegistryDb();
  try {
    return listProjectsRepo(registryDb);
  } finally {
    registryDb.close();
  }
}
