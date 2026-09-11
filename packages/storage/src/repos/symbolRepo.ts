import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

// Repositorio sobre la tabla `symbols` (03) -- igual que `files` en el
// Incremento 2, esta tabla existía en el esquema desde el Incremento 0 sin
// consumidor real. La puebla el Indexer (packages/core/src/project/
// indexer.ts) vía symbolExtractor.ts, para archivos TypeScript/JavaScript
// -- ver 04 "Indexer" y el Nivel 3 del Context Planner (07, Incremento 3).
//
// Sin archivo espejo en disco, mismo criterio que `files`: es un índice
// puro, no memoria de negocio: si se pierde, se regenera reindexando.

export interface SymbolInput {
  name: string;
  kind: string;
  lineStart: number | null;
  lineEnd: number | null;
  isExported: boolean;
}

export interface SymbolRow extends SymbolInput {
  id: string;
  fileId: string;
}

/** Símbolo + la ruta del archivo que lo declara -- lo que necesita el Context Planner (Nivel 3, relevancePlanner.ts) para decidir "¿este archivo EXPORTA algo que coincide con la tarea?" sin tener que resolver file_id -> path por separado. */
export interface SymbolWithFilePath extends SymbolRow {
  filePath: string;
}

/**
 * Reemplaza TODOS los símbolos de un archivo de una sola vez -- borrar +
 * reinsertar, no un diff fila por fila. Simplificación deliberada (mismo
 * criterio que el resto de v1, ver indexer.ts): un archivo tiene a lo sumo
 * unas pocas decenas de símbolos, así que el costo de rehacer todas sus
 * filas en cada reindexado es insignificante frente a la complejidad de
 * diffear inserciones/actualizaciones/borrados símbolo por símbolo.
 */
export function replaceSymbolsForFile(db: DatabaseSync, fileId: string, symbols: SymbolInput[]): void {
  db.prepare('DELETE FROM symbols WHERE file_id = ?').run(fileId);
  if (symbols.length === 0) return;

  const insert = db.prepare(
    `INSERT INTO symbols (id, file_id, name, kind, line_start, line_end, is_exported)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const symbol of symbols) {
    insert.run(
      randomUUID(),
      fileId,
      symbol.name,
      symbol.kind,
      symbol.lineStart,
      symbol.lineEnd,
      symbol.isExported ? 1 : 0,
    );
  }
}

interface SymbolDbRow {
  id: string;
  file_id: string;
  name: string;
  kind: string;
  line_start: number | null;
  line_end: number | null;
  is_exported: number;
}

function rowToSymbol(row: SymbolDbRow): SymbolRow {
  return {
    id: row.id,
    fileId: row.file_id,
    name: row.name,
    kind: row.kind,
    lineStart: row.line_start,
    lineEnd: row.line_end,
    isExported: row.is_exported !== 0,
  };
}

export function listSymbolsForFile(db: DatabaseSync, fileId: string): SymbolRow[] {
  const rows = db.prepare('SELECT * FROM symbols WHERE file_id = ? ORDER BY line_start ASC').all(fileId) as unknown as SymbolDbRow[];
  return rows.map(rowToSymbol);
}

interface SymbolWithPathDbRow extends SymbolDbRow {
  path: string;
}

/** Usado por contextService.ts para armar el índice de símbolos que pasa al Context Planner (Nivel 3, relevancePlanner.ts) -- un solo JOIN, no N+1 consultas por archivo candidato. */
export function listAllSymbolsWithFilePath(db: DatabaseSync): SymbolWithFilePath[] {
  const rows = db
    .prepare(
      `SELECT symbols.*, files.path as path
       FROM symbols
       JOIN files ON files.id = symbols.file_id`,
    )
    .all() as unknown as SymbolWithPathDbRow[];
  return rows.map((row) => ({ ...rowToSymbol(row), filePath: row.path }));
}

export function countSymbolRows(db: DatabaseSync): number {
  const row = db.prepare('SELECT COUNT(*) as count FROM symbols').get() as { count: number };
  return row.count;
}
