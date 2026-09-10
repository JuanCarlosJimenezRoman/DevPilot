import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@devpilot/shared';
import type { ContextPack, FileChangeProposal, ValidationResult } from '@devpilot/shared';
import {
  findProjectByRootPath,
  getContextPackById,
  getLatestContextPack,
  getTaskBenchmarkByContextPackId,
  insertFileChangeProposal,
  listFileChangeProposalsByContextPack,
  openGlobalRegistryDb,
  openProjectDb,
  updateTaskBenchmarkAfterImport,
  writeChangeProposalFile,
} from '@devpilot/storage';
import { parseAiResponse } from './changeParser.js';
import { validateChange } from './changeValidator.js';
import { logSessionEvent } from '../sessions/sessionEventLogger.js';

const logger = createLogger('core:import');

export interface ImportedChange {
  proposal: FileChangeProposal;
  validation: ValidationResult;
}

export interface ImportResult {
  contextPackId: string;
  changes: ImportedChange[];
  assumedDecisions: string[];
  unparsedNotes: string;
}

async function readRawResponse(rawPathOrText: string): Promise<string> {
  // "archivo-o-texto" (ver 07): si resuelve a un archivo real, se lee su
  // contenido; si no, se trata el argumento mismo como el texto pegado.
  try {
    if (existsSync(rawPathOrText) && statSync(rawPathOrText).isFile()) {
      return readFile(rawPathOrText, 'utf8');
    }
  } catch {
    // sigue como texto literal
  }
  return rawPathOrText;
}

export interface ImportChangesParams {
  rawPath: string; // ruta del proyecto
  input: string; // archivo con la respuesta pegada, o el texto mismo
  contextPackId?: string; // por defecto, el Context Pack más reciente del proyecto
}

/** `devpilot import <archivo-o-texto>` (ver 07): Parser (Capa 2) → Validator (Capa 3) sobre la respuesta cruda de una IA, contra el Context Pack más reciente (o uno específico). Persiste cada propuesta evaluada — nunca aplica nada. */
export async function importChanges(params: ImportChangesParams): Promise<ImportResult> {
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
  try {
    contextPackRow = params.contextPackId
      ? getContextPackById(projectDb, params.contextPackId)
      : getLatestContextPack(projectDb);
  } finally {
    projectDb.close();
  }
  if (!contextPackRow) {
    throw new Error(
      'No hay ningún Context Pack generado todavía para este proyecto. Corre `devpilot context "<tarea>"` primero.',
    );
  }

  // contextPackRow.jsonPath es relativo a rootPath (ver contextService.ts y
  // contextPackRepo.ts) — se resuelve contra el rootPath actual, no el que
  // haya tenido el proceso que generó el pack.
  const packJsonAbsPath = path.resolve(rootPath, contextPackRow.jsonPath);
  let packJsonRaw: string;
  try {
    packJsonRaw = await readFile(packJsonAbsPath, 'utf8');
  } catch (err) {
    throw new Error(
      `No se pudo leer el Context Pack (${contextPackRow.id}) en ${packJsonAbsPath}: ${(err as Error).message}. Vuelve a correr \`devpilot context\` si el archivo ya no existe.`,
    );
  }
  const contextPack = JSON.parse(packJsonRaw) as ContextPack;

  const raw = await readRawResponse(params.input);
  const parsed = parseAiResponse(raw, rootPath);

  const changes: ImportedChange[] = parsed.changes.map((proposal) => ({
    proposal,
    validation: validateChange(proposal, rootPath, contextPack),
  }));

  const projectDb2 = openProjectDb(rootPath);
  try {
    const now = new Date().toISOString();
    for (const { proposal, validation } of changes) {
      const searchCheck = validation.checks.find((c) => c.name === 'search-match');
      const markerCheck = validation.checks.find((c) => c.name === 'marker-well-formed');
      const undocumentedCheck = validation.checks.find((c) => c.name === 'undocumented-decision');

      // El contenido real de la propuesta (newContent/diff/patch) no cabe
      // como columna consultable (03) — se persiste aparte (ver
      // changeProposalStore.ts) porque `devpilot diff`/`devpilot apply`
      // necesitan reconstruirlo, y la respuesta cruda de la IA en sí no se
      // guarda en ningún otro lado.
      const proposalId = randomUUID();
      const proposalAbsPath = await writeChangeProposalFile(rootPath, proposalId, { proposal, validation });
      // Mismo motivo que contextService.ts: se guarda relativo a rootPath,
      // nunca absoluto (portabilidad — 03).
      const proposalPath = path.relative(rootPath, proposalAbsPath);

      insertFileChangeProposal(projectDb2, {
        id: proposalId,
        contextPackId: contextPackRow.id,
        filePath: proposal.path,
        operation: proposal.operation,
        formatDetected: proposal.format,
        validationStatus: validation.status,
        confidenceScore: validation.confidence,
        validationChecksJson: JSON.stringify(validation.checks),
        searchMatched: searchCheck ? searchCheck.passed : null,
        searchMatchStrategy: proposal.patch
          ? proposal.patch.markerOrigin === 'markers'
            ? markerCheck?.passed
              ? 'exact'
              : 'dedented'
            : 'recovered-prefix'
          : null,
        hasUndocumentedDecision: undocumentedCheck ? !undocumentedCheck.passed : false,
        proposalPath,
        createdAt: now,
      });
    }

    // Benchmark automático por tarea (ver contextService.ts para la fila
    // inicial): acá se conoce por primera vez el tamaño de la respuesta
    // cruda de la IA y cuántos cambios se importaron. `changesImported` se
    // recalcula sobre TODAS las propuestas del pack (no solo las de esta
    // corrida) para que quede correcto incluso si `devpilot import` se
    // corre más de una vez contra el mismo Context Pack.
    const benchmark = getTaskBenchmarkByContextPackId(projectDb2, contextPackRow.id);
    if (benchmark) {
      const totalProposals = listFileChangeProposalsByContextPack(projectDb2, contextPackRow.id).length;
      updateTaskBenchmarkAfterImport(projectDb2, benchmark.id, {
        responseSizeChars: raw.length,
        changesImported: totalProposals,
      });
    } else {
      // No debería pasar con un Context Pack generado por una versión
      // actual de `devpilot context` — solo ocurre con packs de antes de
      // que existiera el benchmark automático. No es un error: simplemente
      // no hay fila que actualizar.
      logger.debug('sin fila de benchmark para este Context Pack (pack generado antes del benchmark automático):', contextPackRow.id);
    }
  } finally {
    projectDb2.close();
  }

  logger.debug('import procesado', changes.length, 'cambio(s), contextPack:', contextPackRow.id);

  await logSessionEvent(rootPath, 'import', {
    contextPackId: contextPackRow.id,
    changesCount: changes.length,
    byStatus: {
      valid: changes.filter((c) => c.validation.status === 'valid').length,
      warning: changes.filter((c) => c.validation.status === 'warning').length,
      reject: changes.filter((c) => c.validation.status === 'reject').length,
    },
  });

  return {
    contextPackId: contextPackRow.id,
    changes,
    assumedDecisions: parsed.assumedDecisions,
    unparsedNotes: parsed.unparsedNotes,
  };
}
