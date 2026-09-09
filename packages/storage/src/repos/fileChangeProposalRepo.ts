import type { DatabaseSync } from 'node:sqlite';

// Repositorio sobre `<proyecto>/.devpilot/devpilot.db` (tabla
// `file_change_proposals`, ver 03) — auditable por diseño: qué detectó el
// ChangeParser, qué validó el ChangeValidator, y (más adelante, `devpilot
// apply`) qué se aplicó de verdad.

export interface FileChangeProposalRow {
  id: string;
  contextPackId: string;
  filePath: string;
  operation: string;
  formatDetected: string;
  validationStatus: string;
  confidenceScore: number;
  validationChecksJson: string;
  searchMatched: boolean | null;
  searchMatchStrategy: string | null;
  hasUndocumentedDecision: boolean;
  createdAt: string;
}

export function insertFileChangeProposal(db: DatabaseSync, row: FileChangeProposalRow): void {
  db.prepare(
    `INSERT INTO file_change_proposals
       (id, context_pack_id, file_path, operation, format_detected, validation_status,
        confidence_score, validation_checks_json, search_matched, search_match_strategy,
        has_undocumented_decision, applied, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  ).run(
    row.id,
    row.contextPackId,
    row.filePath,
    row.operation,
    row.formatDetected,
    row.validationStatus,
    row.confidenceScore,
    row.validationChecksJson,
    row.searchMatched === null ? null : row.searchMatched ? 1 : 0,
    row.searchMatchStrategy,
    row.hasUndocumentedDecision ? 1 : 0,
    row.createdAt,
  );
}

interface FileChangeProposalDbRow {
  id: string;
  context_pack_id: string | null;
  file_path: string;
  operation: string;
  format_detected: string;
  validation_status: string;
  confidence_score: number;
  validation_checks_json: string;
  search_matched: number | null;
  search_match_strategy: string | null;
  has_undocumented_decision: number;
  applied: number;
  created_at: string;
}

function rowToProposal(row: FileChangeProposalDbRow): FileChangeProposalRow & { applied: boolean } {
  return {
    id: row.id,
    contextPackId: row.context_pack_id ?? '',
    filePath: row.file_path,
    operation: row.operation,
    formatDetected: row.format_detected,
    validationStatus: row.validation_status,
    confidenceScore: row.confidence_score,
    validationChecksJson: row.validation_checks_json,
    searchMatched: row.search_matched === null ? null : row.search_matched === 1,
    searchMatchStrategy: row.search_match_strategy,
    hasUndocumentedDecision: row.has_undocumented_decision === 1,
    createdAt: row.created_at,
    applied: row.applied === 1,
  };
}

/** Usado por `devpilot diff`/`devpilot apply` (próxima pieza, ver 07) para recuperar las propuestas de la última importación. */
export function listFileChangeProposalsByContextPack(
  db: DatabaseSync,
  contextPackId: string,
): (FileChangeProposalRow & { applied: boolean })[] {
  const rows = db
    .prepare('SELECT * FROM file_change_proposals WHERE context_pack_id = ? ORDER BY created_at ASC')
    .all(contextPackId) as unknown[];
  return rows.map((row) => rowToProposal(row as FileChangeProposalDbRow));
}
