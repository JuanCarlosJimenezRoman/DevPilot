# DevPilot

Capa local de contexto, memoria y herramientas para proyectos de software — agnóstica del proveedor de IA (BYOAI). La IA no es la memoria del proyecto; DevPilot lo es.

Fase actual: **Incremento 0 (andamiaje)**. Ver `docs/architecture/` para el diseño completo (Fases A-J), incluyendo el resultado de las dos rondas de validación real del Paso 0 antes de escribir este código.

## Estructura

- `apps/cli` — interfaz de línea de comandos (`devpilot`).
- `packages/core` — Project Engine, Context Engine, Tool Engine, Provider Layer.
- `packages/storage` — repositorios SQLite + almacenamiento en archivos (`.devpilot/`).
- `packages/shared` — utilidades sin dependencias de dominio.

Cada subcarpeta vacía de `packages/core/src/` tiene un `README.md` que indica qué va ahí y en qué incremento del roadmap se implementa — ver `docs/architecture/07-roadmap.md`.

## Desarrollo

```bash
pnpm install
pnpm devpilot --version
pnpm devpilot doctor
pnpm build
```
