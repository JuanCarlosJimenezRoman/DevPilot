# 05 — Tool Engine y seguridad (Fase G)

## Nota de implementación (2026-09-09, `devpilot apply` — ver 07)

Este documento es el diseño original (Fase G); la primera implementación real llegó con `devpilot apply` (Incremento 1), que es la primera vez que DevPilot escribe algo en el disco del usuario. El detalle completo de la validación está en 07; acá solo lo que difiere o restringe el diseño de abajo:

- Implementado en `packages/core/src/tools/permissionGuard.ts`. Cubre únicamente `create_file` / `edit_file` / `apply_patch` (riesgo `write`) y `delete_file` (riesgo `delete`) — los únicos que `devpilot apply` necesita hoy. `run_command` (`TERMINAL`) y `git_commit` (`GIT_COMMIT`) siguen sin código: no hay todavía ningún consumidor real de esos dos, así que `RiskLevel` en el código es por ahora solo `'write' | 'delete'`, no la unión completa de seis niveles de la interfaz de diseño de abajo. Se amplía cuando exista un comando que de verdad ejecute terminal o commits.
- `PathGuard` no quedó como módulo separado — en la práctica es un solo chequeo ("¿la ruta resuelta cae dentro de `project.rootPath`?") integrado en la misma `evaluatePermission()` de `PermissionGuard`. Se evalúa dos veces: al armar el plan de aplicación y otra vez justo antes de escribir a disco (`applyChange`), como defensa en profundidad real.
- `requiresApproval` es siempre `true` en la implementación actual — no existe todavía ninguna herramienta con aprobación automática además de `READ`/`SEARCH` (que ni siquiera pasan por `PermissionGuard`), así que ese campo no varía en la práctica hasta que se implemente algo de riesgo `read` fuera del root.
- El flag `--yes-to write` mencionado abajo como posibilidad ya existe tal cual en `devpilot apply`, y `delete` en efecto nunca es bypassable — se valida explícitamente en el CLI (rechaza `--yes-to delete` con un error antes de construir el plan).

## Herramientas y niveles de riesgo

Refino la tabla original agregando una categoría `NETWORK` (llamadas salientes) y aclarando que incluso `READ` fuera del root del proyecto requiere aprobación (no solo escritura):

| Herramienta | Riesgo | Comportamiento por defecto |
|---|---|---|
| `list_files()` | READ | automático |
| `read_file(path)` | READ | automático **si `path` está dentro del root del proyecto**; requiere aprobación si está fuera |
| `search_code(query)` | SEARCH | automático |
| `git_status()` / `git_diff()` / `git_log()` | READ | automático |
| `create_file(path, content)` | WRITE | muestra el contenido propuesto → requiere aprobación |
| `edit_file(path, patch)` | WRITE | muestra diff → requiere aprobación |
| `apply_patch(patch)` | WRITE | muestra diff completo antes de tocar disco → requiere aprobación. Solo recibe propuestas que ya pasaron por el `ChangeValidator` (06) como `valid` o como `warning` resuelto explícitamente por el usuario — nunca la salida cruda del parser. |
| `delete_file(path)` | DELETE | aprobación obligatoria, sin excepción, sin flag de bypass |
| `run_command(cmd)` | TERMINAL | muestra el comando exacto → aprobación obligatoria; opcionalmente contra una allowlist/denylist en `config.json` |
| `git_commit(message, paths)` | GIT_COMMIT | muestra diff + mensaje → aprobación obligatoria |
| *(fuera de alcance v1)* `git_push` | — | **no se implementa en v1.** No estaba en la lista original y deliberadamente lo dejo fuera: publicar cambios a un remoto es una categoría de riesgo distinta (afecta a otras personas/CI) que merece su propio diseño explícito más adelante, no colarse como "otra operación de Git más". |

## PermissionGuard

Middleware por el que pasa toda invocación del Tool Engine:

```ts
interface PermissionGuard {
  evaluate(tool: ToolName, params: unknown): PermissionDecision;
}

interface PermissionDecision {
  riskLevel: 'read' | 'search' | 'write' | 'delete' | 'terminal' | 'git-commit';
  requiresApproval: boolean;
  reason?: string;             // p.ej. "ruta fuera del proyecto"
}
```

El CLI, al recibir `requiresApproval: true`, presenta al usuario el diff/comando exacto y espera confirmación (`y/N`). No existe un modo "aprobar todo" implícito en v1; puede existir un flag explícito como `--yes-to write` para operaciones de bajo riesgo repetitivas, pero `delete`, `terminal` y `git-commit` **nunca** son bypassables por flag global — solo confirmando cada una.

## PathGuard

Toda ruta pasada a una herramienta de filesystem se resuelve a absoluta y se valida como subruta de `project.rootPath`. Fuera de esa raíz, la operación se trata como si tocara un recurso externo: requiere aprobación explícita incluso para lectura, y queda registrada igual que cualquier otra operación sensible.

## Auditoría

Cada invocación (aprobada o no) se registra en `tool_invocations` (ver 03): herramienta, nivel de riesgo, parámetros, si fue aprobada, cuándo, y un resumen del resultado. Esto da trazabilidad completa de qué tocó el proyecto y cuándo, sin depender de la memoria del usuario ni del historial de Git (que no captura, por ejemplo, comandos de terminal ejecutados que no generaron commit).

## `run_command` — la herramienta más delicada

Recomendaciones específicas más allá de "requiere aprobación":

- Mostrar siempre el comando **literal**, nunca una descripción resumida.
- Ejecutar en el directorio del proyecto, nunca con `cwd` arbitrario.
- Permitir al usuario configurar en `.devpilot/config.json` una allowlist (ej. `npm test`, `pnpm build`) que sigue pidiendo confirmación pero puede mostrarse pre-aprobada visualmente, y una denylist explícita (ej. patrones como `rm -rf`, `git push --force`) que **nunca** se ejecuta aunque el usuario confirme por error — se le pide confirmar dos veces con una advertencia clara.
- Timeout configurable por comando para evitar procesos colgados bloqueando la sesión de DevPilot indefinidamente.
