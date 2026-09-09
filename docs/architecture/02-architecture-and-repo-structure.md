# 02 — Arquitectura V1, estructura del repo y contratos (Fases B, D, E)

## Módulos y responsabilidades

```
                              DEVPILOT
                                 │
        ┌────────────────┬──────┴───────┬────────────────┐
        │                │              │                │
  PROJECT ENGINE   CONTEXT ENGINE   TOOL ENGINE      PROVIDER LAYER
        │                │              │                │
   Scanner          Knowledge Store  File Tools      AIProvider (interfaz)
   Indexer          State Store      Search Tools     ├─ ManualProvider (v1)
   Git Adapter      Session Memory   Terminal Tool     ├─ ClaudeCodeProvider
   Filesystem       Decision Records Git Tools         └─ (futuro) API providers
   Adapter          Context Planner  Permission Guard
                    Relevance Scorer
                    Token Estimator
                    Context Pack Builder
```

Todo esto vive bajo un **Core** con una API programática estable. El CLI (y, después, Desktop y Browser Extension) son *clientes finos* de esa API — nunca contienen lógica de negocio propia. Esto es lo que garantiza que Electron nunca sea una dependencia del "cerebro" (regla explícita del proyecto).

- **Project Engine** — todo lo que requiere tocar el filesystem/Git del proyecto objetivo: escanear, indexar, leer estado de Git. No sabe nada de IA ni de contexto.
- **Context Engine** — el corazón del producto. Convierte "Project Engine + memoria persistente + una tarea en lenguaje natural" en un `ContextPack`. No toca el filesystem directamente; consume lo que el Project Engine ya indexó.
- **Tool Engine** — el único módulo con permiso de *modificar* el proyecto objetivo (crear/editar/borrar archivos, correr comandos, hacer commits). Todas sus operaciones pasan por el `PermissionGuard`.
- **Provider Layer** — abstrae "quién genera texto/código": un humano pegando en un chat web (`ManualProvider`), Claude Code (`ClaudeCodeProvider`), o en el futuro APIs pagas. Ver 06.
- **Storage** — repositorios SQLite + un `FileStore` para el contenido largo (Markdown/JSON en `.devpilot/`). Ningún otro módulo habla SQL directamente.
- **CLI** — parsea comandos, invoca servicios del Core, presenta resultados en terminal (texto o `--json`).

## Flujo de datos (ejemplo: `devpilot context "<tarea>"`)

```
CLI
 └─> ContextService.buildPack(projectId, taskText)
       ├─> ProjectStateRepo.getSnapshot()          (Storage)
       ├─> ContextPlanner.selectFiles(taskText, snapshot)
       │     ├─ Nivel 1: búsqueda textual (ripgrep sobre archivos indexados)
       │     ├─ Nivel 2: expansión por grafo de imports (1-2 saltos)
       │     └─ (Nivel 3/4/5 en incrementos posteriores)
       ├─> RelevanceScorer.score(candidatos, taskText)
       ├─> TokenEstimator.estimate(candidatos seleccionados)
       ├─> ContextPackBuilder.build(knowledge, state, session, decisions, candidatos, task)
       └─> FileStore.savePack(pack)                 (Storage)
 └<─ ContextPack { markdown, json, tokenEstimate, files[] }
CLI presenta el resumen + copia el Markdown al portapapeles
```

Ningún paso de este flujo llama a una IA. Eso es intencional: generar el Context Pack es 100% determinístico y gratis. La IA entra recién cuando el usuario decide pegarlo en un chat, o cuando invoca explícitamente `analyze --deep`.

## Seguridad (aplica transversalmente)

- Todo acceso a filesystem pasa por un `PathGuard`: rutas siempre resueltas y validadas como subrutas del `project.root_path` (o de una allowlist explícita configurada por el usuario). Ninguna herramienta puede leer/escribir fuera del proyecto sin aprobación explícita.
- Toda operación de escritura/borrado/terminal/commit pasa por `PermissionGuard`, que conoce el nivel de riesgo de cada herramienta (ver 05) y decide si requiere confirmación interactiva.
- Cada decisión de aprobación (aprobado/rechazado, por quién — hoy siempre el usuario humano, en el futuro podría haber políticas) se registra en `tool_invocations` (ver 03) como bitácora auditable.
- Nada se envía a un proveedor de IA sin pasar por el Context Pack — es decir, no hay un camino donde una herramienta "fugue" contenido del proyecto directamente a un provider sin que el usuario vea qué se está compartiendo.

