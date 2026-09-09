// Tipos del pipeline Parser → Validator (ver docs/architecture/06-providers-and-browser-bridge.md
// y 03). Igual que domain/types.ts: viven en @devpilot/shared porque tanto
// @devpilot/core (ChangeParser/ChangeValidator) como @devpilot/storage
// (tabla `file_change_proposals`) los necesitan.

export interface SearchReplacePatch {
  search: string;
  replace: string;
  // Cómo se obtuvo el corte search/replace — ver 06, "Segunda ronda de
  // evidencia", Hallazgo A. 'markers' si los delimitadores
  // <<<<<<< SEARCH/=======/>>>>>>> REPLACE aparecieron reconocibles;
  // 'recovered-prefix' si el divisor `=======` se perdió (hipótesis: se
  // interpretó como encabezado Setext de Markdown en el trayecto) y el
  // parser reconstruyó el corte probando el prefijo más largo que
  // coincide con el archivo real. El ChangeValidator usa esto para el
  // check `marker-well-formed`: 'recovered-prefix' nunca llega a `valid`.
  markerOrigin: 'markers' | 'recovered-prefix';
}

export type FileChangeOperation = 'create' | 'edit' | 'delete' | 'patch';
export type FileChangeFormat = 'devpilot-block' | 'json' | 'markdown-file' | 'diff' | 'fence-only';

export interface FileChangeProposal {
  path: string;
  operation: FileChangeOperation;
  format: FileChangeFormat;
  newContent?: string; // para create/edit de archivo completo
  diff?: string; // si la IA respondió en diff unificado
  patch?: SearchReplacePatch; // para operation='patch'
}

export interface ParsedResponse {
  changes: FileChangeProposal[];
  // Lo que la IA declaró explícitamente como decisión propia no confirmada
  // por el Context Pack (sección "## Decisiones que asumí" — Capa 1
  // endurecida, ver 06). Vacío no significa "no asumió nada": significa que
  // no incluyó la sección, lo cual el `ChangeValidator` no puede
  // distinguir de "no asumió nada" — por eso el heurístico
  // `undocumented-decision` sigue existiendo como respaldo.
  assumedDecisions: string[];
  // Texto que no se pudo mapear a ningún cambio de archivo reconocible.
  // Nunca se descarta — se muestra tal cual al usuario (ver 06, Hallazgo D:
  // a veces el propio modelo admite su incertidumbre en prosa suelta).
  unparsedNotes: string;
}

export type ValidationCheckName =
  | 'path-exists'
  | 'operation-valid'
  | 'search-match'
  | 'marker-well-formed'
  | 'whole-file-boundary-match'
  | 'naming-convention'
  | 'undocumented-decision';

export interface ValidationCheck {
  name: ValidationCheckName;
  passed: boolean;
  detail?: string;
}

export interface ValidationResult {
  status: 'valid' | 'warning' | 'reject';
  confidence: number; // 0-100
  checks: ValidationCheck[];
}
