import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { getProjectKnowledgeDir, getProjectKnowledgeFilePath } from '../db/paths.js';

// `.devpilot/knowledge/<id>.md` (03/04) — a diferencia del espejo de
// decisiones, ESTE archivo es la fuente de verdad del contenido (la fila
// en `knowledge_docs` es solo metadata + hash, ver knowledgeRepo.ts).

/** Hash determinístico del contenido — permite a `devpilot knowledge generate` detectar si el contenido inferido realmente cambió antes de reescribir el archivo y bump-ear `updated_at` (ver knowledgeService.ts). */
export function hashKnowledgeContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Escribe (o re-escribe) el contenido de un knowledge doc por `id` y devuelve la ruta absoluta usada. */
export async function writeKnowledgeFile(rootPath: string, id: string, content: string): Promise<string> {
  await mkdir(getProjectKnowledgeDir(rootPath), { recursive: true });
  const filePath = getProjectKnowledgeFilePath(rootPath, id);
  await writeFile(filePath, content, 'utf8');
  return filePath;
}

/** `null` si el doc no tiene archivo todavía (no debería pasar para un doc que ya está en `knowledge_docs`, pero es más seguro que lanzar si alguien borró el archivo a mano). */
export async function readKnowledgeFile(rootPath: string, id: string): Promise<string | null> {
  try {
    return await readFile(getProjectKnowledgeFilePath(rootPath, id), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}
