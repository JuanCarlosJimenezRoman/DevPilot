import { readFileSync } from 'node:fs';

// Helpers de lectura compartidos por el Context Planner y el
// ContextPackBuilder: evitar leer binarios o archivos absurdamente
// grandes, y truncar con aviso en vez de inflar el pack sin límite (ver
// "Context Compaction", 04).

const MAX_READABLE_BYTES = 1.5 * 1024 * 1024; // 1.5 MB — por encima de esto, ni se intenta leer para buscar texto
export const MAX_FILE_CONTENT_CHARS = 6000; // por archivo incluido en el pack final

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  return sample.includes(0);
}

/** Lee un archivo como texto si parece texto y no es demasiado grande; `null` en cualquier otro caso (nunca lanza). */
export function safeReadTextFile(absPath: string, maxBytes = MAX_READABLE_BYTES): string | null {
  try {
    const buffer = readFileSync(absPath);
    if (buffer.length > maxBytes) return null;
    if (looksBinary(buffer)) return null;
    return buffer.toString('utf8');
  } catch {
    return null;
  }
}

/** Trunca contenido largo preservando inicio y fin (donde suele estar la firma/exports y el cierre del archivo), con una nota visible del recorte — ver "Context Compaction" (04), punto 1: v1 trunca en vez de extraer solo firmas (eso requiere símbolos, Incremento 2). */
export function truncateForPack(content: string, maxChars = MAX_FILE_CONTENT_CHARS): string {
  if (content.length <= maxChars) return content;
  const headChars = Math.floor(maxChars * 0.6);
  const tailChars = maxChars - headChars;
  const head = content.slice(0, headChars);
  const tail = content.slice(content.length - tailChars);
  const omitted = content.length - headChars - tailChars;
  return `${head}\n\n/* ...(truncado por DevPilot: ~${omitted} caracteres omitidos aquí)... */\n\n${tail}`;
}