## Integración con Git

`GitAdapter` es una capa delgada sobre el binario `git` (se invoca el CLI del sistema directamente vía subprocess, no una librería como `simple-git`, para minimizar dependencias y comportamientos inesperados). Expone:

```ts
interface GitAdapter {
  isRepo(): Promise<boolean>;
  status(): Promise<GitStatus>;
  diff(opts?: { from?: string; to?: string; paths?: string[] }): Promise<GitDiff>;
  log(opts?: { since?: string; limit?: number }): Promise<GitCommit[]>;
  currentCommit(): Promise<string | null>;
  commit(message: string, paths: string[]): Promise<string>; // requiere aprobación (Tool Engine)
}
```

`Project State` guarda `lastIndexedCommit` y `lastDeepAnalysisCommit`. Antes de reindexar, el Scanner compara el commit actual contra `lastIndexedCommit`: si no cambió, reutiliza el índice existente; si cambió, usa `git diff --name-status` para reindexar solo los archivos tocados en vez de rescanear todo el árbol. Esto es lo que hace que reindexar sea barato en proyectos grandes — pero es **incremento 2**, no parte del primer corte (ver 07).

## Integración con Claude Code

Se documenta en detalle en 06 (junto con el resto de providers), pero la regla arquitectónica clave es: **Claude Code entra únicamente como una implementación de `AIProvider`**, invocada vía subprocess en modo no interactivo. Si el binario `claude` no está instalado o el usuario no tiene sesión iniciada, `ClaudeCodeProvider.isAvailable()` devuelve `false` y el resto del sistema sigue funcionando exactamente igual sin él.

## Browser Bridge (integración futura)

Solo se referencia aquí para mostrar dónde encaja: el Browser Bridge no es una capa nueva de lógica, es un `BrowserBridgeAdapter` que consume un `ContextPack` ya construido y (opcionalmente) parsea la respuesta cruda de una IA. En v1 el único adapter es "genérico": copiar/pegar manual. Lo que sí es nuevo (validado con evidencia real en el Paso 0, ver 01) es que el parseo de la respuesta **no termina en un diff aplicable directamente** — pasa primero por un `ChangeValidator` que decide si el cambio propuesto es seguro de mostrar/aplicar o si necesita que el usuario decida algo primero. Detalle completo del pipeline Parser → Validator en 06.

## Estructura del repositorio

La propuesta original (monorepo pnpm con `apps/{cli,desktop,browser-extension}` y `packages/{core,context,tools,providers,browser,storage,shared}`) es la **forma correcta a mediano plazo**, pero crear los ocho paquetes desde el commit inicial es sobreingeniería: hoy no existe una segunda UI ni un segundo provider que justifique esas fronteras, y cada paquete pnpm extra es overhead de build/test/versión sin beneficio inmediato.

**Estructura recomendada para el arranque real:**

