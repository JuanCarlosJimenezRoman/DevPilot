import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Project, ProjectKnowledgeDoc, ProjectSnapshot } from '@devpilot/shared';
import type { KnowledgeDocRow } from '@devpilot/storage';
import {
  findProjectByRootPath,
  getKnowledgeDocById,
  hashKnowledgeContent,
  listKnowledgeDocs,
  openGlobalRegistryDb,
  openProjectDb,
  readKnowledgeFile,
  readSnapshotFile,
  upsertKnowledgeDoc,
  writeKnowledgeFile,
} from '@devpilot/storage';
import { logSessionEvent } from '../sessions/sessionEventLogger.js';

// Project Knowledge (04) — `devpilot knowledge` (07, Incremento 2, última
// pieza de "Project Memory"). `knowledge_docs` existía en el esquema desde
// el Incremento 0 sin ningún consumidor real, mismo patrón que
// `decisions`/`sessions` en piezas anteriores.
//
// 04 documenta tres orígenes: 'manual' (el usuario edita), 'inferred'
// (heurísticas del Scanner) y 'deep-analysis' (Claude Code, Incremento 4 —
// fuera de alcance acá). Esta pieza implementa 'manual' e 'inferred'.
// 'deep-analysis' queda pendiente a propósito: 04 exige que un análisis
// profundo "nunca sobreescriba silenciosamente" un doc existente — propone
// un diff que el usuario aprueba, como cualquier otra escritura del Tool
// Engine (05). No hace falta ese mecanismo todavía para 'inferred': son
// heurísticas deterministas y baratas (las mismas que ya corre `devpilot
// project add`), así que `generateInferredKnowledge` escribe directo — el
// principio de "nunca sobreescribir silenciosamente" igual se respeta,
// pero de la forma más simple posible: nunca toca un doc 'manual' (ver
// abajo), en vez de pedir aprobación para cada regeneración.

const CANONICAL_TYPES = ['architecture', 'modules', 'database', 'business-rules', 'conventions'] as const;
type CanonicalKnowledgeType = (typeof CANONICAL_TYPES)[number];

const CANONICAL_TITLES: Record<CanonicalKnowledgeType, string> = {
  architecture: 'Arquitectura',
  modules: 'Módulos',
  database: 'Base de datos',
  'business-rules': 'Reglas de negocio',
  conventions: 'Convenciones',
};

function isCanonicalType(type: string): type is CanonicalKnowledgeType {
  return (CANONICAL_TYPES as readonly string[]).includes(type);
}

function resolveProjectOrThrow(rootPath: string): Project {
  const registryDb = openGlobalRegistryDb();
  try {
    const project = findProjectByRootPath(registryDb, rootPath);
    if (!project) {
      throw new Error(`Este proyecto no está registrado todavía. Corre \`devpilot project add ${rootPath}\` primero.`);
    }
    return project;
  } finally {
    registryDb.close();
  }
}

/** Mismo patrón que `readRawResponse` de importService.ts: si el argumento resuelve a un archivo real, se lee su contenido; si no, se trata el argumento mismo como el texto pegado. Un knowledge doc manual puede venir de cualquiera de las dos formas, igual que una respuesta de IA. */
async function readFileOrLiteralText(input: string): Promise<string> {
  try {
    if (existsSync(input) && statSync(input).isFile()) {
      return await readFile(input, 'utf8');
    }
  } catch {
    // sigue como texto literal
  }
  return input;
}

// Rango Unicode de "marcas diacríticas combinantes" (U+0300–U+036F) — tras
// `normalize('NFD')`, una vocal acentuada se descompone en la letra base +
// una de estas marcas (ej. "á" -> "a" + U+0301); quitarlas después de
// normalizar es la forma estándar de sacar acentos sin tocar la letra
// base. Escrito como escapes `\uXXXX` explícitos, no como los caracteres
// literales, para no depender de que el archivo se guarde/transmita
// siempre con la misma codificación exacta.
const COMBINING_DIACRITICS_RE = /[\u0300-\u036f]/g;

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .normalize('NFD')
    .replace(COMBINING_DIACRITICS_RE, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'doc';
}

