import { execFileSync } from 'node:child_process';
import { createLogger } from '@devpilot/shared';

const logger = createLogger('core:clipboard');

// Copiar al portapapeles es pura conveniencia de UX (ver 06,
// `ManualProvider.execute()`) — nunca crítico: el Context Pack siempre
// queda persistido en `.devpilot/context/` de todas formas (ver 04/07), así
// que si esto falla el usuario simplemente copia el Markdown desde ahí a
// mano. Por eso se implementa con el comando nativo de cada plataforma en
// vez de sumar una dependencia nueva solo para esto.
function commandFor(platform: NodeJS.Platform): { cmd: string; args: string[] } | null {
  if (platform === 'win32') return { cmd: 'clip', args: [] };
  if (platform === 'darwin') return { cmd: 'pbcopy', args: [] };
  if (platform === 'linux') return { cmd: 'xclip', args: ['-selection', 'clipboard'] };
  return null;
}

export function copyToClipboard(text: string): boolean {
  const target = commandFor(process.platform);
  if (!target) {
    logger.debug('plataforma sin comando de portapapeles conocido', process.platform);
    return false;
  }
  try {
    execFileSync(target.cmd, target.args, { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
    return true;
  } catch (err) {
    logger.debug('no se pudo copiar al portapapeles', (err as Error).message);
    // Fallback específico de Linux: xclip no siempre está instalado, xsel es la alternativa común.
    if (process.platform === 'linux') {
      try {
        execFileSync('xsel', ['--clipboard', '--input'], { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
        return true;
      } catch (err2) {
        logger.debug('tampoco xsel', (err2 as Error).message);
      }
    }
    return false;
  }
}
