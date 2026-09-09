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
