# 03 — Modelo de datos SQLite (Fase C)

## Principio de diseño

SQLite guarda **metadata consultable** (índices, referencias, estado, bitácora). El **contenido largo** (conocimiento del proyecto, context packs, logs de sesión) vive como archivos Markdown/JSON en `.devpilot/`, y la fila en SQLite solo apunta a esa ruta. Esto mantiene la base de datos pequeña, rápida, y hace que el contenido importante sea legible/versionable con Git si el usuario decide commitear `.devpilot/` (opcional, decisión del usuario).

## Dos niveles de almacenamiento, no uno (confirmado con Juan)

- **Global** (`~/.devpilot/`): sabe qué proyectos existen, dónde están, cuál es el activo, preferencias del usuario y proveedores configurados. Nunca contiene memoria/conocimiento de un proyecto específico.
- **Local por proyecto** (`<proyecto>/.devpilot/`): sabe memoria, snapshot, estado, decisiones, sesiones, índices y contextos de ESE proyecto. Es portátil a propósito — si el usuario mueve o comparte la carpeta (o la versiona con Git), su conocimiento viaja con ella. El registro global, si se pierde, simplemente se reconstruye con `devpilot project add` de nuevo; no es fuente de verdad de nada de negocio.

## Global (`~/.devpilot/`)

```
~/.devpilot/
├── config/
│   ├── preferences.json     -- proyecto activo, idioma, formato de salida por defecto
│   └── providers.json       -- proveedores configurados y su provider por defecto (API keys nunca en texto plano sin avisar)
├── registry.db
└── projects/
    └── <project-id>/
        └── cache.json        -- espejo liviano y opcional: nombre, ruta, resumen del último snapshot, last_opened_at
```

`registry.db`:

```sql
CREATE TABLE projects (
  id              TEXT PRIMARY KEY,        -- uuid
  name            TEXT NOT NULL,
  root_path       TEXT NOT NULL UNIQUE,
  vcs             TEXT NOT NULL DEFAULT 'none',   -- 'git' | 'none'
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  last_opened_at  TEXT
);
```

(Corregido durante la implementación del Scanner: la versión original de esta tabla no tenía `vcs` ni `updated_at`, y no coincidía con el tipo de dominio `Project` — ver `packages/shared/src/domain/types.ts`. `updated_at` cambia con cualquier actualización del registro; `last_opened_at` es específicamente la última vez que `devpilot project add` tocó ese proyecto.)

`projects/<project-id>/cache.json` existe solo como optimización: permite que `devpilot project list` muestre un resumen (stack detectado, última actividad) sin tener que abrir la base de datos de cada proyecto uno por uno. Es descartable y regenerable — nunca se lee como fuente de verdad, siempre se reconstruye desde `<proyecto>/.devpilot/` si falta o está desactualizado. El "proyecto activo" vive en `config/preferences.json`, no en `registry.db`, porque es una preferencia de sesión del usuario, no un dato del catálogo de proyectos.

## Base por proyecto (`.devpilot/devpilot.db`)

