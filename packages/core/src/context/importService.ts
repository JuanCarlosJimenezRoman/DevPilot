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
  insertFileChangeProposal,
  openGlobalRegistryDb,
  openProjectDb,
} from '@devpilot/storage';
import { parseAiResponse } from './changeParser.js';
import { validateChange } from './changeValidator.js';

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

  const packJsonRaw = await readFile(contextPackRow.jsonPath, 'utf8');
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

      insertFileChangeProposal(projectDb2, {
        id: randomUUID(),
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
        createdAt: now,
      });
    }
  } finally {
    projectDb2.close();
  }

  logger.debug('import procesado', changes.length, 'cambio(s), contextPack:', contextPackRow.id);

  return {
    contextPackId: contextPackRow.id,
    changes,
    assumedDecisions: parsed.assumedDecisions,
    unparsedNotes: parsed.unparsedNotes,
  };
}
