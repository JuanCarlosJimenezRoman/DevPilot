import { dedentTolerantIncludes } from './matching.js';

// Recuperación heurística cuando el divisor `=======` de un patch
// SEARCH/REPLACE se pierde (ver 06, Hallazgo A) — probar prefijos de
// longitud creciente contra el archivo real y tomar el prefijo exacto MÁS
// LARGO que coincida como `SEARCH`, el resto como `REPLACE`. Deliberado:
// solo se usa para llegar a `warning` (nunca a `valid` directo, ver
// `SearchReplacePatch.markerOrigin` en @devpilot/shared) — es una
// recuperación de una ambigüedad de formato, no una confirmación de que el
// cambio es correcto.
export interface RecoveredSplit {
  search: string;
  replace: string;
}

export function recoverSearchReplaceSplit(between: string, realFileContent: string): RecoveredSplit | null {
  const lines = between.split('\n');
  // de más largo a más corto: el prefijo MÁS LARGO que coincida gana
  for (let k = lines.length; k >= 1; k--) {
    const candidate = lines.slice(0, k).join('\n');
    if (dedentTolerantIncludes(candidate, realFileContent)) {
      return { search: candidate, replace: lines.slice(k).join('\n') };
    }
  }
  return null;
}
