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
  return openDb(dbPath, PROJECT_DB_SCHEMA);
}
