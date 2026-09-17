// Contratos de dominio de DevPilot (Fase E — ver docs/architecture/02-architecture-and-repo-structure.md).
// Estos tipos son el contrato entre Project Engine, Context Engine, Storage
// y CLI. Deliberadamente NO incluye todavía los tipos de Tool Engine
// (05) ni de Provider Layer / ChangeValidator (06) — esos se agregan
// cuando el Incremento 1 implemente esos módulos, para no mantener tipos
// sin uso que puedan desalinearse de los docs mientras tanto.
//
// Viven en @devpilot/shared (no en @devpilot/core) porque tanto
// @devpilot/storage como @devpilot/core necesitan estos tipos, y
// @devpilot/core depende de @devpilot/storage — ponerlos en core habría
// creado una dependencia circular. @devpilot/shared no depende de nada,
// así que es el lugar correcto en el grafo de dependencias.
// @devpilot/core sigue re-exportando todo esto desde su propio índice
// (ver packages/core/src/index.ts) para no romper la ruta de import
// pública `@devpilot/core` que ya usa el resto del código.

// ---------------------------------------------------------------------
// Proyecto
// ---------------------------------------------------------------------

export interface Project {
  id: string;
  name: string;
  rootPath: string;
  createdAt: string;
  updatedAt: string;
  vcs: 'git' | 'none';
}

export interface ProjectSnapshot {
  projectId: string;
  version: number;
  createdAt: string;
  language: string[];
  framework?: string;
  packageManager?: 'pnpm' | 'npm' | 'yarn' | 'bun';
  orm?: string;
  database?: string;
  hasDocker: boolean;
  scripts: Record<string, string>;
  fileCount: number;
  gitCommit: string | null;
}

// ---------------------------------------------------------------------
// Memoria persistente (ver docs/architecture/04-context-engine.md)
// ---------------------------------------------------------------------

export interface ProjectKnowledgeDoc {
  id: string;
  projectId: string;
  type: 'architecture' | 'modules' | 'database' | 'business-rules' | 'conventions' | 'custom';
  title: string;
  path: string;
  source: 'manual' | 'deep-analysis' | 'inferred';
  updatedAt: string;
}

export interface ProjectState {
  projectId: string;
  lastIndexedCommit: string | null;
  lastDeepAnalysisCommit: string | null;
  lastScanAt: string | null;
  snapshotVersion: number;
  // Ruta al snapshot persistido (.devpilot/state/snapshot.json, ver 03).
  // null antes del primer `devpilot project add` exitoso.
  snapshotPath: string | null;
}

export interface DecisionRecord {
  id: string;
  projectId: string;
  title: string;
  context: string;
  decision: string;
  consequences?: string;
  status: 'proposed' | 'accepted' | 'superseded';
  relatedFiles: string[];
  tags: string[];
  createdAt: string;
}

// Placeholder deliberadamente mínimo — el detalle turno-a-turno de una
// sesión vive en .devpilot/sessions/<id>.jsonl (03) y se diseña en detalle
// en el Incremento 2 ("Project Memory", ver 07). Aquí solo se fija la
// forma mínima para que SessionMemory compile.
export interface SessionEvent {
  timestamp: string;
  kind: string;
  detail?: Record<string, unknown>;
}

export interface SessionMemory {
  id: string;
  projectId: string;
  startedAt: string;
  endedAt?: string;
  taskSummary?: string;
  providerUsed?: string;
  events: SessionEvent[];
}

// ---------------------------------------------------------------------
// Contexto de tarea y Context Pack
// ---------------------------------------------------------------------

export interface TaskContext {
  rawText: string;
  extractedKeywords: string[];
  relatedSymbols?: string[];
}

export interface RelevanceReason {
  kind:
    | 'text-match'
    | 'import-distance'
    | 'path-name'
    | 'git-recency'
    | 'symbol-match'
    // `--include <ruta>` en `devpilot context` (07, sesión 13): el usuario
    // pidió este archivo explícitamente, sin importar su score por
    // keywords — caso real encontrado en "uso real": el archivo que hay
    // que refactorizar casi nunca tiene el vocabulario del patrón
    // objetivo (types/hook/api ya separados), así que pierde el ranking
    // contra los ejemplos ya migrados que sí lo tienen.
    | 'explicit-include';
  weight: number;
  detail: string;
}

export interface RelevanceScore {
  filePath: string;
  score: number;
  reasons: RelevanceReason[];
}

export interface TokenEstimate {
  totalTokens: number;
  perFile: Record<string, number>;
  classification: 'green' | 'yellow' | 'red';
}

export interface GitDiff {
  files: { path: string; patch: string }[];
}

