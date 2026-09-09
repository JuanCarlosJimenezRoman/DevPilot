import type { ContextPack, Project, ProjectSnapshot } from '@devpilot/shared';

// Renderiza el `ContextPack` a Markdown listo para copiar/pegar en un chat
// web (ver 04/06/07). La estructura sigue de cerca el pack real
// hand-crafted del Paso 0 (`paso0-context-pack-camino-al-deporte.md`), con
// las secciones añadidas después de esa prueba: Decisiones del negocio
// (confirmadas/abiertas) y la Capa 1 endurecida de `responseInstructions`.

const CLASSIFICATION_EMOJI: Record<ContextPack['tokenEstimate']['classification'], string> = {
  green: '🟢',
  yellow: '🟡',
  red: '🔴',
};

const FENCE_LANG_BY_LANGUAGE: Record<string, string> = {
  typescript: 'ts',
  javascript: 'js',
  json: 'json',
  markdown: 'md',
  css: 'css',
  html: 'html',
  prisma: 'prisma',
  sql: 'sql',
  python: 'python',
  go: 'go',
  rust: 'rust',
  yaml: 'yaml',
};

function fenceLangForPath(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  if (dot === -1) return '';
  const ext = filePath.slice(dot + 1).toLowerCase();
  const byExt: Record<string, string> = {
    ts: 'ts',
    tsx: 'tsx',
    js: 'js',
    jsx: 'jsx',
    json: 'json',
    md: 'md',
    css: 'css',
    html: 'html',
    prisma: 'prisma',
    sql: 'sql',
    py: 'python',
    go: 'go',
    rs: 'rust',
    yml: 'yaml',
    yaml: 'yaml',
  };
  return byExt[ext] ?? FENCE_LANG_BY_LANGUAGE[ext] ?? '';
}

// Si el contenido de un archivo trae él mismo una racha de backticks (ej.
// un .md con sus propios fences de código — un candidato realista, ver el
// Paso 0 donde docs/ARQUITECTURA.md fue parte del pack), un fence de
// exactamente 3 backticks se cerraría antes de tiempo y rompería el
// documento entero. Regla de CommonMark: el fence de apertura solo
// necesita ser tan largo o más que cualquier racha de backticks adentro.
function pickFence(content: string): string {
  const runs = content.match(/`{3,}/g) ?? [];
  const longestRun = runs.reduce((max, run) => Math.max(max, run.length), 0);
  return '`'.repeat(Math.max(3, longestRun + 1));
}

function stackLine(snapshot: ProjectSnapshot): string {
  const parts: string[] = [];
  if (snapshot.language.length > 0) parts.push(snapshot.language.slice(0, 4).join('/'));
  if (snapshot.framework) parts.push(snapshot.framework);
  if (snapshot.packageManager) parts.push(snapshot.packageManager);
  if (snapshot.orm) parts.push(snapshot.orm);
  if (snapshot.database) parts.push(snapshot.database);
  return parts.length > 0 ? parts.join(' + ') : '(stack no detectado)';
}

export function renderContextPackMarkdown(
  pack: ContextPack,
  project: Project,
  snapshot: ProjectSnapshot,
): string {
  const lines: string[] = [];

  lines.push(`# Context Pack — ${project.name}`);
  lines.push('');
  lines.push(`**Generado por DevPilot · ${pack.createdAt}**`);
  lines.push('');
  lines.push('---');
  lines.push('');

  lines.push('## 1. Información del proyecto');
  lines.push('');
  lines.push(`- **Nombre:** ${project.name}`);
  lines.push(`- **Stack:** ${stackLine(snapshot)}`);
  lines.push(`- **Archivos en el proyecto:** ${snapshot.fileCount}`);
  if (snapshot.gitCommit) lines.push(`- **Commit actual:** \`${snapshot.gitCommit}\``);
  lines.push('');

  lines.push('## 2. Tarea del usuario');
  lines.push('');
  lines.push('> ' + pack.task.rawText.split('\n').join('\n> '));
  lines.push('');

  lines.push('## 3. Decisiones del negocio');
  lines.push('');
  if (pack.businessDecisions.confirmed.length === 0 && pack.businessDecisions.open.length === 0) {
    lines.push(
      '*(No se indicaron decisiones al generar este pack — usa `--confirmed`/`--open` en `devpilot context` para incluirlas. Sin esto, la IA tiene más espacio para inventar reglas de negocio no verificadas — ver 04/06.)*',
    );
  } else {
    lines.push('### Confirmadas');
    lines.push('');
    if (pack.businessDecisions.confirmed.length === 0) {
      lines.push('*(ninguna)*');
    } else {
      for (const item of pack.businessDecisions.confirmed) lines.push(`- ${item}`);
    }
    lines.push('');
    lines.push('### Abiertas (la IA puede proponer, no debe asumir como definitivo)');
    lines.push('');
    if (pack.businessDecisions.open.length === 0) {
      lines.push('*(ninguna)*');
    } else {
      for (const item of pack.businessDecisions.open) lines.push(`- ${item}`);
    }
  }
  lines.push('');

  if (pack.constraints.length > 0) {
    lines.push('## 4. Restricciones de alcance');
    lines.push('');
    for (const item of pack.constraints) lines.push(`- ${item}`);
    lines.push('');
  }

  const filesHeading = pack.constraints.length > 0 ? '5' : '4';
  lines.push(`## ${filesHeading}. Archivos relevantes`);
  lines.push('');
  lines.push(
    '*(Relevancia calculada por Nivel 1 + Nivel 2 del Context Planner: coincidencia de texto/nombre de ruta + imports directos. Nivel 3/4 — símbolos AST y Git — no aplican todavía, ver roadmap.)*',
  );
  lines.push('');
  if (pack.relevantFiles.length === 0) {
    lines.push(
      '*(El Context Planner no encontró archivos relevantes para esta tarea. Prueba con palabras clave más específicas del código, entre backticks — ej. `NombreDeFuncion` o `NOMBRE_DE_CONSTANTE`.)*',
    );
  } else {
    for (const file of pack.relevantFiles) {
      lines.push(`### \`${file.path}\` — **relevancia ${file.score.score}%**`);
      const reasonsText = file.score.reasons.map((r) => r.detail).join('; ');
      lines.push(`*Razones: ${reasonsText}*`);
      lines.push('');
      const fence = pickFence(file.content);
      lines.push(fence + fenceLangForPath(file.path));
      lines.push(file.content);
      lines.push(fence);
      lines.push('');
    }
  }

  const tokensHeading = pack.constraints.length > 0 ? '6' : '5';
  lines.push(`## ${tokensHeading}. Estimación de tokens`);
  lines.push('');
  const emoji = CLASSIFICATION_EMOJI[pack.tokenEstimate.classification];
  lines.push(`**≈ ${pack.tokenEstimate.totalTokens} tokens estimados** (caracteres/4) → ${emoji} \`${pack.tokenEstimate.classification}\`.`);
  lines.push('');

  const instructionsHeading = pack.constraints.length > 0 ? '7' : '6';
  lines.push(`## ${instructionsHeading}. Instrucciones de formato de respuesta`);
  lines.push('');
  lines.push(pack.responseInstructions);
  lines.push('');

  return lines.join('\n');
}
