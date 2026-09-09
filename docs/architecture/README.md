# DevPilot — Documentación de arquitectura

Esta carpeta es, deliberadamente, un ejemplo en miniatura de lo que DevPilot va a hacerle a *otros* proyectos: conocimiento persistente, dividido en documentos pequeños y con un propósito claro, en vez de un único archivo gigante.

Orden recomendado de lectura:

1. **01-vision-and-validation.md** — el problema, la filosofía, y una revisión crítica honesta de la propuesta original (Fase A).
2. **02-architecture-and-repo-structure.md** — módulos, flujo de datos, seguridad, estructura del monorepo, contratos TypeScript principales (Fases B, D, E).
3. **03-data-model.md** — esquema SQLite completo (Fase C).
4. **04-context-engine.md** — Scanner, Indexer, Snapshot, Knowledge, State, Session Memory, Decision Records, Context Planner, relevance scoring, token budget, compaction (Fase F).
5. **05-tool-engine-and-security.md** — herramientas, niveles de riesgo, permisos (Fase G).
6. **06-providers-and-browser-bridge.md** — abstracción de proveedores de IA, integración con Claude Code, Browser Bridge agnóstico de sitio (Fases H, I).
7. **07-roadmap.md** — incrementos pequeños y el primer incremento real que se puede programar y probar (Fase J).

Estado: **fase de diseño, sin código todavía.** Estos documentos son la base para validar la arquitectura antes de escribir la primera línea de código, tal como se pidió explícitamente al iniciar el proyecto (2026-09-09).
