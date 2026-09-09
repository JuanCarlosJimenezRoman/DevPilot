import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FileChangeProposal, ValidationResult } from '@devpilot/shared';
import { getProjectChangesDir } from '../db/paths.js';

// `.devpilot/changes/<proposal-id>.json` (ver 03, sección "Layout de
// .devpilot/ en disco" — este directorio se agrega en la misma fase que
// `devpilot diff`, que es quien primero necesita reconstruir el cambio
// completo, no solo su metadata).
//
// Bug de diseño encontrado al implementar `devpilot diff`, no al implementar
// `devpilot import`: `file_change_proposals` (03) solo persiste metadata
// (ruta, operación, formato, estado de validación, confidence...) — nunca
// el contenido real de la propuesta (`newContent`/`diff`/`patch`). Eso
// bastaba para auditar "qué se detectó y cómo se clasificó", pero no
// alcanza para `devpilot diff`, que necesita reconstruir el diff real
// contra el archivo actual. Mismo principio que `contextPackStore.ts`
// (contenido largo en archivo, la fila en SQLite solo apunta a la ruta):
// aquí un archivo por propuesta, nombrado por su id, para que la fila de
// `file_change_proposals` (columna `proposal_path`, ver `schema.ts`) pueda
// recuperarlo por id sin tener que volver a parsear la respuesta cruda de
// la IA (que ni siquiera se conserva en ningún lado).

export interface PersistedChangeProposal {
  proposal: FileChangeProposal;
  validation: ValidationResult;
}

/** Escribe la propuesta completa (forma reconocida por el parser + resultado del validador) y devuelve la ruta usada. */
export async function writeChangeProposalFile(
  rootPath: string,
  proposalId: string,
  data: PersistedChangeProposal,
): Promise<string> {
  const dir = getProjectChangesDir(rootPath);
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${proposalId}.json`);
  await writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return filePath;
}

/** Lee de vuelta una propuesta completa por su ruta (guardada en `file_change_proposals.proposal_path`). */
export async function readChangeProposalFile(filePath: string): Promise<PersistedChangeProposal> {
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw) as PersistedChangeProposal;
}
