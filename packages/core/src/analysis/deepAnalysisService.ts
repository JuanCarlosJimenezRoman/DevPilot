import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import type { Project } from '@devpilot/shared';
import type { DecisionRow, KnowledgeDocRow } from '@devpilot/storage';
import {
  findProjectByRootPath,
  getKnowledgeDocById,
  getProjectState,
  hashKnowledgeContent,
  insertToolInvocation,
  listDecisions,
  listKnowledgeDocs,
  openGlobalRegistryDb,
  openProjectDb,
  readKnowledgeFile,
  upsertKnowledgeDoc,
  upsertProjectState,
  writeKnowledgeFile,
} from '@devpilot/storage';
import { createGitAdapter } from '../project/gitAdapter.js';
import { createClaudeCodeProvider, type ClaudeCodeProvider, type RunAnalysisOutcome } from '../providers/claudeCodeProvider.js';
import { buildDeepAnalysisPrompt } from './deepAnalysisPrompt.js';
import { parseDeepAnalysisResponse, type DecisionProposal, type KnowledgeProposal } from './deepAnalysisParser.js';
import { CANONICAL_TITLES, slugify } from '../knowledge/knowledgeService.js';
import { createDecision } from '../decisions/decisionService.js';
import { evaluatePermission } from '../tools/permissionGuard.js';
import { getActiveSessionId, logSessionEvent } from '../sessions/sessionEventLogger.js';

// DeepAnalysisService — Incremento 4 ("Claude Code", ver 07):
// `devpilot analyze --deep` → ClaudeCodeProvider en modo solo lectura/plan →
// propone contenido para `knowledge_docs` (y decisiones detectadas) → el
// usuario aprueba el diff antes de escribir (mismo flujo de aprobación del
// Tool Engine, 05) → `lastDeepAnalysisCommit` se actualiza al terminar.
//
// A diferencia de `devpilot import`/`devpilot apply` (dos comandos
// separados: uno que parsea y persiste propuestas, otro que las aplica),
// esta pieza es UN solo comando de punta a punta — mismo patrón que
// `devpilot apply` en sí mismo, que arma su plan (`buildApplyPlan`) y
// pregunta y/N por cada entrada dentro de la misma corrida
// (`applyService.ts`). No hay una "asincronía" real que justificar acá
// (a diferencia de `import`, pensado para pegar una respuesta de un chat
// web horas después de generar el Context Pack): `analyze --deep` es
// DevPilot invocando a Claude Code síncronamente, así que tiene más
// sentido resolver todo en una sola corrida.

function resolveProjectOrThrow(rootPath: string): Project {
  const registryDb = openGlobalRegistryDb();
  try {
    const project = findProjectByRootPath(registryDb, rootPath);
    if (!project) {
      throw new Error(`Este proyecto no está registrado todavía. Corre \`devpilot project add ${rootPath}\` primero.`);
    }
    return project;
  } finally {
    registryDb.close();
  }
}

export type KnowledgeEntryEligibility = 'eligible' | 'skipped-manual' | 'skipped-unchanged' | 'skipped-invalid';

export interface KnowledgeAnalysisEntry {
  /** Id resuelto del knowledge doc (== type para los 5 canónicos; `custom-<slug>` para "custom" — mismo criterio que `setManualKnowledge`, ver knowledgeService.ts). */
  id: string;
  type: string;
  title: string;
  proposedContent: string;
  existingContent: string | null;
  existingSource: string | null;
  eligibility: KnowledgeEntryEligibility;
  /** Motivo legible cuando `eligibility !== 'eligible'`. */
  skipReason?: string;
  /** `null` si no es elegible. */
  diffText: string | null;
}

export interface DecisionAnalysisEntry {
  proposal: DecisionProposal;
}

export interface DeepAnalysisPlan {
  rootPath: string;
  projectId: string;
  currentCommit: string | null;
  previousDeepAnalysisCommit: string | null;
  knowledgeEntries: KnowledgeAnalysisEntry[];
  decisionEntries: DecisionAnalysisEntry[];
  unparsedNotes: string;
}

