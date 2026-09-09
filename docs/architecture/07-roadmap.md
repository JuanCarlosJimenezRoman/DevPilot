# 07 — Roadmap e incrementos (Fase J)

> **Revisado con Juan (2026-09-09).** Esta versión reemplaza el roadmap inicial: el Incremento 1 queda aún más angosto de lo propuesto originalmente — ni siquiera incluye Project Knowledge/Session Memory/Decision Records todavía — para poder validar la hipótesis central lo antes posible y con datos medibles, no solo con intuición.

Principio: cada incremento debe terminar en algo que se pueda ejecutar y probar de punta a punta. La hipótesis central que hay que probar primero, y de la que depende todo lo demás, es angosta y concreta:

```
Proyecto
 ↓
Contexto persistente (mínimo)
 ↓
Context Pack
 ↓
IA web (DeepSeek / Claude / ChatGPT)
 ↓
Respuesta
 ↓
Import (parser de 3 capas)
 ↓
Diff
 ↓
Apply
```

Si esta cadena funciona, el resto del roadmap es incrementar sofisticación sobre una base ya validada. Si no funciona, ninguna otra pieza (Git, Claude Code, memoria persistente) importa todavía.

## Paso 0 — Validación manual del contrato de respuesta (sin código) — ✅ HECHO (2026-09-09)

Se tomó una tarea real de "Camino al Deporte" (calcular `TamanoPaquete` a partir del carrito, en vez de usar `MEDIANO` fijo), se redactó a mano un Context Pack real (~3,850 tokens, 5 archivos/fragmentos con score de relevancia) siguiendo el contrato de 06, y se probó contra DeepSeek Web y Claude Web (ChatGPT).

**Resultado: hipótesis central validada — con matices reales que ya están incorporados al diseño.**

```
✅ Context Pack comprensible sin explicación adicional
✅ Ambos modelos ubicaron los archivos correctos con contexto reducido
✅ El contrato DEVPILOT_CHANGE / SEARCH-REPLACE es entendible
⚠️ Los modelos pueden inventar decisiones de negocio no documentadas
   (DeepSeek: umbrales de volumen/peso que no estaban en el pack)
⚠️ Un fallback silencioso mal pensado puede colar un riesgo de negocio
   (DeepSeek: dimensiones desconocidas → 0 → clasificado como CHICO)
⚠️ El formato de patch puede salir ligeramente inválido incluso con buen
   razonamiento (ChatGPT: marcadores SEARCH/REPLACE mal formados)
```

Ninguna de las dos respuestas debía aplicarse tal cual llegó — y ese hallazgo, con evidencia real de dos modelos distintos fallando por razones distintas, es lo que justificó separar un `ChangeValidator` explícito del `ChangeParser` y añadir la sección "Decisiones del negocio: confirmadas vs. abiertas" al propio Context Pack. Ambos cambios ya están incorporados en 02, 03, 04 y 06 — no son trabajo pendiente de diseño, son parte del Incremento 1 desde ahora.

**Segunda ronda (misma tarea, mismo Context Pack sin el contrato endurecido aún):** se corrió la lógica del `ChangeValidator` a mano contra los archivos reales del proyecto. Confirmó que el divisor `=======` de los patches puede perderse en el trayecto (probable causa: Markdown lo interpreta como encabezado Setext) sin que el contenido de `SEARCH` en sí esté mal — y expuso el hallazgo más serio hasta ahora: una respuesta sin marcadores de patch que presenta solo un fragmento de `schema.prisma` con el comentario de la ruta real, que de haberse tratado como "reemplazo de archivo completo" habría borrado el esquema entero. Se agregaron dos checks nuevos al `ChangeValidator` (`whole-file-boundary-match`, `naming-convention`) y una recuperación heurística por prefijo más largo (siempre a `warning`, nunca a `valid`) para el divisor perdido. Detalle completo en 06.

## Incremento 0 — Andamiaje

- Monorepo pnpm (`apps/cli`, `packages/core`, `packages/storage`, `packages/shared`), TypeScript estricto, lint, build.
- `devpilot --version` funcionando end-to-end como humo del setup.

## Incremento 1 — "Proof of Context"

Objetivo único: demostrar la cadena completa Proyecto → Contexto → IA web → Respuesta → Import → Diff → Apply, con la menor cantidad de piezas posible.

