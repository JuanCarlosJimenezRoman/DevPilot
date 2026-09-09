// @devpilot/storage — SQLite (registro global + base por proyecto) y
// FileStore (contenido largo en disco). Ver docs/architecture/03-data-model.md.
//
// A partir del Scanner del Incremento 1, este paquete deja de ser un
// placeholder: expone la conexión a ambas bases, los repos de `projects` /
// `project_state`, y el snapshot store. El resto de repos/FileStore
// (knowledge, decisions, sessions, context packs, benchmarks) se agrega
// cuando el incremento correspondiente los necesite (ver 07).

export * from './db/paths.js';
export * from './db/schema.js';
export * from './db/connection.js';
export * from './repos/projectRegistryRepo.js';
export * from './repos/projectStateRepo.js';
export * from './repos/contextPackRepo.js';
export * from './repos/fileChangeProposalRepo.js';
export * from './repos/toolInvocationRepo.js';
export * from './files/snapshotStore.js';
export * from './files/contextPackStore.js';
export * from './files/changeProposalStore.js';

export const STORAGE_PACKAGE_VERSION = '0.0.1';
