import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { createLogger } from '@devpilot/shared';
import {
  findProjectByRootPath,
  getContextPackById,
  getLatestContextPack,
  insertToolInvocation,
  listFileChangeProposalsByContextPack,
  markFileChangeProposalApplied,
  openGlobalRegistryDb,
  openProjectDb,
  readChangeProposalFile,
} from '@devpilot/storage';
import { reconstructChangeContent } from './changeReconstruction.js';
import { evaluatePermission, toolNameForOperation } from '../tools/permissionGuard.js';
import type { RiskLevel, ToolName } from '../tools/permissionGuard.js';

const logger = createLogger('core:apply');

// ApplyService — última pieza de la cadena del roadmap (07): "... → Diff →
// Apply". Es la primera vez que DevPilot escribe algo en el disco del
// usuario, así que pasa por el Tool Engine (05): PermissionGuard/PathGuard
// deciden el riesgo, el CLI es quien de verdad pregunta "y/N" (esto es
// core, agnóstico de UI — solo expone el plan y una función para ejecutar
// una decisión ya tomada), y cada intento — se apruebe o no — queda
// registrado en `tool_invocations`.

export type ApplyEligibility =
  | 'eligible'
  | 'skipped-reject'
  | 'skipped-already-applied'
  | 'skipped-warning-not-included'
  | 'skipped-not-selected';

export interface ApplyPlanEntry {
  proposalId: string;
  filePath: string;
  operation: string;
  format: string;
  validationStatus: 'valid' | 'warning' | 'reject';
  confidence: number;
  eligibility: ApplyEligibility;
  toolName: ToolName;
  riskLevel: RiskLevel;
  /** Motivo de PathGuard (05) — presente solo si la ruta cae fuera del proyecto (no debería pasar nunca en la práctica, ver permissionGuard.ts). */
  pathGuardReason?: string;
  /** Diff que resultaría de aplicar el cambio, para mostrar antes de pedir confirmación. `null` si no se pudo reconstruir (ver `buildError`) o si no es elegible. */
  diffText: string | null;
  buildError: string | null;
  absPath: string;
  /** Contenido final que se escribiría (o `''` para `delete`, donde no se usa). `null` si no elegible o si hubo `buildError`. */
  newContent: string | null;
}

export interface BuildApplyPlanParams {
  rawPath: string;
  contextPackId?: string;
  /** Por defecto `devpilot apply` solo toca `valid` — un `warning` necesita que el usuario lo resuelva explícitamente (07: "cambios valid o warning ya resueltos por el usuario"). */
  includeWarnings: boolean;
  /** Aplica exactamente una propuesta por id, sin importar `includeWarnings` (pero `reject` sigue bloqueado siempre). */
  onlyProposalId?: string;
}

export interface ApplyPlan {
  rootPath: string;
  contextPackId: string;
  entries: ApplyPlanEntry[];
}

function skeletonEntry(
  row: { id: string; filePath: string; operation: string; formatDetected: string; validationStatus: string; confidenceScore: number },
  eligibility: ApplyEligibility,
  buildError: string | null = null,
): ApplyPlanEntry {
  return {
    proposalId: row.id,
    filePath: row.filePath,
    operation: row.operation,
    format: row.formatDetected,
    validationStatus: row.validationStatus as 'valid' | 'warning' | 'reject',
    confidence: row.confidenceScore,
    eligibility,
    toolName: toolNameForOperation(row.operation),
    riskLevel: row.operation === 'delete' ? 'delete' : 'write',
    diffText: null,
    buildError,
    absPath: '',
    newContent: null,
  };
}

/** Arma el plan de aplicación: qué propuestas son elegibles, cuáles se saltan y por qué, y el diff/contenido reconstruido para cada una elegible. Nunca toca disco. */
export async function buildApplyPlan(params: BuildApplyPlanParams): Promise<ApplyPlan> {
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

  const entries: ApplyPlanEntry[] = [];
  for (const row of proposalRows) {
    if (params.onlyProposalId && row.id !== params.onlyProposalId) {
      entries.push(skeletonEntry(row, 'skipped-not-selected'));
      continue;
    }
    if (row.applied) {
      entries.push(skeletonEntry(row, 'skipped-already-applied'));
      continue;
    }
    // reject nunca se ofrece, ni siquiera con --only (05/07: "los reject se
    // explican y no se ofrecen para aplicar" — devpilot diff ya explica por
    // qué; devpilot apply solo refuerza que no hay forma de forzarlo).
    if (row.validationStatus === 'reject') {
      entries.push(skeletonEntry(row, 'skipped-reject'));
      continue;
    }
    if (row.validationStatus === 'warning' && !params.includeWarnings && !params.onlyProposalId) {
      entries.push(skeletonEntry(row, 'skipped-warning-not-included'));
      continue;
    }

    if (!row.proposalPath) {
      entries.push(
        skeletonEntry(
          row,
          'eligible',
          'Esta propuesta se importó con una versión anterior de DevPilot que no guardaba el contenido completo — vuelve a correr `devpilot import` para poder aplicarla.',
        ),
      );
      continue;
    }

    const proposalAbsPath = path.resolve(rootPath, row.proposalPath);
    try {
      const { proposal } = await readChangeProposalFile(proposalAbsPath);
      const absPath = path.resolve(rootPath, proposal.path);
      const toolName = toolNameForOperation(proposal.operation);
      const permission = evaluatePermission(toolName, absPath, rootPath);
      const contents = reconstructChangeContent(proposal, absPath);

      if ('error' in contents) {
        entries.push({
          ...skeletonEntry(row, 'eligible', contents.error),
          toolName,
          riskLevel: permission.riskLevel,
          pathGuardReason: permission.reason,
          absPath,
        });
        continue;
      }

      const diffText =
        contents.oldContent === contents.newContent
          ? '(sin cambios de contenido detectables)\n'
          : createTwoFilesPatch(proposal.path, proposal.path, contents.oldContent, contents.newContent, undefined, undefined, {
              context: 3,
            });

      entries.push({
        proposalId: row.id,
        filePath: proposal.path,
        operation: proposal.operation,
        format: proposal.format,
        validationStatus: row.validationStatus as 'valid' | 'warning' | 'reject',
        confidence: row.confidenceScore,
        eligibility: 'eligible',
        toolName,
        riskLevel: permission.riskLevel,
        pathGuardReason: permission.reason,
        diffText,
        buildError: null,
        absPath,
        newContent: contents.newContent,
      });
    } catch (err) {
      entries.push(
        skeletonEntry(
          row,
          'eligible',
          `No se pudo leer el contenido persistido de esta propuesta (${proposalAbsPath}): ${(err as Error).message}. Vuelve a correr \`devpilot import\` para regenerarla.`,
        ),
      );
    }
  }

  logger.debug('plan de apply armado', entries.length, 'entrada(s), contextPack:', contextPackRow.id);

  return { rootPath, contextPackId: contextPackRow.id, entries };
}

