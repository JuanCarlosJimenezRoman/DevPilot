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

export function getProjectContextDir(rootPath: string): string {
  return path.join(getProjectDevpilotDir(rootPath), 'context');
}

/** `.devpilot/changes/<proposal-id>.json` — contenido completo de cada `FileChangeProposal` + su `ValidationResult` (ver `changeProposalStore.ts`). La fila en `file_change_proposals` (03) solo guarda metadata consultable; el contenido real (necesario para reconstruir el diff en `devpilot diff`/`devpilot apply`) vive aquí, mismo principio que `context/` para los Context Packs. */
export function getProjectChangesDir(rootPath: string): string {
  return path.join(getProjectDevpilotDir(rootPath), 'changes');
}

/** `.devpilot/decisions/<decision-id>.md` — espejo legible de una Decision Record (ver `decisionStore.ts`). A diferencia de `changes/`, este NO es la fuente de verdad: la tabla `decisions` (03) ya guarda todo el contenido en columnas TEXT normales, así que el Markdown es "opcional" tal como lo describe 03 — solo para poder abrir/leer decisiones desde el editor sin correr `devpilot decide show`. */
export function getProjectDecisionsDir(rootPath: string): string {
  return path.join(getProjectDevpilotDir(rootPath), 'decisions');
}

/** `.devpilot/sessions/<session-id>.jsonl` — a diferencia de `decisions/`, este SÍ es la fuente de verdad del detalle turno-a-turno (03: "el detalle turno-a-turno vive en .devpilot/sessions/<id>.jsonl"). La fila en `sessions` (SQLite) solo guarda el resumen corto (started_at/ended_at/task_summary); el log completo de eventos vive únicamente acá, append-only, sin schema rígido — ver `sessionEventStore.ts`. */
export function getProjectSessionsDir(rootPath: string): string {
  return path.join(getProjectDevpilotDir(rootPath), 'sessions');
}

export function getProjectSessionEventsPath(rootPath: string, sessionId: string): string {
  return path.join(getProjectSessionsDir(rootPath), `${sessionId}.jsonl`);
}

/** `.devpilot/knowledge/<id>.md` (03/04) — a diferencia de `decisions/`, este SÍ es la fuente de verdad: `knowledge_docs` (03) indexa metadata (tipo, título, hash, origen) pero el contenido real vive únicamente acá. Para los 5 tipos canónicos (`architecture`/`modules`/`database`/`business-rules`/`conventions`) el id ES el tipo — a lo sumo un doc activo por tipo canónico, tal como lo muestra el layout de 03 (`architecture.md`, `modules.md`, ...). Los docs `custom` usan un id con prefijo `custom-<slug>` (ver knowledgeService.ts). */
export function getProjectKnowledgeDir(rootPath: string): string {
  return path.join(getProjectDevpilotDir(rootPath), 'knowledge');
}

export function getProjectKnowledgeFilePath(rootPath: string, id: string): string {
  return path.join(getProjectKnowledgeDir(rootPath), `${id}.md`);
}
