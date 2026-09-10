import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DecisionRow } from '../repos/decisionRepo.js';
import { getProjectDecisionsDir } from '../db/paths.js';

// `.devpilot/decisions/<id>.md` — espejo legible de una Decision Record
// (ver getProjectDecisionsDir en paths.ts para por qué esto es opcional y
// no la fuente de verdad). Formato tipo ADR liviano, como lo describe 04.

function renderDecisionMarkdown(row: DecisionRow): string {
  const lines: string[] = [];
  lines.push(`# ${row.title}`);
  lines.push('');
  lines.push(`- **Estado:** ${row.status}`);
  lines.push(`- **Creada:** ${row.createdAt}`);
  if (row.tags.length > 0) lines.push(`- **Tags:** ${row.tags.join(', ')}`);
  if (row.relatedFiles.length > 0) lines.push(`- **Archivos relacionados:** ${row.relatedFiles.join(', ')}`);
  lines.push('');
  lines.push('## Contexto');
  lines.push('');
  lines.push(row.context);
  lines.push('');
  lines.push('## Decisión');
  lines.push('');
  lines.push(row.decision);
  if (row.consequences) {
    lines.push('');
    lines.push('## Consecuencias');
    lines.push('');
    lines.push(row.consequences);
  }
  lines.push('');
  return lines.join('\n');
}

/** Escribe (o re-escribe, ej. tras `devpilot decide supersede`) el espejo Markdown de una Decision Record. La ruta es determinística por `id` — no hace falta guardarla en la base. */
export async function writeDecisionFile(rootPath: string, row: DecisionRow): Promise<string> {
  const decisionsDir = getProjectDecisionsDir(rootPath);
  await mkdir(decisionsDir, { recursive: true });
  const filePath = path.join(decisionsDir, `${row.id}.md`);
  await writeFile(filePath, renderDecisionMarkdown(row), 'utf8');
  return filePath;
}
