import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ContextPack } from '@devpilot/shared';
import { getProjectContextDir } from '../db/paths.js';

// `.devpilot/context/<fecha>-task-<seq>.md` + `.json` — el Context Pack
// SIEMPRE se persiste aquí (ver 03/04/07), nunca solo se muestra en
// pantalla, para poder auditar después "qué sabía la IA cuando propuso
// este cambio".

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

async function nextSequence(contextDir: string, datePrefix: string): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(contextDir);
  } catch {
    return 1;
  }
  const re = new RegExp(`^${datePrefix}-task-(\\d{3})\\.json$`);
  let max = 0;
  for (const entry of entries) {
    const match = re.exec(entry);
    if (match) {
      const n = Number(match[1]);
      if (n > max) max = n;
    }
  }
  return max + 1;
}

export interface ContextPackFilePaths {
  markdownPath: string;
  jsonPath: string;
}

/** Escribe el Context Pack en disco (Markdown para copiar/pegar, JSON para persistencia/auditoría) y devuelve las rutas usadas. */
export async function writeContextPackFiles(
  rootPath: string,
  pack: ContextPack,
  markdown: string,
): Promise<ContextPackFilePaths> {
  const contextDir = getProjectContextDir(rootPath);
  await mkdir(contextDir, { recursive: true });

  const datePrefix = todayIsoDate();
  const seq = await nextSequence(contextDir, datePrefix);
  const base = `${datePrefix}-task-${String(seq).padStart(3, '0')}`;

  const markdownPath = path.join(contextDir, `${base}.md`);
  const jsonPath = path.join(contextDir, `${base}.json`);

  await writeFile(markdownPath, markdown, 'utf8');
  await writeFile(jsonPath, JSON.stringify(pack, null, 2) + '\n', 'utf8');

  return { markdownPath, jsonPath };
}
