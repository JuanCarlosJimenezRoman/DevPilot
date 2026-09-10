import { appendFile, mkdir, readFile } from 'node:fs/promises';
import type { SessionEvent } from '@devpilot/shared';
import { getProjectSessionEventsPath, getProjectSessionsDir } from '../db/paths.js';

// `.devpilot/sessions/<session-id>.jsonl` (03/04): el detalle turno-a-turno
// de una sesión — append-only, una línea JSON por evento, sin schema
// rígido (04 lo pide explícitamente así: "barato de escribir append-only,
// no requiere schema rígido"). La fila en `sessions` (SQLite) es solo el
// resumen corto; este archivo es la fuente de verdad del log completo.

/** Agrega un evento al final del log de la sesión. Crea el directorio/archivo si hace falta — nunca falla porque el archivo no existe todavía (primer evento de una sesión recién creada). */
export async function appendSessionEvent(
  rootPath: string,
  sessionId: string,
  event: SessionEvent,
): Promise<void> {
  await mkdir(getProjectSessionsDir(rootPath), { recursive: true });
  const filePath = getProjectSessionEventsPath(rootPath, sessionId);
  await appendFile(filePath, JSON.stringify(event) + '\n', 'utf8');
}

/**
 * Lee de vuelta todos los eventos de una sesión, en el orden en que se
 * escribieron (que es también orden cronológico, por ser append-only).
 * Tolerante a líneas vacías (la última línea de un archivo escrito con
 * `appendFile` siempre termina en `\n`, así que `split('\n')` deja un
 * elemento vacío al final) y a una sesión sin ningún evento todavía (el
 * archivo puede no existir si `devpilot session start` se corrió pero
 * ningún comando corrió todavía dentro de esa sesión).
 */
export async function readSessionEvents(rootPath: string, sessionId: string): Promise<SessionEvent[]> {
  const filePath = getProjectSessionEventsPath(rootPath, sessionId);
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const events: SessionEvent[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      events.push(JSON.parse(trimmed) as SessionEvent);
    } catch {
      // Línea corrupta (escritura interrumpida a mitad de camino, por
      // ejemplo) — se omite en vez de romper la lectura de todo el log;
      // el resto de la sesión sigue siendo legible.
      continue;
    }
  }
  return events;
}
