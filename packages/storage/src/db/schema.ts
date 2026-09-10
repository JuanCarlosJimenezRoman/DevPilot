// Esquema SQLite — Fase C, ver docs/architecture/03-data-model.md.
//
// Se crean TODAS las tablas de v1 desde ahora (`CREATE TABLE IF NOT EXISTS`),
// aunque el Incremento 1 solo llene `projects` y `project_state` — así lo
// documenta 03 explícitamente (ej. `file_edges` "existe desde v1 para no
// migrar después"). Evita migraciones incrementales mientras el esquema
// todavía es pequeño y barato de recrear.
//
// Nota respecto a 03: la tabla `projects` de este archivo agrega las
// columnas `vcs` y `updated_at`, que el documento original no tenía —
// corregido para que coincida con el tipo de dominio `Project` (ver
// packages/shared/src/domain/types.ts). `docs/architecture/03-data-model.md`
// se actualiza en el mismo cambio que este archivo.

/**
 * `~/.devpilot/registry.db` — catálogo global de proyectos. Nunca contiene
 * memoria/conocimiento de un proyecto específico (eso vive en la base local
 * de cada proyecto, ver PROJECT_DB_SCHEMA).
 */
export const GLOBAL_REGISTRY_SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id              TEXT PRIMARY KEY,        -- uuid
  name            TEXT NOT NULL,
  root_path       TEXT NOT NULL UNIQUE,
  vcs             TEXT NOT NULL DEFAULT 'none',   -- 'git' | 'none'
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  last_opened_at  TEXT
);
`;

/**
 * `<proyecto>/.devpilot/devpilot.db` — memoria, snapshot, estado, decisiones,
 * sesiones e índices de ESE proyecto. Portátil a propósito.
 */
export const PROJECT_DB_SCHEMA = `
-- Estado general del proyecto (fila única por proyecto)
CREATE TABLE IF NOT EXISTS project_state (
  project_id                TEXT PRIMARY KEY,
  last_indexed_commit       TEXT,
  last_deep_analysis_commit TEXT,
  last_scan_at              TEXT,
  snapshot_version          INTEGER NOT NULL DEFAULT 0,
  snapshot_path             TEXT              -- .devpilot/state/snapshot.json
);

-- Índice de archivos (poblado por el Indexer, Incremento 1 en adelante)
CREATE TABLE IF NOT EXISTS files (
  id                TEXT PRIMARY KEY,
  path              TEXT NOT NULL UNIQUE,   -- relativo al root del proyecto
  hash              TEXT NOT NULL,          -- sha256 del contenido
  language          TEXT,
  size_bytes        INTEGER,
  last_modified     TEXT,
  last_seen_commit  TEXT,
  indexed_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);

-- Grafo de imports/dependencias (poblado desde Incremento 2)
CREATE TABLE IF NOT EXISTS file_edges (
  id            TEXT PRIMARY KEY,
  from_file_id  TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  to_file_id    TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL DEFAULT 'import'
);
CREATE INDEX IF NOT EXISTS idx_edges_from ON file_edges(from_file_id);
CREATE INDEX IF NOT EXISTS idx_edges_to   ON file_edges(to_file_id);

-- Símbolos (funciones/clases/exports) — poblada desde Incremento 2
CREATE TABLE IF NOT EXISTS symbols (
  id          TEXT PRIMARY KEY,
  file_id     TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  line_start  INTEGER,
  line_end    INTEGER,
  is_exported INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);