```
devpilot/
├── apps/
│   └── cli/                    # comandos, presentadores de terminal
│       ├── src/
│       │   ├── commands/
│       │   └── index.ts
│       └── package.json
│
├── packages/
│   ├── core/                   # Project Engine + Context Engine + Tool Engine + Provider Layer
│   │   └── src/
│   │       ├── project/        # Scanner, Indexer, GitAdapter
│   │       ├── context/        # Planner, RelevanceScorer, TokenEstimator, PackBuilder
│   │       ├── tools/          # FileTools, SearchTools, TerminalTool, GitTools, PermissionGuard
│   │       ├── providers/      # AIProvider, ManualProvider, ClaudeCodeProvider
│   │       └── domain/         # tipos compartidos (ver 05)
│   │
│   ├── storage/                # repositorios SQLite + FileStore
│   │   └── src/
│   │       ├── db/             # migraciones, esquema (ver 03)
│   │       └── repos/
│   │
│   └── shared/                 # logger, config, utils sin dependencias de dominio
│
├── package.json
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

`context`, `tools`, `providers` y `browser` se separan de `core` como paquetes propios recién cuando aparezca una razón concreta (por ejemplo: el segundo provider real, o cuando `desktop` necesite importar `context` sin arrastrar `tools`). `desktop` y `browser-extension` se agregan como `apps/` nuevos en el incremento correspondiente (ver 07), consumiendo `core` por su API pública — nunca sus internos.

## Contratos TypeScript principales (Fase E)

Estos son los tipos de dominio centrales. Viven en `packages/shared/src/domain/` (movidos ahí durante la implementación del Scanner del Incremento 1: tanto `@devpilot/core` como `@devpilot/storage` los necesitan, y `@devpilot/core` depende de `@devpilot/storage` — dejarlos en `core` habría creado una dependencia circular. `@devpilot/shared` no depende de nada, así que es el lugar correcto en el grafo. `@devpilot/core` re-exporta todo desde su propio índice para no romper la ruta de import pública `@devpilot/core` que usa el resto del código, CLI incluido).

```ts
// ---- Proyecto ----
interface Project {
  id: string;
  name: string;
  rootPath: string;
  createdAt: string;
  updatedAt: string;
  vcs: 'git' | 'none';
}

interface ProjectSnapshot {
  projectId: string;
  version: number;
  createdAt: string;
  language: string[];               // ['typescript', 'javascript']
  framework?: string;                // 'next.js', 'express', ...
  packageManager?: 'pnpm' | 'npm' | 'yarn' | 'bun';
  orm?: string;                      // 'prisma', 'drizzle', ...
  database?: string;                 // 'postgresql', 'sqlite', ...
  hasDocker: boolean;
  scripts: Record<string, string>;   // de package.json
  fileCount: number;
  gitCommit: string | null;
}

// ---- Memoria persistente ----
interface ProjectKnowledgeDoc {
  id: string;
  projectId: string;
  type: 'architecture' | 'modules' | 'database' | 'business-rules' | 'conventions' | 'custom';
  title: string;
  path: string;                      // .devpilot/knowledge/<type>.md
  source: 'manual' | 'deep-analysis' | 'inferred';
  updatedAt: string;
}

interface ProjectState {
  projectId: string;
  lastIndexedCommit: string | null;
  lastDeepAnalysisCommit: string | null;
  lastScanAt: string | null;
  snapshotVersion: number;
}

interface DecisionRecord {
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

interface SessionMemory {
  id: string;
  projectId: string;
  startedAt: string;
  endedAt?: string;
  taskSummary?: string;
  providerUsed?: string;
  events: SessionEvent[];            // log detallado, persistido aparte (jsonl)
}

// ---- Contexto de tarea ----
interface TaskContext {
  rawText: string;
  extractedKeywords: string[];
  relatedSymbols?: string[];         // incremento 2
}

interface RelevanceScore {
  filePath: string;
  score: number;                     // 0-100
  reasons: RelevanceReason[];        // transparencia: por qué este score
}

interface RelevanceReason {
  kind: 'text-match' | 'import-distance' | 'path-name' | 'git-recency' | 'symbol-match';
  weight: number;
  detail: string;
}

interface TokenEstimate {
  totalTokens: number;
  perFile: Record<string, number>;
  classification: 'green' | 'yellow' | 'red';
}

// ---- Context Pack ----
interface ContextPack {
  id: string;
  projectId: string;
  sessionId: string;
  createdAt: string;
  task: TaskContext;
  projectKnowledge: ProjectKnowledgeDoc[];
  relevantFiles: { path: string; content: string; score: RelevanceScore }[];
  recentChanges?: GitDiff;           // incremento 2
  decisionsConsidered: DecisionRecord[];
  businessDecisions: {               // añadido tras el Paso 0 — ver 04
    confirmed: string[];
    open: string[];
  };
  constraints: string[];
  responseInstructions: string;      // el "contrato de formato" que la IA debe seguir
  tokenEstimate: TokenEstimate;
}
```

Los tipos de import/validación (`FileChangeProposal`, `ChangeValidator`, `ValidationResult`) se documentan en 06 junto con el Browser Bridge — es el mismo pipeline, no un módulo aparte.

Los tipos de `tools` y `providers` se documentan en 05 y 06 respectivamente, para mantener cada archivo enfocado en su propia fase.
