import type { DatabaseSync } from 'node:sqlite';

// Repositorio sobre `sessions` (03) — Session Memory real (07, Incremento
// 2). La tabla existía desde el Incremento 0 sin ningún consumidor: hasta
// ahora `context_packs.session_id`/`tool_invocations.session_id` siempre se
// insertaban en NULL (ver contextPackRepo.ts/applyService.ts de
// Incremento 1) porque no había ninguna fila real de `sessions` a la cual
// apuntar. Este es su primer consumidor real — mismo patrón que
// `tool_invocations`/`task_benchmarks`/`decisions` en incrementos
// anteriores.
//
// "Una sesión = una invocación conceptual de trabajo" (04) — puede abarcar
// varios comandos CLI (`context`, `import`, `apply`, `decide`...). El
// detalle turno-a-turno vive aparte, en `.devpilot/sessions/<id>.jsonl`
// (ver sessionEventStore.ts); esta tabla solo guarda el resumen corto.

export interface SessionRow {
  id: string;
  startedAt: string;
  endedAt: string | null;
  taskSummary: string | null;
  providerUsed: string | null;
  eventsPath: string | null;
}

interface SessionDbRow {
  id: string;
  started_at: string;
  ended_at: string | null;
  task_summary: string | null;
  provider_used: string | null;
  events_path: string | null;
}

function rowFromDb(row: SessionDbRow): SessionRow {
  return {
    id: row.id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    taskSummary: row.task_summary,
    providerUsed: row.provider_used,
    eventsPath: row.events_path,
  };
}

export function insertSession(db: DatabaseSync, row: SessionRow): void {
  db.prepare(
    `INSERT INTO sessions (id, started_at, ended_at, task_summary, provider_used, events_path)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.startedAt, row.endedAt, row.taskSummary, row.providerUsed, row.eventsPath);
}

/**
 * La sesión activa del proyecto — `ended_at IS NULL` — si hay alguna. No
 * hay ningún `UNIQUE`/`CHECK` en el esquema que impida más de una fila con
 * `ended_at IS NULL` a la vez (mismo motivo de siempre: no romper bases ya
 * creadas con `CREATE TABLE IF NOT EXISTS`); la garantía de "a lo sumo una
 * sesión activa" la mantiene `sessionService.ts` (rechaza `session start`
 * si ya hay una activa). Acá se toma la más reciente por si acaso, igual
 * que `getTaskBenchmarkByContextPackId`.
 */
export function getActiveSession(db: DatabaseSync): SessionRow | null {
  const row = db
    .prepare('SELECT * FROM sessions WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1')
    .get() as unknown | undefined;
  return row ? rowFromDb(row as SessionDbRow) : null;
}

export function getSessionById(db: DatabaseSync, id: string): SessionRow | null {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as unknown | undefined;
  return row ? rowFromDb(row as SessionDbRow) : null;
}

/** `devpilot session end`: cierra la sesión activa. `taskSummary` es opcional — si no se pasa, se conserva el que ya tenía (el que se dio en `session start`, si alguno). */
export function endSession(
  db: DatabaseSync,
  id: string,
  fields: { endedAt: string; taskSummary?: string },
): void {
  if (fields.taskSummary !== undefined) {
    db.prepare('UPDATE sessions SET ended_at = ?, task_summary = ? WHERE id = ?').run(
      fields.endedAt,
      fields.taskSummary,
      id,
    );
  } else {
    db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(fields.endedAt, id);
  }
}

/** `devpilot session list` (07). */
export function listSessions(db: DatabaseSync, limit: number): SessionRow[] {
  const rows = db.prepare('SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?').all(limit) as unknown[];
  return rows.map((row) => rowFromDb(row as SessionDbRow));
}
