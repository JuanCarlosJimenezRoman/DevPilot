import path from 'node:path';
import { createLogger } from '@devpilot/shared';
import type { ContextPack } from '@devpilot/shared';
import {
  findProjectByRootPath,
  insertContextPack,
  openGlobalRegistryDb,
  openProjectDb,
  readSnapshotFile,
  writeContextPackFiles,
} from '@devpilot/storage';
import { buildContextPack, DEFAULT_MAX_FILES } from './contextPackBuilder.js';
import { renderContextPackMarkdown } from './markdownRenderer.js';
import { copyToClipboard } from './clipboard.js';

const logger = createLogger('core:context');

export interface BuildAndPersistContextParams {
  rawPath: string;
  taskText: string;
  confirmedDecisions?: string[];
  openDecisions?: string[];
  constraints?: string[];
  maxFiles?: number;
}

export interface BuildAndPersistContextResult {
  pack: ContextPack;
  markdownPath: string;
  jsonPath: string;
  copiedToClipboard: boolean;
  candidateCount: number;
}

/** `devpilot context "<tarea>"` (ver 07, Incremento 1): corre el Context Planner sobre un proyecto ya registrado (`devpilot project add`) y persiste el Context Pack resultante. */
export async function buildAndPersistContext(
  params: BuildAndPersistContextParams,
): Promise<BuildAndPersistContextResult> {
  const rootPath = path.resolve(params.rawPath);

  const registryDb = openGlobalRegistryDb();
  let project;
  try {
    project = findProjectByRootPath(registryDb, rootPath);
  } finally {
    registryDb.close();
  }

  if (!project) {
    throw new Error(
      `Este proyecto no está registrado todavía. Corre \`devpilot project add ${params.rawPath}\` primero.`,
    );
  }

  const snapshot = await readSnapshotFile(rootPath);
  if (!snapshot) {
    throw new Error(
      `No hay un snapshot guardado para este proyecto. Corre \`devpilot project add ${params.rawPath}\` primero.`,
    );
  }

  const { pack, candidateCount } = buildContextPack({
    project,
    snapshot,
    taskText: params.taskText,
    confirmedDecisions: params.confirmedDecisions ?? [],
    openDecisions: params.openDecisions ?? [],
    constraints: params.constraints ?? [],
    maxFiles: params.maxFiles ?? DEFAULT_MAX_FILES,
  });

  const markdown = renderContextPackMarkdown(pack, project, snapshot);

  const { markdownPath, jsonPath } = await writeContextPackFiles(rootPath, pack, markdown);

  // Bug real encontrado al implementar `devpilot diff` en una sesión
  // distinta a la que generó el Context Pack (ver diffService.ts/07): estas
  // rutas son absolutas en el momento de escribirse, y `rootPath` puede
  // venir de un punto de montaje que no es estable entre sesiones (p.ej. el
  // puente de dispositivo de Cowork). Guardar la ruta absoluta en SQLite
  // rompe justo la garantía de portabilidad que 03 promete explícitamente
  // ("si el usuario mueve o comparte la carpeta... su conocimiento viaja
  // con ella") — si el usuario mueve el proyecto, la ruta absoluta vieja
  // ya no sirve aunque el archivo siga ahí, relativo a la nueva raíz. Se
  // persiste relativo a `rootPath`; quien lea la fila (import/diff) la
  // resuelve de vuelta a absoluta contra el `rootPath` *actual*, no el de
  // cuando se generó.
  const projectDb = openProjectDb(rootPath);
  try {
    insertContextPack(projectDb, {
      id: pack.id,
      taskText: pack.task.rawText,
      createdAt: pack.createdAt,
      tokenEstimate: pack.tokenEstimate.totalTokens,
      classification: pack.tokenEstimate.classification,
      markdownPath: path.relative(rootPath, markdownPath),
      jsonPath: path.relative(rootPath, jsonPath),
    });
  } finally {
    projectDb.close();
  }

  const copiedToClipboard = copyToClipboard(markdown);
  logger.debug('context pack generado', pack.id, 'archivos:', pack.relevantFiles.length);

  return { pack, markdownPath, jsonPath, copiedToClipboard, candidateCount };
}
