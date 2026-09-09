import { existsSync, statSync } from 'node:fs';
import { applyPatch } from 'diff';
import type { FileChangeProposal } from '@devpilot/shared';
import { safeReadTextFile } from './fileReading.js';
import { findDedentTolerantMatch } from './matching.js';

// Reconstrucción del contenido real que resultaría de aplicar una
// propuesta — compartida por `devpilot diff` (para mostrarlo) y `devpilot
// apply` (para escribirlo de verdad). Un solo lugar que decide "qué
// contenido resultaría de esto" evita que diff y apply puedan divergir en
// silencio sobre qué es lo que en realidad se está aplicando.

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

export type ReconstructionResult = { oldContent: string; newContent: string } | { error: string };

/**
 * Reconstruye `{ oldContent, newContent }` según la operación/formato de la
 * propuesta, o un mensaje de error legible si no se puede (archivo
 * inexistente para edit/delete/patch, `SEARCH` que ya no matchea, diff que
 * ya no aplica limpio, etc.). Nunca escribe nada — solo calcula.
 *
 * Para `patch` reutiliza la misma tolerancia de indentación que el
 * `ChangeValidator` (`findDedentTolerantMatch`, ver matching.ts) — un patch
 * que pasó `search-match` en `devpilot import` debe seguir pudiéndose
 * reconstruir aquí sin volver a decidir si "coincide".
 *
 * Para `format: 'diff'` (edit con un diff unificado ya armado por la IA) se
 * usa `applyPatch` de `diff` (jsdiff) para aplicarlo contra el contenido
 * real — esto cierra una superficie que el `ChangeValidator` (06) no
 * cubre: ni `search-match` ni `whole-file-boundary-match` se evalúan para
 * esta combinación de operation/format, así que hasta ahora un diff que ya
 * no aplicaba limpio contra el archivo actual no se detectaba hasta este
 * punto — que es exactamente donde `devpilot apply` necesita saberlo antes
 * de escribir nada (documentado como pendiente en 07, entrada de
 * `devpilot diff`).
 */
export function reconstructChangeContent(proposal: FileChangeProposal, absPath: string): ReconstructionResult {
  const exists = existsSync(absPath) && statSync(absPath).isFile();
  let oldContent = '';
  if (exists) {
    const read = safeReadTextFile(absPath);
    if (read === null) {
      return { error: 'No se pudo leer el archivo real (¿binario o demasiado grande?).' };
    }
    oldContent = normalizeNewlines(read);
  }

  switch (proposal.operation) {
    case 'create':
      return { oldContent, newContent: normalizeNewlines(proposal.newContent ?? '') };

    case 'delete':
      if (!exists) return { error: 'El archivo ya no existe — nada que borrar.' };
      return { oldContent, newContent: '' };

    case 'patch': {
      if (!proposal.patch) return { error: 'No hay un bloque SEARCH/REPLACE reconocible en esta propuesta.' };
      if (!exists) return { error: 'El archivo no existe — no hay contra qué aplicar el patch.' };
      const match = findDedentTolerantMatch(proposal.patch.search, oldContent);
      if (!match) {
        return {
          error:
            'El fragmento SEARCH no se ubica en el contenido actual del archivo (coincide con `search-match` en `devpilot import` — probablemente el archivo cambió desde entonces).',
        };
      }
      const newContent =
        oldContent.slice(0, match.start) + normalizeNewlines(proposal.patch.replace) + oldContent.slice(match.end);
      return { oldContent, newContent };
    }

    case 'edit':
    default: {
      if (proposal.format === 'diff' && proposal.diff) {
        if (!exists) return { error: 'El archivo no existe — no hay contra qué aplicar el diff.' };
        const applied = applyPatch(oldContent, proposal.diff, { fuzzFactor: 0 });
        if (applied === false) {
          return {
            error:
              'El diff no aplica limpio contra el contenido actual del archivo — probablemente cambió desde que se generó (ver 07, superficie sin cubrir de `format: "diff"`: el ChangeValidator no tiene un check para este formato, así que esto no se detecta hasta este punto).',
          };
        }
        return { oldContent, newContent: normalizeNewlines(applied) };
      }
      // formatos de archivo completo: 'devpilot-block', 'markdown-file', 'fence-only'.
      if (proposal.newContent === undefined) {
        return { error: 'No hay contenido nuevo para comparar contra el archivo real.' };
      }
      return { oldContent, newContent: normalizeNewlines(proposal.newContent) };
    }
  }
}