// --- Generación 'inferred' a partir del ProjectSnapshot ya escaneado ---
// Deliberadamente solo para los tipos donde el Scanner (ver
// packages/core/src/project/scanner.ts) ya tiene una señal honesta:
// arquitectura (stack detectado), convenciones (scripts de package.json) y
// base de datos (ORM/motor detectado). 'modules' y 'business-rules'
// necesitan entender el código real, no solo archivos de configuración —
// eso es análisis más profundo (`analyze --deep`, Incremento 4), no algo
// que el Scanner de hoy pueda inferir sin inventar. Devolver `null` para
// esos dos tipos, en vez de generar un doc vacío o inventado, es la
// decisión correcta: un doc vacío no es "conocimiento", es ruido.

function renderInferredArchitecture(project: Project, snapshot: ProjectSnapshot): string {
  const lines: string[] = [];
  lines.push(`# Arquitectura — ${project.name}`);
  lines.push('');
  lines.push(
    '*(Generado automáticamente por heurísticas del Scanner — `devpilot knowledge generate`. Editalo a mano con `devpilot knowledge edit architecture <archivo-o-texto>` si querés agregar algo que el Scanner no puede inferir; a partir de ahí, `generate` deja de tocar este doc.)*',
  );
  lines.push('');
  lines.push(`- **Lenguaje(s):** ${snapshot.language.length > 0 ? snapshot.language.join(', ') : '(no detectado)'}`);
  lines.push(`- **Framework:** ${snapshot.framework ?? '(no detectado)'}`);
  lines.push(`- **Package manager:** ${snapshot.packageManager ?? '(no detectado)'}`);
  lines.push(`- **ORM:** ${snapshot.orm ?? '(no detectado)'}`);
  lines.push(`- **Base de datos:** ${snapshot.database ?? '(no detectado)'}`);
  lines.push(`- **Docker:** ${snapshot.hasDocker ? 'sí' : 'no'}`);
  lines.push(`- **Archivos indexados:** ${snapshot.fileCount}`);
  if (snapshot.gitCommit) lines.push(`- **Último commit escaneado:** \`${snapshot.gitCommit}\``);
  lines.push('');
  return lines.join('\n');
}

function renderInferredConventions(project: Project, snapshot: ProjectSnapshot): string | null {
  const entries = Object.entries(snapshot.scripts ?? {});
  if (entries.length === 0) return null;
  const lines: string[] = [];
  lines.push(`# Convenciones — ${project.name}`);
  lines.push('');
  lines.push('*(Generado automáticamente por heurísticas del Scanner a partir de los scripts de `package.json` — `devpilot knowledge generate`.)*');
  lines.push('');
  lines.push('## Comandos del proyecto');
  lines.push('');
  const runner = snapshot.packageManager ?? 'npm';
  for (const [name, cmd] of entries) lines.push(`- \`${runner} run ${name}\`: \`${cmd}\``);
  lines.push('');
  return lines.join('\n');
}

function renderInferredDatabase(project: Project, snapshot: ProjectSnapshot): string | null {
  if (!snapshot.orm && !snapshot.database) return null;
  const lines: string[] = [];
  lines.push(`# Base de datos — ${project.name}`);
  lines.push('');
  lines.push('*(Generado automáticamente por heurísticas del Scanner — `devpilot knowledge generate`.)*');
  lines.push('');
  if (snapshot.orm) lines.push(`- **ORM:** ${snapshot.orm}`);
  if (snapshot.database) lines.push(`- **Motor:** ${snapshot.database}`);
  lines.push('');
  lines.push('*(El schema completo vive en el archivo de configuración del ORM detectado — ej. `prisma/schema.prisma` — no se copia acá para no duplicar la fuente de verdad.)*');
  lines.push('');
  return lines.join('\n');
}

const INFERRED_RENDERERS: Record<CanonicalKnowledgeType, (project: Project, snapshot: ProjectSnapshot) => string | null> = {
  architecture: renderInferredArchitecture,
  conventions: renderInferredConventions,
  database: renderInferredDatabase,
  modules: () => null,
  'business-rules': () => null,
};

