import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { createLogger } from '@devpilot/shared';
import {
  getGlobalDevpilotDir,
  getGlobalRegistryDbPath,
  getProjectDbPath,
  getProjectDevpilotDir,
} from './paths.js';
import { GLOBAL_REGISTRY_SCHEMA, PROJECT_DB_SCHEMA } from './schema.js';

const logger = createLogger('storage:db');

// `node:sqlite` (DatabaseSync) es API experimental de Node core — elegida
// deliberadamente sobre `better-sqlite3` para no depender de binarios
// nativos (ver docs/architecture/03-data-model.md). Verificado funcionando
// en Node 22 sin necesidad de flags, incluyendo PRAGMA multi-statement y
// ON DELETE CASCADE.

// `CREATE TABLE IF NOT EXISTS` (schema.ts) no altera tablas que ya existen
// en una base de un proyecto abierto con una versión anterior del código —
// es el caso real de `proposal_path`, agregada a `file_change_proposals`
// al implementar `devpilot diff` (ver schema.ts). En vez de introducir un
// sistema de migraciones versionado completo para un solo caso, se
// verifica con `PRAGMA table_info` y se agrega la columna si falta —
// misma filosofía "recrear/ajustar es barato mientras el esquema es
// chico" que ya documenta schema.ts para las tablas nuevas.
function ensureFileChangeProposalPathColumn(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info('file_change_proposals')").all() as { name: string }[];
  if (columns.length === 0) return; // la tabla se acaba de crear con el schema de arriba, ya la trae
  const hasColumn = columns.some((c) => c.name === 'proposal_path');
  if (!hasColumn) {
    db.exec('ALTER TABLE file_change_proposals ADD COLUMN proposal_path TEXT;');
  }
}

function openDb(dbPath: string, schema: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  return db;
}

/** Abre (creando si hace falta) `~/.devpilot/registry.db`. */
export function openGlobalRegistryDb(): DatabaseSync {
  const dir = getGlobalDevpilotDir();
  mkdirSync(dir, { recursive: true });
  const dbPath = getGlobalRegistryDbPath();
  logger.debug('abriendo registro global', dbPath);
  return openDb(dbPath, GLOBAL_REGISTRY_SCHEMA);
}

/** Abre (creando si hace falta) `<rootPath>/.devpilot/devpilot.db`. */
export function openProjectDb(rootPath: string): DatabaseSync {
  const dir = getProjectDevpilotDir(rootPath);
  mkdirSync(dir, { recursive: true });
  const dbPath = getProjectDbPath(rootPath);
  logger.debug('abriendo base de proyecto', dbPath);
  const db = openDb(dbPath, PROJECT_DB_SCHEMA);
  ensureFileChangeProposalPathColumn(db);
  return db;
}
