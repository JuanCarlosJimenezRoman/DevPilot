import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from '@devpilot/shared';
import type { Project, ProjectSnapshot, ProjectState } from '@devpilot/shared';
import {
  findMostRecentProjectState,
  findProjectById,
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
import { reindexProject, type ReindexResult } from './indexer.js';

const logger = createLogger('core:project');

export interface AddProjectResult {
  project: Project;
  snapshot: ProjectSnapshot;
  state: ProjectState;
  reindex: ReindexResult;
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
      // Antes de generar un id nuevo, hay que revisar si esta carpeta ya
      // tiene un `.devpilot/devpilot.db` con `project_state` real — pasa
      // cuando el registro global no conoce todavía esta ruta (se
      // reseteó, o nunca la vio) pero el proyecto ya fue escaneado antes
      // (bug real encontrado en sesión 9, ver limitación #15 del handoff:
      // cada sesión de este bridge con su propio `$HOME` efímero generaba
      // un `project_id` nuevo cada vez, dejando filas huérfanas en
      // `project_state`). Reutilizar ese id evita sumar más filas
      // huérfanas y a la vez re-registra el proyecto en el catálogo
      // global bajo el mismo id de siempre.
      const localDbForReuse = openProjectDb(rootPath);
      let reusableId: string | null;
      try {
        reusableId = findMostRecentProjectState(localDbForReuse)?.projectId ?? null;
      } finally {
        localDbForReuse.close();
      }
      // Defensa en profundidad: si ese id ya está tomado por OTRA ruta en
      // el registro global (coincidencia extremadamente improbable con
      // UUIDs, pero no imposible), no lo reutilizamos — mejor un id nuevo
      // que un INSERT que viola la PK de `projects` o mezcla el estado de
      // dos proyectos distintos.
      if (reusableId && findProjectById(registryDb, reusableId)) {
        reusableId = null;
      }

      project = {
        id: reusableId ?? randomUUID(),
        name: path.basename(rootPath),
        rootPath,
        vcs: detectVcs(rootPath),
        createdAt: now,
        updatedAt: now,
      };
      insertProject(registryDb, project);
      logger.debug(
        reusableId ? 'proyecto reencontrado por estado local, reusando id' : 'proyecto nuevo registrado',
        project.id,
      );
    }
  } finally {
    registryDb.close();
  }

  const scanResult = scanProject(rootPath);

  const projectDb = openProjectDb(rootPath);
  let state: ProjectState;
  let snapshot: ProjectSnapshot;
  let reindex: ReindexResult;
  try {
    const previousState = getProjectState(projectDb, project.id);
    const version = (previousState?.snapshotVersion ?? 0) + 1;

    // Indexer (04, "Reindexado incremental" — ver indexer.ts): mantiene la
    // tabla `files` sin recorrer y rehashear todo el árbol si el commit no
    // cambió desde el último `project add`. Corre después del Scanner
    // (que ya hizo su propio recorrido liviano, solo conteo/lenguaje, para
    // el Project Snapshot) y antes de persistir el nuevo `project_state`,
    // porque necesita el `lastIndexedCommit` anterior para decidir si
    // puede saltarse o ir incremental.
    reindex = reindexProject(
      projectDb,
      rootPath,
      project.vcs,
      previousState?.lastIndexedCommit ?? null,
    );

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
      // Antes de esta pieza, este campo nunca se escribía con un valor
      // real: solo se copiaba el `previousState?.lastIndexedCommit` de sí
      // mismo, así que se quedaba en `null` para siempre (mismo patrón de
      // "columna existe desde el Incremento 0, sin consumidor real" que
      // otras piezas de este incremento). Ahora `reindex.currentCommit` es
      // el commit real usado por el Indexer para este reindexado — `null`
      // solo si el proyecto no es git, o es git sin commits todavía.
      lastIndexedCommit: reindex.currentCommit,
      lastDeepAnalysisCommit: previousState?.lastDeepAnalysisCommit ?? null,
      lastScanAt: now,
      snapshotVersion: version,
      snapshotPath,
    };
    upsertProjectState(projectDb, state);
  } finally {
    projectDb.close();
  }

  return { project, snapshot, state, reindex };
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
