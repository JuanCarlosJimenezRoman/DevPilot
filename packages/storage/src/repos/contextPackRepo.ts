import type { DatabaseSync } from 'node:sqlite';

// Repositorio sobre `<proyecto>/.devpilot/devpilot.db` (tabla
// `context_packs`, ver 03) — fila de auditoría que apunta al Markdown/JSON
// reales en `.devpilot/context/`. `session_id` queda NULL en el Incremento
// 1: Session Memory real (tabla `sessions` poblada de verdad) es del
// Incremento 2 — ver docs/architecture/07-roadmap.md. El `sessionId` que sí
// lleva el objeto `ContextPack` en memoria (tipo de dominio) es solo un
// identificador de esta invocación, no persistido como sesión todavía.

export interface ContextPackRow {
  id: string;
  taskText: string;
  createdAt: string;
  tokenEstimate: number;
  classification: string;
  // Relativas al rootPath del proyecto, NO absolutas (ver contextService.ts
  // — bug real de portabilidad encontrado al implementar `devpilot diff`:
  // una ruta absoluta guardada en SQLite deja de servir si el proyecto se
  // mueve, o si la misma carpeta se monta con un prefijo distinto entre
  // sesiones). Quien las use debe resolverlas con `path.resolve(rootPath,
  // row.jsonPath)` contra el rootPath *actual*, no asumir que ya son
  // absolutas.
  markdownPath: string;
  jsonPath: string;
}

export function insertContextPack(db: DatabaseSync, row: ContextPackRow): void {
  db.prepare(
    `INSERT INTO context_packs
       (id, session_id, task_text, created_at, token_estimate, classification, markdown_path, json_path)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.taskText,
    row.createdAt,
    row.tokenEstimate,
    row.classification,
    row.markdownPath,
    row.jsonPath,
  );
}

interface ContextPackDbRow {
  id: string;
  task_text: string;
  created_at: string;
  token_estimate: number;
  classification: string;
  markdown_path: string;
  json_path: string;
}

function rowToContextPack(row: ContextPackDbRow): ContextPackRow {
  return {
    id: row.id,
    taskText: row.task_text,
    createdAt: row.created_at,
    tokenEstimate: row.token_estimate,
    classification: row.classification,
    markdownPath: row.markdown_path,
    jsonPath: row.json_path,
  };
}

/** Usado por `devpilot import` (ver 07): sin que el usuario tenga que acordarse del id, se asume que está importando la respuesta al Context Pack más reciente de este proyecto. */
export function getLatestContextPack(db: DatabaseSync): ContextPackRow | null {
  const row = db.prepare('SELECT * FROM context_packs ORDER BY created_at DESC LIMIT 1').get() as
    | unknown
    | undefined;
  return row ? rowToContextPack(row as ContextPackDbRow) : null;
}

export function getContextPackById(db: DatabaseSync, id: string): ContextPackRow | null {
  const row = db.prepare('SELECT * FROM context_packs WHERE id = ?').get(id) as unknown | undefined;
  return row ? rowToContextPack(row as ContextPackDbRow) : null;
}