-- Indice de Project Knowledge (el contenido vive en .devpilot/knowledge/*.md,
-- ver knowledgeStore.ts). id decide la identidad del doc: para los 5 tipos
-- canonicos (architecture/modules/database/business-rules/conventions),
-- id = type, asi que a lo sumo un doc activo por tipo canonico es una
-- garantia de esquema (PRIMARY KEY), no solo de aplicacion -- "regenerar"
-- (devpilot knowledge generate) y "crear" son el mismo upsert por id (ver
-- knowledgeRepo.ts). Los docs custom usan id custom-<slug>.
-- NOTA: sin backticks en este comentario -- este bloque SQL vive dentro de
-- un template literal de JS mas abajo en el archivo, y un backtick cierra
-- ese literal antes de tiempo (bug real ya encontrado y documentado en una
-- sesion anterior).
CREATE TABLE IF NOT EXISTS knowledge_docs (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  title        TEXT NOT NULL,
  path         TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source       TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- Decision Records
CREATE TABLE IF NOT EXISTS decisions (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  context        TEXT NOT NULL,
  decision       TEXT NOT NULL,
  consequences   TEXT,
  status         TEXT NOT NULL DEFAULT 'accepted',
  related_files  TEXT,
  tags           TEXT,
  created_at     TEXT NOT NULL
);

-- Sesiones (el detalle turno-a-turno vive en .devpilot/sessions/<id>.jsonl)
CREATE TABLE IF NOT EXISTS sessions (
  id             TEXT PRIMARY KEY,
  started_at     TEXT NOT NULL,
  ended_at       TEXT,
  task_summary   TEXT,
  provider_used  TEXT,
  events_path    TEXT
);

-- Context Packs generados (el contenido vive en .devpilot/context/<fecha>-task-<seq>.md + .json)
CREATE TABLE IF NOT EXISTS context_packs (
  id              TEXT PRIMARY KEY,
  session_id      TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  task_text       TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  token_estimate  INTEGER,
  classification  TEXT,
  markdown_path   TEXT NOT NULL,
  json_path       TEXT NOT NULL
);

-- Cambios de archivo propuestos por la IA, detectados por el ChangeParser (ver 06)
CREATE TABLE IF NOT EXISTS file_change_proposals (
  id                        TEXT PRIMARY KEY,
  context_pack_id           TEXT REFERENCES context_packs(id) ON DELETE CASCADE,
  file_path                 TEXT NOT NULL,
  operation                 TEXT NOT NULL,
  format_detected           TEXT NOT NULL,
  validation_status         TEXT NOT NULL,
  confidence_score          INTEGER NOT NULL,
  validation_checks_json    TEXT NOT NULL,
  search_matched            INTEGER,
  search_match_strategy     TEXT,
  has_undocumented_decision INTEGER NOT NULL DEFAULT 0,
  -- .devpilot/changes/<id>.json -- contenido completo de la propuesta
  -- (FileChangeProposal + ValidationResult), ver changeProposalStore.ts.
  -- Agregada al implementar devpilot diff: esta tabla solo tenia
  -- metadata, y diff/apply necesitan el contenido real (newContent/diff/
  -- patch), que no se conservaba en ningun otro lado. Nullable solo para
  -- no romper filas insertadas por versiones anteriores del codigo sin
  -- migrar (ver ensureFileChangeProposalPathColumn en connection.ts);
  -- toda fila nueva la trae siempre.
  proposal_path             TEXT,
  applied                   INTEGER NOT NULL DEFAULT 0,
  created_at                TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proposals_pack ON file_change_proposals(context_pack_id);

-- Decisiones de negocio confirmadas/abiertas incluidas en un Context Pack
CREATE TABLE IF NOT EXISTS context_pack_decisions (
  id                    TEXT PRIMARY KEY,
  context_pack_id       TEXT REFERENCES context_packs(id) ON DELETE CASCADE,
  kind                  TEXT NOT NULL,
  text                  TEXT NOT NULL,
  resolved_decision_id  TEXT REFERENCES decisions(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_pack_decisions_pack ON context_pack_decisions(context_pack_id);

-- Benchmark por tarea (ver 07, "devpilot apply" + benchmark automático):
-- una fila por Context Pack, creada al correr devpilot context y
-- actualizada (nunca insertada de nuevo) al correr devpilot import y
-- devpilot apply sobre ese mismo pack -- así el benchmark queda
-- disponible progresivamente sin necesitar un paso explícito de "cerrar
-- tarea". No hay UNIQUE en context_pack_id a propósito: bases de proyecto
-- ya existentes tenían esta tabla creada (CREATE TABLE IF NOT EXISTS desde
-- el Incremento 0, sin usarse) sin esa restricción, y agregarla ahora no
-- la aplicaría retroactivamente -- el "upsert" (una fila por pack) se
-- garantiza en código (taskBenchmarkRepo.ts), no en el esquema.
CREATE TABLE IF NOT EXISTS task_benchmarks (
  id                    TEXT PRIMARY KEY,
  context_pack_id       TEXT REFERENCES context_packs(id) ON DELETE CASCADE,
  task_text             TEXT NOT NULL,
  context_tokens        INTEGER,
  files_included        INTEGER,
  files_used            INTEGER,
  files_unnecessary     INTEGER,
  response_size_chars   INTEGER,
  changes_imported      INTEGER,
  changes_applied       INTEGER,
  outcome               TEXT,
  created_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_benchmarks_pack ON task_benchmarks(context_pack_id);

-- Bitácora de auditoría de herramientas (todo lo que pasó por el Tool Engine)
CREATE TABLE IF NOT EXISTS tool_invocations (
  id             TEXT PRIMARY KEY,
  session_id     TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  tool_name      TEXT NOT NULL,
  risk_level     TEXT NOT NULL,
  params_json    TEXT NOT NULL,
  approved       INTEGER NOT NULL DEFAULT 0,
  approved_at    TEXT,
  result_summary TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invocations_session ON tool_invocations(session_id);

-- Cache de relevancia
CREATE TABLE IF NOT EXISTS relevance_cache (
  id           TEXT PRIMARY KEY,
  task_hash    TEXT NOT NULL,
  file_id      TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  score        REAL NOT NULL,
  reasons_json TEXT NOT NULL,
  computed_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_relevance_task ON relevance_cache(task_hash);
`;
