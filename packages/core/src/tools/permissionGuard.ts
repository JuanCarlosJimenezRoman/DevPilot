import path from 'node:path';

// PermissionGuard + PathGuard (ver docs/architecture/05-tool-engine-and-security.md)
// — el middleware por el que pasa toda invocación del Tool Engine.
// `devpilot apply` es la primera pieza que existe como código y que
// escribe al disco del usuario, así que es la primera vez que este módulo
// tiene un consumidor real.
//
// v1 es deliberadamente angosto: los únicos tools que `devpilot apply`
// invoca son los de escritura de archivo (`create_file`/`edit_file`/
// `apply_patch`, riesgo `write`) y borrado (`delete_file`, riesgo
// `delete`). `run_command`/`git_commit` (riesgo `terminal`/`git-commit`)
// no existen todavía como código — no hay ninguna pieza del roadmap que
// los necesite aún.
//
// 05 es explícito: "No existe un modo 'aprobar todo' implícito en v1" —
// `requiresApproval` es SIEMPRE `true` para write y delete. Lo único que
// decide el flujo de aprobación es si el CLI puede pre-aprobar
// visualmente un `write` vía `--yes-to write` (nunca un `delete`: "sin
// excepción, sin flag de bypass", 05).

export type ToolName = 'create_file' | 'edit_file' | 'apply_patch' | 'delete_file';
export type RiskLevel = 'write' | 'delete';

export interface PermissionDecision {
  riskLevel: RiskLevel;
  requiresApproval: true;
  /** Presente cuando PathGuard detecta algo fuera de lo normal (ruta fuera del proyecto) — ver evaluatePermission. */
  reason?: string;
}

const TOOL_RISK: Record<ToolName, RiskLevel> = {
  create_file: 'write',
  edit_file: 'write',
  apply_patch: 'write',
  delete_file: 'delete',
};

/** `FileChangeProposal.operation` → el tool del Tool Engine que le corresponde (05, tabla de herramientas). */
export function toolNameForOperation(operation: string): ToolName {
  switch (operation) {
    case 'create':
      return 'create_file';
    case 'delete':
      return 'delete_file';
    case 'patch':
      return 'apply_patch';
    case 'edit':
    default:
      return 'edit_file';
  }
}

/**
 * PathGuard (05): toda ruta se resuelve a absoluta y se valida como
 * subruta de `projectRoot`. En la práctica, `devpilot apply` no debería
 * llegar aquí nunca con una ruta fuera del proyecto — el check
 * `path-exists` del `ChangeValidator` (06) ya rechaza esas propuestas en
 * `devpilot import`, antes de que lleguen a ser `valid`/`warning`. Esta
 * evaluación es defensa en profundidad, no la única barrera: se repite
 * literalmente otra vez, justo antes de escribir a disco, en
 * `applyService.ts`.
 */
export function evaluatePermission(tool: ToolName, absPath: string, projectRoot: string): PermissionDecision {
  const resolvedRoot = path.resolve(projectRoot);
  const resolvedPath = path.resolve(absPath);
  const withinProject = resolvedPath === resolvedRoot || resolvedPath.startsWith(resolvedRoot + path.sep);

  return {
    riskLevel: TOOL_RISK[tool],
    requiresApproval: true,
    reason: withinProject ? undefined : 'la ruta cae fuera de la raíz del proyecto',
  };
}
