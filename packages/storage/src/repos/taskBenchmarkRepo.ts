import type { DatabaseSync } from 'node:sqlite';

// Repositorio sobre `task_benchmarks` (03) — el benchmark automático por
// tarea (07, cierre del Incremento 1). Una fila por Context Pack: se crea
// al correr `devpilot context` (con lo único que se sabe en ese momento:
// tarea, tokens estimados, archivos incluidos) y se actualiza — nunca se
// inserta una fila nueva para el mismo pack — al correr `devpilot import`
// (tamaño de la respuesta, cambios importados) y `devpilot apply`
// (archivos realmente usados, cambios aplicados, resultado final). No hay
// una operación explícita de "cerrar tarea": el benchmark simplemente
// refleja el estado más reciente conocido para ese Context Pack.

export interface TaskBenchmarkRow {
  id: string;
  contextPackId: string;
  taskText: string;
  contextTokens: number | null;
  filesIncluded: number | null;
  filesUsed: number | null;
  filesUnnecessary: number | null;
  responseSizeChars: number | null;
  changesImported: number | null;
  changesApplied: number | null;
  /** 'success' | 'partial' | 'failed' | 'not_applied' (03) — ver benchmarkService.ts para cómo se decide. */
  outcome: string | null;
  createdAt: string;
}

interface TaskBenchmarkDbRow {
  id: string;
  context_pack_id: string | null;
  task_text: string;
  context_tokens: number | null;
  files_included: number | null;
  files_used: number | null;
  files_unnecessary: number | null;
  response_size_chars: number | null;
  changes_imported: number | null;
  changes_applied: number | null;
  outcome: string | null;
  created_at: string;
}

function rowFromDb(row: TaskBenchmarkDbRow): TaskBenchmarkRow {
  return {
    id: row.id,
    contextPackId: row.context_pack_id ?? '',
    taskText: row.task_text,
    contextTokens: row.context_tokens,
    filesIncluded: row.files_included,
    filesUsed: row.files_used,
    filesUnnecessary: row.files_unnecessary,
    responseSizeChars: row.response_size_chars,
    changesImported: row.changes_imported,
    changesApplied: row.changes_applied,
    outcome: row.outcome,
    createdAt: row.created_at,
  };
}

/** Llamado desde `devpilot context` (contextService.ts) apenas se genera el pack — con lo poco que se sabe en ese momento. */
export function insertTaskBenchmark(db: DatabaseSync, row: TaskBenchmarkRow): void {
  db.prepare(
    `INSERT INTO task_benchmarks
       (id, context_pack_id, task_text, context_tokens, files_included, files_used,
        files_unnecessary, response_size_chars, changes_imported, changes_applied,
        outcome, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.contextPackId,
    row.taskText,
    row.contextTokens,
    row.filesIncluded,
    row.filesUsed,
    row.filesUnnecessary,
    row.responseSizeChars,
    row.changesImported,
    row.changesApplied,
    row.outcome,
    row.createdAt,
  );
}

/** Una fila por Context Pack (ver comentario de arriba del archivo) — nunca hay más de una para el mismo `contextPackId` si siempre se pasa por este repo, pero se toma la más reciente por si acaso (defensivo, no se espera que ocurra). */
export function getTaskBenchmarkByContextPackId(db: DatabaseSync, contextPackId: string): TaskBenchmarkRow | null {
  const row = db
    .prepare('SELECT * FROM task_benchmarks WHERE context_pack_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(contextPackId) as unknown | undefined;
  return row ? rowFromDb(row as TaskBenchmarkDbRow) : null;
}

/** Llamado desde `devpilot import` (importService.ts) — tamaño de la respuesta cruda y total de cambios importados hasta ahora para este pack. */
export function updateTaskBenchmarkAfterImport(
  db: DatabaseSync,
  id: string,
  fields: { responseSizeChars: number; changesImported: number },
): void {
  db.prepare('UPDATE task_benchmarks SET response_size_chars = ?, changes_imported = ? WHERE id = ?').run(
    fields.responseSizeChars,
    fields.changesImported,
    id,
  );
}

/** Llamado desde `devpilot apply` (applyService.ts) al terminar una corrida — recalcula todo lo que depende de qué se aplicó de verdad. */
export function updateTaskBenchmarkAfterApply(
  db: DatabaseSync,
  id: string,
  fields: {
    filesUsed: number;
    filesUnnecessary: number;
    changesImported: number;
    changesApplied: number;
    outcome: string;
  },
): void {
  db.prepare(
    `UPDATE task_benchmarks
       SET files_used = ?, files_unnecessary = ?, changes_imported = ?, changes_applied = ?, outcome = ?
     WHERE id = ?`,
  ).run(fields.filesUsed, fields.filesUnnecessary, fields.changesImported, fields.changesApplied, fields.outcome, id);
}

/** `devpilot benchmark` (07): lista las tareas más recientes con benchmark registrado, para inspección y para el resumen agregado. */
export function listTaskBenchmarks(db: DatabaseSync, limit: number): TaskBenchmarkRow[] {
  const rows = db
    .prepare('SELECT * FROM task_benchmarks ORDER BY created_at DESC LIMIT ?')
    .all(limit) as unknown[];
  return rows.map((row) => rowFromDb(row as TaskBenchmarkDbRow));
}
