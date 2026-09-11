import { createLogger } from '@devpilot/shared';

// Los contratos de dominio (Project, ProjectSnapshot, ProjectState, etc.)
// viven en @devpilot/shared, no aquí — ver el comentario en
// packages/shared/src/domain/types.ts para el porqué (evitar una
// dependencia circular con @devpilot/storage). Se re-exportan tal cual
// para no romper la ruta de import pública `@devpilot/core` que ya usa
// el resto del código (CLI incluido).
export * from '@devpilot/shared';

export * from './project/index.js';
export * from './context/index.js';
export * from './tools/index.js';
export * from './decisions/index.js';
export * from './sessions/index.js';
export * from './knowledge/index.js';
export * from './providers/index.js';
export * from './analysis/index.js';

const logger = createLogger('core');

/**
 * Versión del núcleo de DevPilot. En este incremento (0 — andamiaje) es
 * literal; a partir del Incremento 1 se lee de package.json en tiempo de
 * build. Su único propósito ahora mismo es servir de humo de que
 * @devpilot/core se importa correctamente desde @devpilot/cli.
 */
export const CORE_VERSION = '0.0.1';

export function describeCore(): string {
  logger.debug('describeCore() invocado');
  return `DevPilot core v${CORE_VERSION} — Incremento 0 (andamiaje; Project/Context/Tool Engine aún no implementados)`;
}