```sql
-- Estado general del proyecto (fila única, o clave/valor genérica)
-- El tipo de dominio ProjectState (ver packages/shared/src/domain/types.ts)
-- incluye snapshotPath para reflejar exactamente esta columna.
CREATE TABLE project_state (
  project_id              TEXT PRIMARY KEY,
  last_indexed_commit     TEXT,
  last_deep_analysis_commit TEXT,
  last_scan_at            TEXT,
  snapshot_version        INTEGER NOT NULL DEFAULT 0,
  snapshot_path           TEXT              -- .devpilot/state/snapshot.json
);

-- Índice de archivos
CREATE TABLE files (
  id                TEXT PRIMARY KEY,
  path              TEXT NOT NULL UNIQUE,   -- relativo al root del proyecto
  hash              TEXT NOT NULL,          -- sha256 del contenido
  language          TEXT,
  size_bytes        INTEGER,
  last_modified     TEXT,
  last_seen_commit  TEXT,
  indexed_at        TEXT NOT NULL
);
CREATE INDEX idx_files_path ON files(path);

-- Grafo de imports/dependencias (incremento 2, tabla existe desde v1 para no migrar después)
CREATE TABLE file_edges (
  id            TEXT PRIMARY KEY,
  from_file_id  TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  to_file_id    TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL DEFAULT 'import'   -- 'import' | 'test-of' | ...
);
CREATE INDEX idx_edges_from ON file_edges(from_file_id);
CREATE INDEX idx_edges_to   ON file_edges(to_file_id);

-- Símbolos (funciones/clases/exports) — poblada desde incremento 2
CREATE TABLE symbols (
  id          TEXT PRIMARY KEY,
  file_id     TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,        -- 'function' | 'class' | 'interface' | 'const' | ...
  line_start  INTEGER,
  line_end    INTEGER,
  is_exported INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_symbols_name ON symbols(name);
CREATE INDEX idx_symbols_file ON symbols(file_id);

-- Índice de Project Knowledge (el contenido vive en .devpilot/knowledge/*.md)
CREATE TABLE knowledge_docs (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,       -- 'architecture' | 'modules' | 'database' | 'business-rules' | 'conventions' | 'custom'
  title        TEXT NOT NULL,
  path         TEXT NOT NULL,       -- .devpilot/knowledge/<slug>.md
  content_hash TEXT NOT NULL,
  source       TEXT NOT NULL,       -- 'manual' | 'deep-analysis' | 'inferred'
  updated_at   TEXT NOT NULL
);

-- Decision Records
CREATE TABLE decisions (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  context        TEXT NOT NULL,
  decision       TEXT NOT NULL,
  consequences   TEXT,
  status         TEXT NOT NULL DEFAULT 'accepted',  -- 'proposed' | 'accepted' | 'superseded'
  related_files  TEXT,              -- json array
  tags           TEXT,              -- json array
  created_at     TEXT NOT NULL
);

-- Sesiones (el detalle turno-a-turno vive en .devpilot/sessions/<id>.jsonl)
CREATE TABLE sessions (
  id             TEXT PRIMARY KEY,
  started_at     TEXT NOT NULL,
  ended_at       TEXT,
  task_summary   TEXT,
  provider_used  TEXT,
  events_path    TEXT               -- .devpilot/sessions/<id>.jsonl
);

-- Context Packs generados (el contenido vive en .devpilot/context/<fecha>-task-<seq>.md + .json)
CREATE TABLE context_packs (
  id              TEXT PRIMARY KEY,
  session_id      TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  task_text       TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  token_estimate  INTEGER,
  classification  TEXT,             -- 'green' | 'yellow' | 'red'
  markdown_path   TEXT NOT NULL,
  json_path       TEXT NOT NULL
);

-- Cambios de archivo propuestos por la IA, detectados por el ChangeParser (ver 06).
-- Auditable por diseño: queda registro de qué se detectó, qué validó el ChangeValidator, y qué se aplicó.
CREATE TABLE file_change_proposals (
  id                        TEXT PRIMARY KEY,
  context_pack_id           TEXT REFERENCES context_packs(id) ON DELETE CASCADE,
  file_path                 TEXT NOT NULL,
  operation                 TEXT NOT NULL,     -- 'create' | 'edit' | 'delete' | 'patch'
  format_detected           TEXT NOT NULL,     -- 'devpilot-block' | 'json' | 'markdown-file' | 'diff' | 'fence-only'
  validation_status         TEXT NOT NULL,     -- 'valid' | 'warning' | 'reject' (ver ChangeValidator, 06)
  confidence_score          INTEGER NOT NULL,  -- 0-100
  validation_checks_json    TEXT NOT NULL,     -- ValidationCheck[] serializado, para auditar por qué quedó en ese estado
  search_matched            INTEGER,           -- solo para operation='patch': ¿el bloque SEARCH coincidió con el archivo actual? NULL si no aplica
  search_match_strategy     TEXT,              -- 'exact' | 'dedented' | 'recovered-prefix' | NULL — cómo se logró el match (ver 06, segunda ronda de evidencia)
  has_undocumented_decision INTEGER NOT NULL DEFAULT 0,  -- hallazgo del Paso 0: heurística de decisión de negocio no documentada
  applied                   INTEGER NOT NULL DEFAULT 0,
  created_at                TEXT NOT NULL
);
CREATE INDEX idx_proposals_pack ON file_change_proposals(context_pack_id);

-- Decisiones de negocio confirmadas/abiertas que se incluyeron en un Context Pack
-- (hallazgo del Paso 0: declarar explícitamente qué está decidido y qué no reduce
-- cuánto tiene que inventar la IA). 'confirmed' normalmente espeja una Decision
-- Record ya existente (ver `decisions`); 'open' es nuevo por tarea y, si el
-- usuario resuelve una al revisar una propuesta en warning, puede promoverse a
-- una Decision Record real (resolved_decision_id).
CREATE TABLE context_pack_decisions (
  id                    TEXT PRIMARY KEY,
  context_pack_id       TEXT REFERENCES context_packs(id) ON DELETE CASCADE,
  kind                  TEXT NOT NULL,     -- 'confirmed' | 'open'
  text                  TEXT NOT NULL,
  resolved_decision_id  TEXT REFERENCES decisions(id) ON DELETE SET NULL
);
CREATE INDEX idx_pack_decisions_pack ON context_pack_decisions(context_pack_id);

-- Benchmark por tarea: la métrica que convierte "ahorramos contexto" en un número verificable.
-- files_used y changes_* se derivan de file_change_proposals; se guardan precalculados para consulta rápida.
CREATE TABLE task_benchmarks (
  id                    TEXT PRIMARY KEY,
  context_pack_id       TEXT REFERENCES context_packs(id) ON DELETE CASCADE,
  task_text             TEXT NOT NULL,
  context_tokens        INTEGER,
  files_included        INTEGER,
  files_used            INTEGER,       -- archivos incluidos que terminaron con >=1 cambio aplicado
  files_unnecessary     INTEGER,       -- files_included - files_used
  response_size_chars   INTEGER,
  changes_imported      INTEGER,
  changes_applied       INTEGER,
  outcome               TEXT,          -- 'success' | 'partial' | 'failed' | 'not_applied'
  created_at            TEXT NOT NULL
);

-- Bitácora de auditoría de herramientas (todo lo que pasó por el Tool Engine)
CREATE TABLE tool_invocations (
  id             TEXT PRIMARY KEY,
  session_id     TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  tool_name      TEXT NOT NULL,
  risk_level     TEXT NOT NULL,     -- 'read' | 'write' | 'delete' | 'terminal' | 'git-commit'
  params_json    TEXT NOT NULL,
  approved       INTEGER NOT NULL DEFAULT 0,
  approved_at    TEXT,
  result_summary TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_invocations_session ON tool_invocations(session_id);

-- Cache de relevancia (opcional, evita recalcular para la misma tarea)
CREATE TABLE relevance_cache (
  id           TEXT PRIMARY KEY,
  task_hash    TEXT NOT NULL,
  file_id      TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  score        REAL NOT NULL,
  reasons_json TEXT NOT NULL,
  computed_at  TEXT NOT NULL
);
CREATE INDEX idx_relevance_task ON relevance_cache(task_hash);
```

## Layout de `.devpilot/` en disco

```
<proyecto>/.devpilot/
├── devpilot.db
├── knowledge/
│   ├── architecture.md
│   ├── modules.md
│   ├── database.md
│   ├── business-rules.md
│   └── conventions.md
├── state/
│   └── snapshot.json
├── decisions/            # opcional: espejo legible de la tabla `decisions` en Markdown, uno por decisión
├── sessions/
│   └── <session-id>.jsonl
├── context/
│   ├── 2026-09-09-task-001.md
│   └── 2026-09-09-task-001.json
└── config.json            # allowlist de comandos, pesos del relevance scorer, límites de tokens, etc.
```

`config.json` es donde vive todo lo que el usuario puede querer ajustar sin tocar código: pesos del scorer, comandos de terminal permitidos por defecto, umbrales de clasificación de tokens (verde/amarillo/rojo) — para no hardcodear esos números en el core.
