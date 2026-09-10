import type { DatabaseSync } from 'node:sqlite';

// Repositorio sobre `decisions` (03) — Decision Records, memoria de largo
// plazo que sobrevive a cualquier sesión (04). La tabla existía en el
// esquema desde el Incremento 0 sin usarse; `devpilot decide` (07,
// Incremento 2) es su primer consumidor real.

export interface DecisionRow {
  id: string;
  title: string;
  context: string;
  decision: string;
  consequences: string | null;
  status: string; // 'proposed' | 'accepted' | 'superseded'
  relatedFiles: string[];
  tags: string[];
  createdAt: string;
}

interface DecisionDbRow {
  id: string;
  title: string;
  context: string;
  decision: string;
  consequences: string | null;
  status: string;
  related_files: string | null;
  tags: string | null;
  created_at: string;
}

function safeParseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    // Fila corrupta a mano en la base — no debería pasar nunca vía este
    // repo, pero no vale la pena romper `devpilot decide list` por esto.
    return [];
  }
}

function rowFromDb(row: DecisionDbRow): DecisionRow {
  return {
    id: row.id,
    title: row.title,
    context: row.context,
    decision: row.decision,
    consequences: row.consequences,
    status: row.status,
    relatedFiles: safeParseJsonArray(row.related_files),
    tags: safeParseJsonArray(row.tags),
    createdAt: row.created_at,
  };
}

export function insertDecision(db: DatabaseSync, row: DecisionRow): void {
  db.prepare(
    `INSERT INTO decisions
       (id, title, context, decision, consequences, status, related_files, tags, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.title,
    row.context,
    row.decision,
    row.consequences,
    row.status,
    JSON.stringify(row.relatedFiles),
    JSON.stringify(row.tags),
    row.createdAt,
  );
}

/** `devpilot decide list` y el matching automático en `devpilot context` (ver decisionService.ts) — todas las decisiones del proyecto, más recientes primero. */
export function listDecisions(db: DatabaseSync): DecisionRow[] {
  const rows = db.prepare('SELECT * FROM decisions ORDER BY created_at DESC').all() as unknown[];
  return rows.map((row) => rowFromDb(row as DecisionDbRow));
}

export function getDecisionById(db: DatabaseSync, id: string): DecisionRow | null {
  const row = db.prepare('SELECT * FROM decisions WHERE id = ?').get(id) as unknown | undefined;
  return row ? rowFromDb(row as DecisionDbRow) : null;
}

/** `devpilot decide supersede <id>`: una Decision Record superada nunca se borra (es historia real, ver 04) — solo cambia de estado, y deja de ofrecerse como "confirmada" en Context Packs nuevos (ver decisionService.ts). */
export function updateDecisionStatus(db: DatabaseSync, id: string, status: string): void {
  db.prepare('UPDATE decisions SET status = ? WHERE id = ?').run(status, id);
}