export interface DeepAnalysisNotAvailable {
  ok: false;
  kind: 'not-available' | 'rejected' | 'timeout' | 'unparsable-output';
  message: string;
  raw?: string;
}

export type DeepAnalysisRunOutcome = ({ ok: true } & DeepAnalysisPlan) | DeepAnalysisNotAvailable;

function resolveKnowledgeId(proposal: KnowledgeProposal): { id: string; title: string } {
  if (proposal.type === 'custom') {
    // `title` ya está garantizado presente para "custom" por el parser
    // (deepAnalysisParser.ts descarta como no reconocido un bloque
    // "custom" sin title) — el `as string` es seguro acá.
    const title = proposal.title as string;
    return { id: `custom-${slugify(title)}`, title };
  }
  return { id: proposal.type, title: proposal.title ?? CANONICAL_TITLES[proposal.type] };
}

/**
 * Arma el plan de análisis profundo: invoca a Claude Code, parsea la
 * respuesta, y para cada propuesta de knowledge doc decide si es elegible
 * (nunca toca un doc `manual`, mismo principio que `generateInferredKnowledge`
 * en knowledgeService.ts) y arma el diff contra el contenido actual. Nunca
 * escribe nada a disco — eso lo hacen `applyKnowledgeEntry`/
 * `applyDecisionEntry` de más abajo, una vez que el usuario aprobó cada
 * entrada (mismo split que `buildApplyPlan`/`applyChange` en
 * applyService.ts).
 */
export async function runDeepAnalysis(
  rawPath: string,
  opts: { provider?: ClaudeCodeProvider; timeoutMs?: number } = {},
): Promise<DeepAnalysisRunOutcome> {
  const rootPath = path.resolve(rawPath);
  const project = resolveProjectOrThrow(rootPath);

  const provider = opts.provider ?? createClaudeCodeProvider();
  const availability = await provider.isAvailable();
  if (!availability.available) {
    return {
      ok: false,
      kind: 'not-available',
      message: `Claude Code no está disponible: ${availability.reason ?? 'motivo desconocido'}`,
    };
  }

  const git = createGitAdapter(rootPath);
  const currentCommit = await git.currentCommit();

  const projectDb = openProjectDb(rootPath);
  let existingKnowledge: KnowledgeDocRow[];
  let existingDecisions: DecisionRow[];
  let previousDeepAnalysisCommit: string | null;
  try {
    existingKnowledge = listKnowledgeDocs(projectDb);
    existingDecisions = listDecisions(projectDb);
    previousDeepAnalysisCommit = getProjectState(projectDb, project.id)?.lastDeepAnalysisCommit ?? null;
  } finally {
    projectDb.close();
  }

  let changedFilesSinceLastAnalysis: string[] | null = null;
  if (previousDeepAnalysisCommit && currentCommit && previousDeepAnalysisCommit !== currentCommit) {
    // Nivel 4 (relevancePlanner.ts) ya usa el mismo `GitAdapter.diff` para
    // acotar qué mirar primero sin recorrer todo el árbol — mismo
    // principio acá: una pista, no una restricción real (el prompt deja
    // explícito que Claude Code puede explorar más allá de esta lista).
    const diff = await git.diff({ from: previousDeepAnalysisCommit, to: currentCommit });
    changedFilesSinceLastAnalysis = diff.files.map((f) => f.path);
  }

  const prompt = buildDeepAnalysisPrompt({
    project,
    existingKnowledge: existingKnowledge.map((k) => ({ type: k.type, title: k.title, source: k.source })),
    existingDecisions: existingDecisions.filter((d) => d.status !== 'superseded').map((d) => ({ title: d.title })),
    lastDeepAnalysisCommit: previousDeepAnalysisCommit,
    changedFilesSinceLastAnalysis,
  });

  const result: RunAnalysisOutcome = await provider.runDeepAnalysis(prompt, { cwd: rootPath, timeoutMs: opts.timeoutMs });
  if (!result.ok) {
    return { ok: false, kind: result.kind, message: result.message, raw: result.raw };
  }

  const parsed = parseDeepAnalysisResponse(result.text);

  const knowledgeEntries: KnowledgeAnalysisEntry[] = [];
  const projectDb2 = openProjectDb(rootPath);
  try {
    for (const proposal of parsed.knowledgeProposals) {
      const { id, title } = resolveKnowledgeId(proposal);
      const existing = getKnowledgeDocById(projectDb2, id);
      const existingContent = existing ? await readKnowledgeFile(rootPath, id) : null;

      if (existing && existing.source === 'manual') {
        knowledgeEntries.push({
          id,
          type: proposal.type,
          title,
          proposedContent: proposal.content,
          existingContent,
          existingSource: existing.source,
          eligibility: 'skipped-manual',
          skipReason: 'Este documento fue editado a mano (`devpilot knowledge edit`) — un análisis profundo nunca lo sobreescribe (ver 04).',
          diffText: null,
        });
        continue;
      }

      if (existing && existingContent !== null && hashKnowledgeContent(existingContent) === hashKnowledgeContent(proposal.content)) {
        knowledgeEntries.push({
          id,
          type: proposal.type,
          title,
          proposedContent: proposal.content,
          existingContent,
          existingSource: existing.source,
          eligibility: 'skipped-unchanged',
          skipReason: 'El contenido propuesto es idéntico al que ya existe — nada que aprobar.',
          diffText: null,
        });
        continue;
      }

      const diffText = createTwoFilesPatch(
        `${id}.md`,
        `${id}.md`,
        existingContent ?? '',
        proposal.content,
        undefined,
        undefined,
        { context: 3 },
      );

      knowledgeEntries.push({
        id,
        type: proposal.type,
        title,
        proposedContent: proposal.content,
        existingContent,
        existingSource: existing?.source ?? null,
        eligibility: 'eligible',
        diffText,
      });
    }
  } finally {
    projectDb2.close();
  }

  const decisionEntries: DecisionAnalysisEntry[] = parsed.decisionProposals.map((proposal) => ({ proposal }));

  return {
    ok: true,
    rootPath,
    projectId: project.id,
    currentCommit,
    previousDeepAnalysisCommit,
    knowledgeEntries,
    decisionEntries,
    unparsedNotes: parsed.unparsedNotes,
  };
}