export interface ApplyChangeOutcome {
  approved: boolean;
  ok: boolean;
  resultSummary: string;
}

/**
 * Ejecuta (o registra el rechazo de) una entrada ya decidida por el
 * usuario — la decisión de aprobar o no se toma en el CLI (05: "el CLI...
 * presenta al usuario el diff/comando exacto y espera confirmación"), esta
 * función es la que de verdad toca disco cuando corresponde, y la que dej
 * la auditoría en `tool_invocations` (05) pase lo que pase.
 */
export async function applyChange(rootPath: string, entry: ApplyPlanEntry, approved: boolean): Promise<ApplyChangeOutcome> {
  const projectDb = openProjectDb(rootPath);
  try {
    const now = new Date().toISOString();
    const paramsJson = JSON.stringify({ path: entry.filePath, operation: entry.operation, format: entry.format });

    if (!approved) {
      insertToolInvocation(projectDb, {
        id: randomUUID(),
        sessionId: null,
        toolName: entry.toolName,
        riskLevel: entry.riskLevel,
        paramsJson,
        approved: false,
        approvedAt: null,
        resultSummary: 'El usuario no aprobó este cambio.',
        createdAt: now,
      });
      return { approved: false, ok: false, resultSummary: 'rechazado por el usuario' };
    }

    // PathGuard, defensa en profundidad (05) — se re-evalúa aquí mismo,
    // justo antes de escribir, no solo al armar el plan.
    const resolvedRoot = path.resolve(rootPath);
    if (entry.absPath !== resolvedRoot && !entry.absPath.startsWith(resolvedRoot + path.sep)) {
      const resultSummary = `PathGuard rechazó la escritura: ${entry.absPath} cae fuera del proyecto.`;
      insertToolInvocation(projectDb, {
        id: randomUUID(),
        sessionId: null,
        toolName: entry.toolName,
        riskLevel: entry.riskLevel,
        paramsJson,
        approved: true,
        approvedAt: now,
        resultSummary,
        createdAt: now,
      });
      return { approved: true, ok: false, resultSummary };
    }

    let resultSummary: string;
    try {
      switch (entry.operation) {
        case 'create':
        case 'edit':
        case 'patch': {
          if (entry.newContent === null) {
            throw new Error('No hay contenido reconstruido para escribir (revisa buildError).');
          }
          await mkdir(path.dirname(entry.absPath), { recursive: true });
          await writeFile(entry.absPath, entry.newContent, 'utf8');
          resultSummary = `Escrito ${Buffer.byteLength(entry.newContent, 'utf8')} bytes en ${entry.filePath}.`;
          break;
        }
        case 'delete': {
          await unlink(entry.absPath);
          resultSummary = `Borrado ${entry.filePath}.`;
          break;
        }
        default:
          throw new Error(`Operación desconocida: ${entry.operation}`);
      }
    } catch (err) {
      const failSummary = `Error al escribir: ${(err as Error).message}`;
      insertToolInvocation(projectDb, {
        id: randomUUID(),
        sessionId: null,
        toolName: entry.toolName,
        riskLevel: entry.riskLevel,
        paramsJson,
        approved: true,
        approvedAt: now,
        resultSummary: failSummary,
        createdAt: now,
      });
      return { approved: true, ok: false, resultSummary: failSummary };
    }

    insertToolInvocation(projectDb, {
      id: randomUUID(),
      sessionId: null,
      toolName: entry.toolName,
      riskLevel: entry.riskLevel,
      paramsJson,
      approved: true,
      approvedAt: now,
      resultSummary,
      createdAt: now,
    });
    markFileChangeProposalApplied(projectDb, entry.proposalId);

    return { approved: true, ok: true, resultSummary };
  } finally {
    projectDb.close();
  }
}
