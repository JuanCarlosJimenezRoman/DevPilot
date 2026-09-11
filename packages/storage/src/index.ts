// @devpilot/storage — SQLite (registro global + base por proyecto) y
// FileStore (contenido largo en disco). Ver docs/architecture/03-data-model.md.
//
// A partir del Scanner del Incremento 1, este paquete deja de ser un
// placeholder: expone la conexión a ambas bases, los repos de `projects` /
// `project_state`, y el snapshot store. El resto de repos/FileStore
// (knowledge, decisions, sessions) se agrega cuando el incremento
// correspondiente los necesite (ver 07); context packs, propuestas de
// cambio, invocaciones de herramientas y benchmarks por tarea ya están.

export * from './db/paths.js';
export * from './db/schema.js';
export * from './db/connection.js';
export * from './repos/projectRegistryRepo.js';
export * from './repos/projectStateRepo.js';
export * from './repos/contextPackRepo.js';
export * from './repos/fileChangeProposalRepo.js';
export * from './repos/toolInvocationRepo.js';
export * from './repos/taskBenchmarkRepo.js';
export * from './repos/decisionRepo.js';
export * from './repos/contextPackDecisionRepo.js';
export * from './repos/sessionRepo.js';
export * from './repos/knowledgeRepo.js';
export * from './repos/fileIndexRepo.js';
export * from './repos/symbolRepo.js';
export * from './files/snapshotStore.js';
export * from './files/contextPackStore.js';
export * from './files/changeProposalStore.js';
export * from './files/decisionStore.js';
export * from './files/sessionEventStore.js';
export * from './files/knowledgeStore.js';

export const STORAGE_PACKAGE_VERSION = '0.0.1';