export interface ApplyKnowledgeEntryOutcome {
  approved: boolean;
  ok: boolean;
  resultSummary: string;
}

/**
 * Escribe (o no) una entrada de knowledge doc ya decidida por el usuario —
 * mismo split responsabilidad/aprobación que `applyChange` en
 * applyService.ts: el approve/reject se decide en el CLI, esta función
 * ejecuta y deja la auditoría en `tool_invocations` (05) pase lo que pase.
 * Nunca se llama con una entrada `eligibility !== 'eligible'`.
 */
export async function applyKnowledgeEntry(
  rootPath: string,
  entry: KnowledgeAnalysisEntry,
  approved: boolean,
): Promise<ApplyKnowledgeEntryOutcome> {
  const projectDb = openProjectDb(rootPath);
  try {
    const now = new Date().toISOString();
    const toolName = entry.existingContent !== null ? 'edit_file' : 'create_file';
    const absPath = path.join(rootPath, '.devpilot', 'knowledge', `${entry.id}.md`);
    const permission = evaluatePermission(toolName, absPath, rootPath);
    const sessionId = getActiveSessionId(rootPath);
    const paramsJson = JSON.stringify({ id: entry.id, type: entry.type, title: entry.title, source: 'deep-analysis' });

    if (!approved) {
      insertToolInvocation(projectDb, {
        id: randomUUID(),
        sessionId,
        toolName,
        riskLevel: permission.riskLevel,
        paramsJson,
        approved: false,
        approvedAt: null,
        resultSummary: 'El usuario no aprobó este knowledge doc propuesto por `analyze --deep`.',
        createdAt: now,
      });
      return { approved: false, ok: false, resultSummary: 'rechazado por el usuario' };
    }

    let resultSummary: string;
    try {
      await writeKnowledgeFile(rootPath, entry.id, entry.proposedContent);
      const row: KnowledgeDocRow = {
        id: entry.id,
        type: entry.type,
        title: entry.title,
        path: path.join('.devpilot', 'knowledge', `${entry.id}.md`),
        contentHash: hashKnowledgeContent(entry.proposedContent),
        source: 'deep-analysis',
        updatedAt: now,
      };
      upsertKnowledgeDoc(projectDb, row);
      resultSummary = `Escrito ${Buffer.byteLength(entry.proposedContent, 'utf8')} bytes en .devpilot/knowledge/${entry.id}.md.`;
    } catch (err) {
      resultSummary = `Error al escribir: ${(err as Error).message}`;
      insertToolInvocation(projectDb, {
        id: randomUUID(),
        sessionId,
        toolName,
        riskLevel: permission.riskLevel,
        paramsJson,
        approved: true,
        approvedAt: now,
        resultSummary,
        createdAt: now,
      });
      return { approved: true, ok: false, resultSummary };
    }

    insertToolInvocation(projectDb, {
      id: randomUUID(),
      sessionId,
      toolName,
      riskLevel: permission.riskLevel,
      paramsJson,
      approved: true,
      approvedAt: now,
      resultSummary,
      createdAt: now,
    });

    return { approved: true, ok: true, resultSummary };
  } finally {
    projectDb.close();
  }
}

