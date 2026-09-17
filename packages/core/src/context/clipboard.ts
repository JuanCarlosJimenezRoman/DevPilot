import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLogger } from '@devpilot/shared';

const logger = createLogger('core:clipboard');

// Copiar al portapapeles es pura conveniencia de UX (ver 06,
// `ManualProvider.execute()`) — nunca crítico: el Context Pack siempre
// queda persistido en `.devpilot/context/` de todas formas (ver 04/07), así
// que si esto falla el usuario simplemente copia el Markdown desde ahí a
// mano. Por eso se implementa con el comando nativo de cada plataforma en
// vez de sumar una dependencia nueva solo para esto.
function commandFor(platform: NodeJS.Platform): { cmd: string; args: string[] } | null {
  if (platform === 'darwin') return { cmd: 'pbcopy', args: [] };
  if (platform === 'linux') return { cmd: 'xclip', args: ['-selection', 'clipboard'] };
  return null;
}

/**
 * Windows: `clip.exe` (el comando "obvio", usado hasta ahora) interpreta
 * su stdin con el code page OEM de la consola (ej. CP437), no UTF-8 — así
 * que cualquier carácter fuera de ASCII (tildes, eñes, guiones largos,
 * flechas, los emoji ✅/⚠️/❌ que ya usa el propio Context Pack) se
 * corrompe en el portapapeles real. Bug real encontrado usando DevPilot
 * contra un proyecto real (fase de uso real, sesión 13) — el Context Pack
 * que llegaba a la IA vía "pegar del portapapeles" tenía la mitad del
 * texto en español convertido en mojibake.
 *
 * `Set-Clipboard` (PowerShell, built-in desde Windows 10 / PowerShell
 * 5.0 — sin sumar una dependencia nueva, sigue siendo "el comando nativo
 * de la plataforma") sí maneja Unicode bien. Para no depender de cómo el
 * pipe de stdin decodifique los bytes (el mismo problema de fondo que
 * tenía `clip.exe`), el texto se escribe primero a un archivo temporal
 * con UTF-8 explícito desde Node, y el script de PowerShell lo relee con
 * ese mismo encoding declarado explícitamente — nunca depende del code
 * page activo de la consola en ningún punto del camino.
 */
function copyToClipboardWindows(text: string): boolean {
  const tempPath = path.join(tmpdir(), `devpilot-clipboard-${randomUUID()}.txt`);
  try {
    writeFileSync(tempPath, text, 'utf8');
    const escapedPath = tempPath.replace(/'/g, "''");
    const script = `Set-Clipboard -Value ([System.IO.File]::ReadAllText('${escapedPath}', [System.Text.Encoding]::UTF8))`;
    // -EncodedCommand (Base64 de UTF-16LE) evita por completo cualquier
    // problema de escaping de comillas/caracteres especiales al pasar el
    // script por la línea de comandos — requisito estándar de PowerShell
    // para -EncodedCommand, no una elección nuestra.
    const encodedCommand = Buffer.from(script, 'utf16le').toString('base64');
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand], {
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
    });
    return true;
  } catch (err) {
    logger.debug('no se pudo copiar al portapapeles (Windows/PowerShell)', (err as Error).message);
    return false;
  } finally {
    try {
      unlinkSync(tempPath);
    } catch {
      // Best-effort: si no se pudo borrar el temporal, no es motivo para
      // fallar la copia — el sistema operativo lo limpia eventualmente.
    }
  }
}

export function copyToClipboard(text: string): boolean {
  if (process.platform === 'win32') return copyToClipboardWindows(text);

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
