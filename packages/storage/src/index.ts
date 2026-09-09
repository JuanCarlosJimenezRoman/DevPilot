// Placeholder del paquete de almacenamiento (SQLite + FileStore). El
// esquema completo — registro global en ~/.devpilot/, base por proyecto en
// <proyecto>/.devpilot/devpilot.db, y el FileStore para knowledge/context/
// sessions/decisions — está diseñado en full en
// docs/architecture/03-data-model.md. Se implementa a partir del Scanner
// del Incremento 1 (ver docs/architecture/07-roadmap.md), no en este
// andamiaje: este paquete existe ya como frontera de import válida para
// que @devpilot/core pueda depender de él desde ahora sin que el
// Incremento 1 tenga que reestructurar el monorepo.

export const STORAGE_PACKAGE_VERSION = '0.0.1';