/** Crea una Decision Record real a partir de una propuesta ya aprobada por el usuario — reusa `createDecision` (decisionService.ts) tal cual, sin duplicar la escritura del espejo Markdown ni el insert en `decisions`. Devuelve la fila de storage (no `DecisionRecord` de dominio): quien llama ya tiene `rootPath`/`projectId` si los necesita, y `createDecision` ya devuelve todo lo demás. */
export async function applyDecisionEntry(rootPath: string, entry: DecisionAnalysisEntry): Promise<DecisionRow> {
  const { decision } = await createDecision({
    rawPath: rootPath,
    title: entry.proposal.title,
    context: entry.proposal.context,
    decisionText: entry.proposal.decision,
    consequences: entry.proposal.consequences,
    status: 'accepted',
  });
  return decision;
}

/**
 * Marca el análisis profundo como corrido hasta `currentCommit` — se llama
 * al final de `devpilot analyze --deep`, sin importar cuántas propuestas
 * haya aprobado el usuario (04: `lastDeepAnalysisCommit` es "efímero pero
 * necesario", como `lastIndexedCommit` — un hecho sobre qué tanto se
 * escaneó, no sobre qué tanto se aprobó). Solo se llama si la corrida
 * llegó a tener una respuesta real de Claude Code (nunca en un
 * `DeepAnalysisNotAvailable`) — si la invocación falló, un reintento debe
 * partir del mismo punto de referencia, no avanzarlo.
 */
export async function markDeepAnalysisCommit(rootPath: string, projectId: string, commit: string | null): Promise<void> {
  if (!commit) return; // proyecto sin git o sin commits todavía: no hay un valor real que guardar (mismo criterio que lastIndexedCommit en projectService.ts)
  const projectDb = openProjectDb(rootPath);
  try {
    const previousState = getProjectState(projectDb, projectId);
    upsertProjectState(projectDb, {
      projectId,
      lastIndexedCommit: previousState?.lastIndexedCommit ?? null,
      lastDeepAnalysisCommit: commit,
      lastScanAt: previousState?.lastScanAt ?? null,
      snapshotVersion: previousState?.snapshotVersion ?? 0,
      snapshotPath: previousState?.snapshotPath ?? null,
    });
  } finally {
    projectDb.close();
  }
}

/** Evento de Session Memory best-effort al cerrar una corrida de `analyze --deep` — mismo patrón que `apply`/`decision-created`/`knowledge-generated` (sessionEventLogger.ts). */
export async function logDeepAnalysisEvent(
  rootPath: string,
  summary: { knowledgeApplied: number; decisionsApplied: number; unparsedNotesLength: number },
): Promise<void> {
  await logSessionEvent(rootPath, 'deep-analysis', summary);
}
