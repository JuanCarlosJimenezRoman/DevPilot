import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { createLogger } from '@devpilot/shared';
import type { FileChangeProposal, ValidationCheck } from '@devpilot/shared';
import {
  findProjectByRootPath,
  getContextPackById,
  getLatestContextPack,
  listFileChangeProposalsByContextPack,
  openGlobalRegistryDb,
  openProjectDb,
  readChangeProposalFile,
} from '@devpilot/storage';
import { reconstructChangeContent } from './changeReconstruction.js';

const logger = createLogger('core:diff');

// DiffService — la pieza que sigue a `devpilot import` en la cadena del
// roadmap (07): "Proyecto → Contexto → IA web → Respuesta → Import → Diff
// → Apply". `devpilot import` clasifica pero nunca aplica; `devpilot diff`
// muestra qué cambiaría realmente en disco si se aplicara cada propuesta —
// sigue sin tocar nada, es pura lectura — para que el usuario decida antes
// de aplicar con `devpilot apply` (que sí necesita Tool Engine, ver 05).
//
// La reconstrucción de "qué contenido resultaría de esto" vive en
// changeReconstruction.ts, compartida con applyService.ts — incluye ahora
// `format: 'diff'` (antes se mostraba tal cual sin validar nada contra el
// archivo real; ver 07, hallazgo de la sesión de `devpilot diff`).

export interface FileDiffEntry {
  proposalId: string;
  filePath: string;
  operation: string;
  format: string;
  validationStatus: 'valid' | 'warning' | 'reject';
  confidence: number;
  /**
   * Texto del diff en formato unificado (`diff -u`), listo para mostrar en
   * terminal. `null` si no se pudo reconstruir en absoluto (ver
   * `buildError`) — en ese caso el detalle de los checks fallidos (abajo)
   * es la única explicación disponible.
   */
  diffText: string | null;
  buildError: string | null;
  /**
   * Checks del `ChangeValidator` que no pasaron, en el mismo orden en que
   * se evaluaron. Para `reject` son la razón por la que no se ofrece; para
   * `warning`, la decisión pendiente que el usuario tiene que resolver.
   */
  failingChecks: ValidationCheck[];
}

export interface DiffResult {
  contextPackId: string;
  entries: FileDiffEntry[];
}

function buildDiffEntry(
  proposalId: string,
  proposal: FileChangeProposal,
  validationStatus: 'valid' | 'warning' | 'reject',
  confidence: number,
  failingChecks: ValidationCheck[],
  rootPath: string,
): FileDiffEntry {
  const absPath = path.resolve(rootPath, proposal.path);

  const contents = reconstructChangeContent(proposal, absPath);
  if ('error' in contents) {
    return {
      proposalId,
      filePath: proposal.path,
      operation: proposal.operation,
      format: proposal.format,
      validationStatus,
      confidence,
      diffText: null,
      buildError: contents.error,
      failingChecks,
    };
  }

  const { oldContent, newContent } = contents;
  const diffText =
    oldContent === newContent
      ? '(sin cambios de contenido detectables entre lo propuesto y el archivo real)\n'
      : createTwoFilesPatch(proposal.path, proposal.path, oldContent, newContent, undefined, undefined, {
          context: 3,
        });

  return {
    proposalId,
    filePath: proposal.path,
    operation: proposal.operation,
    format: proposal.format,
    validationStatus,
    confidence,
    diffText,
    buildError: null,
    failingChecks,
  };
}

export interface ComputeDiffParams {
  rawPath: string; // ruta del proyecto
  contextPackId?: string; // por defecto, el Context Pack más reciente
}

/** `devpilot diff` (ver 07): reconstruye y muestra el diff real de cada propuesta ya importada contra el estado actual del archivo. Los `valid` se muestran listos para aplicar, los `warning` como decisión pendiente, los `reject` se explican pero no se ofrecen — nunca toca disco. */
export async function computeDiff(params: ComputeDiffParams): Promise<DiffResult> {
  const rootPath = path.resolve(params.rawPath);

  const registryDb = openGlobalRegistryDb();
  let project;
  try {
    project = findProjectByRootPath(registryDb, rootPath);
  } finally {
    registryDb.close();
  }
  if (!project) {
    throw new Error(`Este proyecto no está registrado todavía. Corre \`devpilot project add ${params.rawPath}\` primero.`);
  }

  const projectDb = openProjectDb(rootPath);
  let contextPackRow;
  let proposalRows;
  try {
    contextPackRow = params.contextPackId
      ? getContextPackById(projectDb, params.contextPackId)
      : getLatestContextPack(projectDb);
    if (!contextPackRow) {
      throw new Error(
        'No hay ningún Context Pack generado todavía para este proyecto. Corre `devpilot context "<tarea>"` primero.',
      );
    }
    proposalRows = listFileChangeProposalsByContextPack(projectDb, contextPackRow.id);
  } finally {
    projectDb.close();
  }

  const entries: FileDiffEntry[] = [];
  for (const row of proposalRows) {
    if (!row.proposalPath) {
      // Fila insertada antes de que `devpilot import` empezara a persistir
      // el contenido completo (ver ensureFileChangeProposalPathColumn en
      // connection.ts) — se señala en vez de fallar todo el comando.
      entries.push({
        proposalId: row.id,
        filePath: row.filePath,
        operation: row.operation,
        format: row.formatDetected,
        validationStatus: row.validationStatus as 'valid' | 'warning' | 'reject',
        confidence: row.confidenceScore,
        diffText: null,
        buildError:
          'Esta propuesta se importó con una versión anterior de DevPilot que no guardaba el contenido completo — vuelve a correr `devpilot import` para poder ver su diff.',
        failingChecks: [],
      });
      continue;
    }

    // row.proposalPath es relativo a rootPath (ver fileChangeProposalRepo.ts
    // / importService.ts) — se resuelve contra el rootPath actual. Filas de
    // antes de ese fix pueden traer una ruta absoluta obsoleta (de otra
    // sesión/otro punto de montaje); `path.resolve` con un segundo
    // argumento absoluto simplemente lo devuelve tal cual, así que en ese
    // caso la lectura falla igual que si el archivo no existiera — se
    // captura y se explica en vez de tumbar todo el comando.
    const proposalAbsPath = path.resolve(rootPath, row.proposalPath);
    try {
      const { proposal, validation } = await readChangeProposalFile(proposalAbsPath);
      const failingChecks = validation.checks.filter((c) => !c.passed);
      entries.push(
        buildDiffEntry(row.id, proposal, validation.status, validation.confidence, failingChecks, rootPath),
      );
    } catch (err) {
      entries.push({
        proposalId: row.id,
        filePath: row.filePath,
        operation: row.operation,
        format: row.formatDetected,
        validationStatus: row.validationStatus as 'valid' | 'warning' | 'reject',
        confidence: row.confidenceScore,
        diffText: null,
        buildError: `No se pudo leer el contenido persistido de esta propuesta (${proposalAbsPath}): ${(err as Error).message}. Vuelve a correr \`devpilot import\` para regenerarla.`,
        failingChecks: [],
      });
    }
  }

  logger.debug('diff calculado', entries.length, 'propuesta(s), contextPack:', contextPackRow.id);

  return { contextPackId: contextPackRow.id, entries };
}
