import { homedir } from 'node:os';
import path from 'node:path';

// Rutas de almacenamiento — ver docs/architecture/03-data-model.md. Solo se
// definen aquí los helpers que el Incremento 1 realmente usa (registro
// global, base de datos por proyecto, snapshot). El resto del layout de
// `.devpilot/` (knowledge/, sessions/, context/, decisions/, config.json)
// se agrega cuando el incremento correspondiente lo necesite, para no
// mantener rutas sin uso.

export function getGlobalDevpilotDir(): string {
  return path.join(homedir(), '.devpilot');
}

export function getGlobalRegistryDbPath(): string {
  return path.join(getGlobalDevpilotDir(), 'registry.db');
}

export function getProjectDevpilotDir(rootPath: string): string {
  return path.join(rootPath, '.devpilot');
}

export function getProjectDbPath(rootPath: string): string {
  return path.join(getProjectDevpilotDir(rootPath), 'devpilot.db');
}

export function getProjectStateDir(rootPath: string): string {
  return path.join(getProjectDevpilotDir(rootPath), 'state');
}

export function getProjectSnapshotPath(rootPath: string): string {
  return path.join(getProjectStateDir(rootPath), 'snapshot.json');
}