// ---------------------------------------------------------------------
// Git Intelligence (Incremento 3, ver 07/GitAdapter en
// packages/core/src/project/gitAdapter.ts) — tipos de dominio para
// `GitAdapter.status()`/`GitAdapter.log()`. `GitDiff` (arriba) ya existía
// como placeholder desde el Incremento 0 para `diff()`.
// ---------------------------------------------------------------------

export interface GitStatusEntry {
  path: string;
  // Código porcelain v1 de dos letras (index/worktree), ej. 'M ' (modificado
  // en index), ' M' (modificado en working tree, sin stagear), '??'
  // (sin trackear), 'A ' (agregado), 'D ' (borrado), 'R ' (renombrado —
  // `path` ya viene resuelto a la ruta nueva, ver gitAdapter.ts).
  code: string;
}

export interface GitStatus {
  // `null` si es un checkout detached (sin rama) o el repo no tiene commits
  // todavía.
  branch: string | null;
  clean: boolean;
  staged: GitStatusEntry[];
  unstaged: GitStatusEntry[];
  untracked: string[];
}

export interface GitCommit {
  hash: string;
  authorName: string;
  authorEmail: string;
  date: string; // ISO 8601 (%aI de git log)
  message: string;
  // Rutas tocadas por este commit — usado por el Nivel 4 del Context
  // Planner (04) para el boost de recencia/afinidad. Para un merge commit,
  // v1 compara contra el primer padre (comportamiento por defecto de
  // `git diff-tree`) — simplificación deliberada, igual que el resto del
  // Indexer (ver indexer.ts).
  filesChanged: string[];
}

export interface ContextPack {
  id: string;
  projectId: string;
  sessionId: string;
  createdAt: string;
  task: TaskContext;
  projectKnowledge: ProjectKnowledgeDoc[];
  // `compactedToSignatures`: Context Compaction (04, punto 1 — Incremento
  // 3) reemplazó el contenido completo de este archivo por solo sus
  // símbolos exportados (ver contextCompaction.ts) porque el pack se pasó
  // de verde/amarillo. `undefined`/`false` en cualquier otro caso —
  // incluida la truncación por tamaño de fileReading.ts, que es un límite
  // de seguridad aparte, siempre activo, no una estrategia de compactación.
  relevantFiles: { path: string; content: string; score: RelevanceScore; compactedToSignatures?: boolean }[];
  // Diff del working tree sin commitear contra HEAD (ver gitAdapter.ts) —
  // "qué se está tocando ahora mismo, todavía sin commitear", que
  // complementa a Session Memory. `undefined` si el proyecto no es git, no
  // tiene commits todavía, o no hay cambios sin commitear.
  recentChanges?: GitDiff;
  decisionsConsidered: DecisionRecord[];
  // Session Memory real (Incremento 2, ver 07/sessionService.ts) — solo
  // presente cuando había una sesión activa (`devpilot session start`) al
  // generar este pack; `undefined` en cualquier otro caso (Session Memory
  // es opcional, no un requisito para `devpilot context`). Cuando está,
  // `sessionId` de arriba es el id real de esa sesión (fila en `sessions`,
  // no un id de un solo uso); `events` viene ya acotado a los más
  // recientes (ver contextService.ts) para no inflar el pack con todo el
  // historial de una sesión larga.
  sessionMemory?: SessionMemory;
  // Texto ya inlineado de los `projectKnowledge` de arriba, listo para el
  // Markdown/prompt (Incremento 2, ver 07/knowledgeService.ts) — mismo
  // patrón que `businessDecisions.confirmed` respecto de
  // `decisionsConsidered`: el array de `projectKnowledge` es metadata para
  // auditoría (apunta al archivo real en `.devpilot/knowledge/`, no
  // duplica su contenido — ver 03), esto es el contenido real que ve la
  // IA. `undefined`/vacío si el proyecto todavía no tiene ningún knowledge
  // doc (`devpilot knowledge generate`/`edit` no se corrieron todavía).
  projectKnowledgeText?: string;
  // Añadido tras el Paso 0 (ver docs/architecture/01-vision-and-validation.md
  // y 04): decirle a la IA de antemano qué está decidido y qué está
  // deliberadamente abierto reduce cuánto necesita inventar.
  businessDecisions: {
    confirmed: string[];
    open: string[];
  };
  constraints: string[];
  responseInstructions: string;
  tokenEstimate: TokenEstimate;
  // Context Compaction (04, Incremento 3) — presente solo cuando el pack se
  // pasó de verde/amarillo y `contextCompaction.ts` aplicó al menos una
  // estrategia. `undefined` en un pack 🟢 (nada que compactar). Nunca una
  // caja negra: cada nota explica qué se compactó/quitó y por qué, para que
  // el usuario pueda revisar la decisión (ver markdownRenderer.ts).
  compaction?: {
    strategiesApplied: ('signatures-only' | 'knowledge-dedup' | 'drop-lowest-score')[];
    notes: string[];
  };
}
