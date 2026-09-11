import type { DatabaseSync } from 'node:sqlite';

// Repositorio sobre la tabla `files` (03) — el Indice de archivos que
// mantiene el Indexer (packages/core/src/project/indexer.ts, ver 04
// "Reindexado incremental"). Esta tabla existia en el esquema desde el
// Incremento 0 sin ningun consumidor real -- mismo patron ya usado con
// `tool_invocations`/`task_benchmarks`/`decisions`/`knowledge_docs` en
// piezas anteriores: la tabla nace vacia y espera a la pieza que le da
// sentido.
//
// A diferencia de Decision Records/Project Knowledge, esta tabla NO tiene
// un archivo espejo en disco -- es un indice puro (hash + metadata por
// archivo), no memoria de negocio que el usuario deba poder leer a mano.
// Si se pierde, se regenera por completo con un reindexado full.

export interface FileIndexRow {
  id: string;
  path: string;
  hash: string;
  language: string | null;
  sizeBytes: number;
  lastModified: string;
  lastSeenCommit: string | null;
  indexedAt: string;
}

interface FileIndexDbRow {
  id: string;
  path: string;
  hash: string;
  language: string | null;
  size_bytes: number | null;
  last_modified: string | null;
  last_seen_commit: string | null;
  indexed_at: string;
}

function rowToFileIndexRow(row: FileIndexDbRow): FileIndexRow {
  return {
    id: row.id,
    path: row.path,
    hash: row.hash,
    language: row.language,
    sizeBytes: row.size_bytes ?? 0,
    lastModified: row.last_modified ?? '',
    lastSeenCommit: row.last_seen_commit,
    indexedAt: row.indexed_at,
  };
}

/**
 * `path` es UNIQUE (no PRIMARY KEY) en el esquema -- el conflicto se
 * resuelve por ruta, no por id, así que reindexar un archivo ya indexado
 * conserva su `id` original (no se pisa en el UPDATE) en vez de generar
 * uno nuevo cada vez. Mismo patrón de upsert por identidad natural que
 * `upsertKnowledgeDoc`/`upsertProjectState`.
 */
export function upsertFileIndexRow(db: DatabaseSync, row: FileIndexRow): void {
  db.prepare(
    `INSERT INTO files (id, path, hash, language, size_bytes, last_modified, last_seen_commit, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       hash = excluded.hash,
       language = excluded.language,
       size_bytes = excluded.size_bytes,
       last_modified = excluded.last_modified,
       last_seen_commit = excluded.last_seen_commit,
       indexed_at = excluded.indexed_at`,
  ).run(
    row.id,
    row.path,
    row.hash,
    row.language,
    row.sizeBytes,
    row.lastModified,
    row.lastSeenCommit,
    row.indexedAt,
  );
}

export function deleteFileIndexRowByPath(db: DatabaseSync, filePath: string): void {
  db.prepare('DELETE FROM files WHERE path = ?').run(filePath);
}

export function getFileIndexByPath(db: DatabaseSync, filePath: string): FileIndexRow | null {
  const row = db.prepare('SELECT * FROM files WHERE path = ?').get(filePath) as
    | FileIndexDbRow
    | undefined;
  return row ? rowToFileIndexRow(row) : null;
}

/** Solo las rutas -- suficiente para que el Indexer calcule qué se agregó/removió sin traer hash/metadata que no necesita comparar. */
export function listFileIndexPaths(db: DatabaseSync): string[] {
  const rows = db.prepare('SELECT path FROM files').all() as { path: string }[];
  return rows.map((r) => r.path);
}

export function listFileIndex(db: DatabaseSync): FileIndexRow[] {
  const rows = db.prepare('SELECT * FROM files ORDER BY path ASC').all() as unknown as FileIndexDbRow[];
  return rows.map(rowToFileIndexRow);
}

export function countFileIndexRows(db: DatabaseSync): number {
  const row = db.prepare('SELECT COUNT(*) as count FROM files').get() as { count: number };
  return row.count;
}
