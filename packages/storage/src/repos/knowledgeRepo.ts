import type { DatabaseSync } from 'node:sqlite';

// Repositorio sobre `knowledge_docs` (03) — Project Knowledge (04, 07
// Incremento 2, última pieza de "Project Memory"). La tabla existía desde
// el Incremento 0 sin ningún consumidor real, mismo patrón que
// `decisions`/`sessions` en piezas anteriores.
//
// A diferencia de `decisions` (una fila nueva por decisión, nunca se
// borra) o `sessions` (una fila por sesión), acá el `id` mismo decide la
// identidad del doc — para los 5 tipos canónicos, `id === type`, así que
// "a lo sumo un doc activo por tipo canónico" es una garantía de esquema
// (PRIMARY KEY), no solo de aplicación. Por eso el repo expone un solo
// `upsertKnowledgeDoc` (INSERT ... ON CONFLICT DO UPDATE) en vez de
// insert/update separados: "crear" y "regenerar" son la misma operación.

export interface KnowledgeDocRow {
  id: string;
  type: string;
  title: string;
  // Relativa a rootPath, NO absoluta — mismo motivo de portabilidad que en
  // todos los demás repos con rutas (ver contextPackRepo.ts).
  path: string;
  contentHash: string;
  source: string;
  updatedAt: string;
}

interface KnowledgeDocDbRow {
  id: string;
  type: string;
  title: string;
  path: string;
  content_hash: string;
  source: string;
  updated_at: string;
}

function rowFromDb(row: KnowledgeDocDbRow): KnowledgeDocRow {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    path: row.path,
    contentHash: row.content_hash,
    source: row.source,
    updatedAt: row.updated_at,
  };
}

/** Crea o actualiza un knowledge doc por `id` — "generar de nuevo" y "crear la primera vez" son la misma llamada. */
export function upsertKnowledgeDoc(db: DatabaseSync, row: KnowledgeDocRow): void {
  db.prepare(
    `INSERT INTO knowledge_docs (id, type, title, path, content_hash, source, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       type = excluded.type,
       title = excluded.title,
       path = excluded.path,
       content_hash = excluded.content_hash,
       source = excluded.source,
       updated_at = excluded.updated_at`,
  ).run(row.id, row.type, row.title, row.path, row.contentHash, row.source, row.updatedAt);
}

export function getKnowledgeDocById(db: DatabaseSync, id: string): KnowledgeDocRow | null {
  const row = db.prepare('SELECT * FROM knowledge_docs WHERE id = ?').get(id) as unknown | undefined;
  return row ? rowFromDb(row as KnowledgeDocDbRow) : null;
}

/** `devpilot knowledge list` (07) y `devpilot context` (Project Knowledge relevante, ver contextService.ts). */
export function listKnowledgeDocs(db: DatabaseSync): KnowledgeDocRow[] {
  const rows = db.prepare('SELECT * FROM knowledge_docs ORDER BY type ASC').all() as unknown[];
  return rows.map((row) => rowFromDb(row as KnowledgeDocDbRow));
}
