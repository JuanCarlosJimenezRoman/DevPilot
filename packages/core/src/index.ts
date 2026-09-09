import { createLogger } from '@devpilot/shared';

export * from './domain/index.js';

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
