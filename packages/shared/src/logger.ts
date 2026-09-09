export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Logger mínimo del Incremento 0. Se mantiene deliberadamente simple: el
 * objetivo de este incremento es demostrar que el monorepo compila y que
 * los paquetes se importan entre sí correctamente — no diseñar logging
 * todavía (eso puede crecer cuando haga falta, ej. niveles configurables
 * por .devpilot/config.json).
 */
export function createLogger(scope: string) {
  const log = (level: LogLevel, message: string, ...args: unknown[]): void => {
    const prefix = `[devpilot:${scope}]`;
    const consoleMethod = level === 'debug' ? 'log' : level;
    console[consoleMethod](prefix, message, ...args);
  };

  return {
    debug: (message: string, ...args: unknown[]) => log('debug', message, ...args),
    info: (message: string, ...args: unknown[]) => log('info', message, ...args),
    warn: (message: string, ...args: unknown[]) => log('warn', message, ...args),
    error: (message: string, ...args: unknown[]) => log('error', message, ...args),
  };
}
