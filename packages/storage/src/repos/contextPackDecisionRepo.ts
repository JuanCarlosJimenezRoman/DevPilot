import type { DatabaseSync } from 'node:sqlite';

// Repositorio sobre `context_pack_decisions` (03) — qué decisiones de
// negocio (confirmadas u abiertas) se incluyeron en cada Context Pack.
// Existía en el esquema desde el Incremento 0 sin usarse; `devpilot
// context` (con Decision Records reales desde el Incremento 2, ver
// decisionService.ts) es su primer consumidor real — mismo patrón que
// `tool_invocations`/`task_benchmarks` en el Incremento 1. El pack JSON
// (.devpilot/context/*.json) ya trae todo esto embebido en
// `decisionsConsidered`/`businessDecisions`; esta tabla existe para poder
// consultarlo con SQL sin tener que abrir cada archivo (ej. "¿en cuántas
// tareas se usó esta Decision Record?", ver `devpilot decide show`).

export interface ContextPackDecisionRow {
  id: string;
  contextPackId: string;
  kind: 'confirmed' | 'open';
  text: string;
  /** Solo se completa para 'confirmed' que sí vienen de una Decision Record real (`devpilot decide`) — texto tipeado a mano al momento no tiene un id que lo respalde. */
  resolvedDecisionId: string | null;
}

export function insertContextPackDecision(db: DatabaseSync, row: ContextPackDecisionRow): void {
  db.prepare(
    'INSERT INTO context_pack_decisions (id, context_pack_id, kind, text, resolved_decision_id) VALUES (?, ?, ?, ?, ?)',
  ).run(row.id, row.contextPackId, row.kind, row.text, row.resolvedDecisionId);
}

/** `devpilot decide show <id>` (07): en cuántos Context Packs distintos se consideró esta Decision Record hasta ahora — una señal simple de qué tan viva/relevante sigue siendo. */
export function countContextPackDecisionsByDecisionId(db: DatabaseSync, decisionId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) as n FROM context_pack_decisions WHERE resolved_decision_id = ?')
    .get(decisionId) as { n: number } | undefined;
  return row?.n ?? 0;
}