- ✅ **HECHO (2026-09-09) — Scanner + `devpilot project add`/`project list`.** `devpilot project add <ruta>` → Scanner detecta stack (lenguaje/framework/package manager/ORM/base de datos/Docker/Git presente) → Project Snapshot persistido (registro global en `~/.devpilot/registry.db` + estado y snapshot local en `.devpilot/devpilot.db` + `.devpilot/state/snapshot.json`, ver 03). Implementado en `@devpilot/storage` (paths/schema/connection/repos de `projects` y `project_state`, FileStore de snapshot) y `@devpilot/core` (`fileWalker`, `scanner`, `projectService`), expuesto en el CLI como `project add`/`project list`. Verificado de punta a punta: build + lint limpios, y `project add` corrido con éxito tanto sobre el propio repo de DevPilot como sobre el proyecto real Camino al Deporte (296 archivos, detectó correctamente Next.js + npm + Prisma + PostgreSQL + el commit de Git actual). De paso resuelto: la dependencia circular potencial entre `@devpilot/core` y `@devpilot/storage` (los tipos de dominio se movieron a `@devpilot/shared`, que no depende de nada — ver `packages/shared/src/domain/types.ts`), y el desalineamiento entre el esquema SQL de `projects` (03) y el tipo `Project` (le faltaban `vcs` y `updated_at`, ya corregido en 03 y en el código).
- `devpilot context "<tarea>"` → Context Planner **simple y medible, no "superinteligente"**: coincidencias de texto/nombre + imports directos + proximidad de rutas (Nivel 1 + Nivel 2 de 04, nada de AST ni Git todavía) → Relevance Scoring v1 con razones explicables → Token Estimate → Context Pack exportado a Markdown y JSON, **siempre persistido en `.devpilot/context/`** (nunca solo mostrado en pantalla — se audita después qué sabía la IA), y copiado al portapapeles. **(Pendiente — siguiente sub-tarea del Incremento 1.)**
- `devpilot context "<tarea>"` → Context Planner **simple y medible, no "superinteligente"**: coincidencias de texto/nombre + imports directos + proximidad de rutas (Nivel 1 + Nivel 2 de 04, nada de AST ni Git todavía) → Relevance Scoring v1 con razones explicables → Token Estimate → Context Pack exportado a Markdown y JSON, **siempre persistido en `.devpilot/context/`** (nunca solo mostrado en pantalla — se audita después qué sabía la IA), y copiado al portapapeles.
- El usuario pega el pack en DeepSeek Web / Claude Web / ChatGPT, conversa, y copia la respuesta.
- `devpilot import <archivo-o-texto>` → `ChangeParser` (Capa 2 de 06): reconoce varios formatos con tolerancia sintáctica (incluye marcadores SEARCH/REPLACE mal formados, ver 06), nunca descarta texto sin explicarlo.
- `ChangeValidator` (nuevo, ver 06) → cada cambio detectado se evalúa (ruta válida, operación válida, SEARCH coincide con el archivo actual, marcadores reconstruibles, decisión de negocio no documentada) y termina en `valid` / `warning` / `reject` con un `confidence` 0-100 — nunca pasa directo a `apply`.
- `devpilot diff` → muestra diff de los `valid`; los `warning` se presentan como una decisión a tomar (no como un hecho consumado), los `reject` se explican y no se ofrecen para aplicar.
- `devpilot apply` → aplica cambios `valid` o `warning` ya resueltos por el usuario, uno por uno, con confirmación (Tool Engine, riesgo `WRITE`), registrado en `tool_invocations`.
- **Benchmark automático por tarea** (`task_benchmarks`, ver 03/04): tokens enviados, archivos incluidos vs. usados, cambios importados vs. aplicados, resultado. Esto es parte del Incremento 1, no un "nice to have" posterior — es como se mide si la hipótesis central realmente funciona.

Lo que **no** entra en el Incremento 1: Project Knowledge, Session Memory, Decision Records (pasan al Incremento 2), Git más allá de detectar que existe, símbolos/AST, Claude Code, análisis semántico.

**Criterio de éxito:** repetir en código lo que ya se demostró a mano en el Paso 0 — Context Pack real, respuesta de un chat web real, y que el `ChangeParser` + `ChangeValidator` clasifiquen correctamente los cambios de DeepSeek/ChatGPT como `warning`/`reject` en vez de aplicarlos ciegamente — con métricas de benchmark que respalden la afirmación de ahorro de contexto.

## Incremento 2 — "Project Memory"

- Project Knowledge (`knowledge_docs` + `.devpilot/knowledge/*.md`), inicialmente poblado por heurísticas del Scanner (`source: 'inferred'`) y editable a mano (`source: 'manual'`).
- Session Memory real (más allá de un log plano) y promoción de eventos de sesión relevantes.
- Decision Records (`devpilot decide "<título>"`).
- Refresco incremental de Project State.

## Incremento 3 — "Git Intelligence"

- `git status` / `git diff` / `git log` vía `GitAdapter` (02).
- Reindexado incremental basado en `lastIndexedCommit` + `git diff --name-status` (evita rescanear todo el árbol).
- Extracción de símbolos (AST ligero) → Nivel 3 del Context Planner.
- Nivel 4: boost de relevancia por recencia en Git y afinidad con mensajes de commit.
- Context Compaction para packs 🔴.

## Incremento 4 — "Claude Code"

- `devpilot analyze --deep` → `ClaudeCodeProvider` en modo de solo lectura/plan → propone contenido para `knowledge_docs` (arquitectura, módulos, reglas de negocio, decisiones detectadas) → el usuario aprueba el diff antes de escribir (mismo flujo de aprobación del Tool Engine).
- `lastDeepAnalysisCommit` para saber qué cambió desde el último análisis profundo.

## Incremento 5 — "Browser Bridge"

- `apps/browser-extension` con adapters específicos por sitio (`deepseek-web`, `claude-web`, `chatgpt-web`) que automatizan el copiar/pegar físico como conveniencia de UX. El parseo de respuesta sigue siendo el mismo contrato de tres capas de 06 — la extensión nunca es una dependencia funcional, solo ahorra clics.

## Más adelante (exploratorio)

- `devpilot analyze` con otros proveedores (DeepSeek API, OpenAI API) detrás de la misma interfaz `AIProvider`, siempre BYOAI.
- Desktop UI (Electron + React + Vite) como cliente fino de la API programática de `core`.
- Soporte multi-lenguaje más allá de TypeScript/JavaScript.
- Capa semántica local opcional (Nivel 5), solo si el benchmark del Incremento 1-3 demuestra que el scoring heurístico es insuficiente en la práctica.

---

**Siguiente paso concreto:** el Paso 0 ya se hizo y el resultado fue alentador (con matices ya incorporados al diseño). El primer código que escribimos es el Incremento 0 + el Scanner del Incremento 1.