export interface GenerateInferredKnowledgeResult {
  /** Tipos con un doc nuevo o actualizado de verdad en esta corrida. */
  generated: KnowledgeDocRow[];
  /** Tipos con señal del Scanner, pero cuyo contenido inferido no cambió desde la última corrida (mismo hash) — no se reescribió nada. */
  unchanged: CanonicalKnowledgeType[];
  /** Tipos con un doc 'manual' ya existente — nunca se tocan (04: "nunca sobreescribe silenciosamente"). */
  skippedManual: CanonicalKnowledgeType[];
  /** Tipos para los que el Scanner no tiene señal suficiente todavía (ej. `conventions` sin scripts en `package.json`, `database` sin ORM/motor detectado) — no se generó un doc vacío. */
  skippedNoSignal: CanonicalKnowledgeType[];
}

/** `devpilot knowledge generate`: (re)genera los knowledge docs 'inferred' a partir del snapshot ya escaneado por `devpilot project add`. Nunca toca un doc 'manual'. */
export async function generateInferredKnowledge(rawPath: string): Promise<GenerateInferredKnowledgeResult> {
  const rootPath = path.resolve(rawPath);
  const project = resolveProjectOrThrow(rootPath);

  const snapshot = await readSnapshotFile(rootPath);
  if (!snapshot) {
    throw new Error(`No hay un snapshot guardado para este proyecto. Corre \`devpilot project add ${rawPath}\` primero.`);
  }

  const result: GenerateInferredKnowledgeResult = {
    generated: [],
    unchanged: [],
    skippedManual: [],
    skippedNoSignal: [],
  };

  const projectDb = openProjectDb(rootPath);
  try {
    for (const type of CANONICAL_TYPES) {
      const content = INFERRED_RENDERERS[type](project, snapshot);
      if (content === null) {
        result.skippedNoSignal.push(type);
        continue;
      }

      const existing = getKnowledgeDocById(projectDb, type);
      if (existing && existing.source === 'manual') {
        result.skippedManual.push(type);
        continue;
      }

      const contentHash = hashKnowledgeContent(content);
      if (existing && existing.contentHash === contentHash) {
        result.unchanged.push(type);
        continue;
      }

      const absPath = await writeKnowledgeFile(rootPath, type, content);
      const row: KnowledgeDocRow = {
        id: type,
        type,
        title: CANONICAL_TITLES[type],
        path: path.relative(rootPath, absPath),
        contentHash,
        source: 'inferred',
        updatedAt: new Date().toISOString(),
      };
      upsertKnowledgeDoc(projectDb, row);
      result.generated.push(row);
    }
  } finally {
    projectDb.close();
  }

  if (result.generated.length > 0) {
    await logSessionEvent(rootPath, 'knowledge-generated', {
      types: result.generated.map((r) => r.type),
    });
  }

  return result;
}

export interface SetManualKnowledgeParams {
  rawPath: string;
  type: ProjectKnowledgeDoc['type'];
  /** Archivo o texto literal — mismo contrato que `devpilot import <archivo-o-texto>`. */
  contentOrPath: string;
  /** Requerido para `type: 'custom'` (define el id vía slug); opcional para los tipos canónicos, donde reemplaza el título por defecto. */
  title?: string;
}

