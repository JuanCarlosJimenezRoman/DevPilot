import { existsSync, statSync } from 'node:fs';
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
import { safeReadTextFile } from './fileReading.js';
import { findDedentTolerantMatch } from './matching.js';

const logger = createLogger('core:diff');

// DiffService — la pieza que sigue a `devpilot import` en la cadena del
// roadmap (07): "Proyecto → Contexto → IA web → Respuesta → Import → Diff
// → Apply". `devpilot import` clasifica pero nunca aplica; `devpilot diff`
// muestra qué cambiaría realmente en disco si se aplicara cada propuesta —
// sigue sin tocar nada, es pura lectura — para que el usuario decida antes
// de que exista `devpilot apply` (que sí necesitará Tool Engine, ver 05).

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/**
 * Reconstruye `{ oldContent, newContent }` según la operación de la
 * propuesta, o un mensaje de error legible si no se puede (archivo
 * inexistente para edit/delete/patch, SEARCH que ya no matchea, etc.).
 * Deliberadamente reutiliza la misma tolerancia de matching que el
 * `ChangeValidator` (`findDedentTolerantMatch`, ver matching.ts) — un
 * patch que pasó `search-match` en `devpilot import` debe seguir
 * pudiéndose reconstruir aquí sin volver a decidir si "coincide".
 */
function reconstructContents(
  proposal: FileChangeProposal,
  absPath: string,
): { oldContent: string; newContent: string } | { error: string } {
  const exists = existsSync(absPath) && statSync(absPath).isFile();
  let oldContent = '';
  if (exists) {
    const read = safeReadTextFile(absPath);
    if (read === null) {
      return { error: 'No se pudo leer el archivo real (¿binario o demasiado grande?) para construir el diff.' };
    }
    oldContent = normalizeNewlines(read);
  }

  switch (proposal.operation) {
    case 'create':
      return { oldContent, newContent: normalizeNewlines(proposal.newContent ?? '') };

    case 'delete':
      if (!exists) return { error: 'El archivo ya no existe — nada que borrar.' };
      return { oldContent, newContent: '' };

    case 'patch': {
      if (!proposal.patch) return { error: 'No hay un bloque SEARCH/REPLACE reconocible en esta propuesta.' };
      if (!exists) return { error: 'El archivo no existe — no hay contra qué aplicar el patch.' };
      const match = findDedentTolerantMatch(proposal.patch.search, oldContent);
      if (!match) {
        return {
          error:
            'El fragmento SEARCH no se ubica en el contenido actual del archivo (coincide con `search-match` en `devpilot import` — probablemente el archivo cambió desde entonces).',
        };
      }
      const newContent =
        oldContent.slice(0, match.start) + normalizeNewlines(proposal.patch.replace) + oldContent.slice(match.end);
      return { oldContent, newContent };
    }

    case 'edit':
    default: {
      // formatos de archivo completo: 'devpilot-block', 'markdown-file', 'fence-only'.
      // ('diff' se maneja aparte en buildDiffEntry — ya es un diff, no hay nada que reconstruir.)
      if (proposal.newContent === undefined) {
        return { error: 'No hay contenido nuevo para comparar contra el archivo real.' };
      }
      return { oldContent, newContent: normalizeNewlines(proposal.newContent) };
    }
  }
}

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

  // format='diff': la propia respuesta de la IA ya trae un diff unificado
  // (ver changeParser.ts, extractMarkdownFileBlocks) — no hay
  // oldContent/newContent que reconstruir línea a línea, se muestra tal
  // cual, solo reetiquetado. Nota: a diferencia de los demás formatos,
  // el ChangeValidator (06) no tiene hoy un check que compare este diff
  // contra el archivo real (ni search-match ni whole-file-boundary-match
  // aplican a `operation='edit', format='diff'`) — es una superficie sin
  // cubrir, documentada aquí y en 07 como candidato a revisar antes de
  // que exista `devpilot apply` para este formato específico.
  if (proposal.operation === 'edit' && proposal.format === 'diff' && proposal.diff) {
    return {
      proposalId,
      filePath: proposal.path,
      operation: proposal.operation,
      format: proposal.format,
      validationStatus,
      confidence,
      diffText: proposal.diff.trimEnd() + '\n',
      buildError: null,
      failingChecks,
    };
  }

  const contents = reconstructContents(proposal, absPath);
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
