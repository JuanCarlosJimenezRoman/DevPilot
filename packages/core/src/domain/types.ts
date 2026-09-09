// Contratos de dominio de DevPilot (Fase E — ver docs/architecture/02-architecture-and-repo-structure.md).
// Estos tipos son el contrato entre Project Engine, Context Engine, Storage
// y CLI. Deliberadamente NO incluye todavía los tipos de Tool Engine
// (05) ni de Provider Layer / ChangeValidator (06) — esos se agregan
// cuando el Incremento 1 implemente esos módulos, para no mantener tipos
// sin uso que puedan desalinearse de los docs mientras tanto.

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
  kind: 'text-match' | 'import-distance' | 'path-name' | 'git-recency' | 'symbol-match';
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

// Placeholder mínimo — el diseño completo de Git Intelligence (Incremento
// 3, ver 07) definirá esto con más detalle (hunks, estado de archivo,
// etc.). Aquí solo se fija la forma mínima para que ContextPack compile.
export interface GitDiff {
  files: { path: string; patch: string }[];
}

export interface ContextPack {
  id: string;
  projectId: string;
  sessionId: string;
  createdAt: string;
  task: TaskContext;
  projectKnowledge: ProjectKnowledgeDoc[];
  relevantFiles: { path: string; content: string; score: RelevanceScore }[];
  recentChanges?: GitDiff; // Incremento 3
  decisionsConsidered: DecisionRecord[];
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
}