/** `devpilot knowledge edit <type> <archivo-o-texto>`: crea o reemplaza un knowledge doc 'manual' — a partir de acá, `devpilot knowledge generate` nunca vuelve a tocarlo (para los tipos canónicos). */
export async function setManualKnowledge(params: SetManualKnowledgeParams): Promise<KnowledgeDocRow> {
  const rootPath = path.resolve(params.rawPath);
  resolveProjectOrThrow(rootPath);

  if (params.type === 'custom' && !params.title) {
    throw new Error('Un knowledge doc "custom" necesita --title (los tipos canónicos ya tienen un título por defecto).');
  }

  const id = params.type === 'custom' ? `custom-${slugify(params.title as string)}` : params.type;
  const title = params.title ?? (isCanonicalType(params.type) ? CANONICAL_TITLES[params.type] : params.type);
  const content = await readFileOrLiteralText(params.contentOrPath);
  const contentHash = hashKnowledgeContent(content);

  const absPath = await writeKnowledgeFile(rootPath, id, content);
  const row: KnowledgeDocRow = {
    id,
    type: params.type,
    title,
    path: path.relative(rootPath, absPath),
    contentHash,
    source: 'manual',
    updatedAt: new Date().toISOString(),
  };

  const projectDb = openProjectDb(rootPath);
  try {
    upsertKnowledgeDoc(projectDb, row);
  } finally {
    projectDb.close();
  }

  await logSessionEvent(rootPath, 'knowledge-updated', { id, type: params.type, title });

  return row;
}

/** `devpilot knowledge list`. */
export async function listProjectKnowledge(rawPath: string): Promise<KnowledgeDocRow[]> {
  const rootPath = path.resolve(rawPath);
  resolveProjectOrThrow(rootPath);
  const projectDb = openProjectDb(rootPath);
  try {
    return listKnowledgeDocs(projectDb);
  } finally {
    projectDb.close();
  }
}

export interface KnowledgeDocWithContent extends KnowledgeDocRow {
  content: string;
}

/** `devpilot knowledge show <id>`. Para los tipos canónicos, `<id>` es directamente el nombre del tipo (`architecture`, `conventions`, ...) — ver el comentario de `getProjectKnowledgeFilePath` en paths.ts. */
export async function getProjectKnowledgeDoc(rawPath: string, id: string): Promise<KnowledgeDocWithContent | null> {
  const rootPath = path.resolve(rawPath);
  resolveProjectOrThrow(rootPath);
  const projectDb = openProjectDb(rootPath);
  let row: KnowledgeDocRow | null;
  try {
    row = getKnowledgeDocById(projectDb, id);
  } finally {
    projectDb.close();
  }
  if (!row) return null;
  const content = (await readKnowledgeFile(rootPath, id)) ?? '';
  return { ...row, content };
}

/**
 * Usado por `devpilot context` (contextService.ts) para armar la Project
 * Knowledge del pack — a diferencia de `listProjectKnowledge`, trae el
 * contenido de cada doc ya leído (necesario para inlinearlo en el
 * Markdown/prompt, ver contextPackBuilder.ts). Cardinalidad naturalmente
 * chica (5 tipos canónicos + los `custom` que el usuario haya creado), así
 * que a diferencia de `findRelevantDecisions` (decisionService.ts) NO se
 * filtra por keyword matching contra la tarea: Project Knowledge es
 * información de fondo (stack, convenciones) útil para prácticamente
 * cualquier tarea, no algo específico a un escenario puntual como una
 * Decision Record — se incluye siempre, completo, igual que "Información
 * del proyecto" en el Markdown.
 */
export async function listProjectKnowledgeWithContent(rawPath: string): Promise<KnowledgeDocWithContent[]> {
  const rootPath = path.resolve(rawPath);
  const rows = await listProjectKnowledge(rootPath);
  const withContent: KnowledgeDocWithContent[] = [];
  for (const row of rows) {
    const content = (await readKnowledgeFile(rootPath, row.id)) ?? '';
    withContent.push({ ...row, content });
  }
  return withContent;
}

/** Convierte la fila de storage al tipo de dominio `ProjectKnowledgeDoc` (@devpilot/shared) que espera `ContextPack.projectKnowledge` — mismo rol que `toDecisionRecord` en decisionService.ts. */
export function toProjectKnowledgeDoc(row: KnowledgeDocRow, projectId: string): ProjectKnowledgeDoc {
  return {
    id: row.id,
    projectId,
    type: row.type as ProjectKnowledgeDoc['type'],
    title: row.title,
    path: row.path,
    source: row.source as ProjectKnowledgeDoc['source'],
    updatedAt: row.updatedAt,
  };
}
