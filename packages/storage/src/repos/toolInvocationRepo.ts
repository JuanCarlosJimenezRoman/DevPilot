import type { DatabaseSync } from 'node:sqlite';

// Repositorio sobre `<proyecto>/.devpilot/devpilot.db` (tabla
// `tool_invocations`, ver 03 y 05) — bitácora de auditoría de TODO lo que
// pasa por el Tool Engine, aprobado o no. `devpilot apply` es el primer
// consumidor real: cada propuesta que se intenta aplicar (se apruebe o se
// rechace) deja una fila aquí, con el resultado si se llegó a escribir.

export interface ToolInvocationRow {
  id: string;
  sessionId: string | null;
  toolName: string;
  riskLevel: string;
  paramsJson: string;
  approved: boolean;
  approvedAt: string | null;
  resultSummary: string | null;
  createdAt: string;
}

export function insertToolInvocation(db: DatabaseSync, row: ToolInvocationRow): void {
  db.prepare(
    `INSERT INTO tool_invocations
       (id, session_id, tool_name, risk_level, params_json, approved, approved_at, result_summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.sessionId,
    row.toolName,
    row.riskLevel,
    row.paramsJson,
    row.approved ? 1 : 0,
    row.approvedAt,
    row.resultSummary,
    row.createdAt,
  );
}
