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
  // Numeración de secciones por contador en vez de números hardcodeados:
  // varias secciones son condicionales (Restricciones, y desde esta pieza
  // Memoria de sesión), y mantener a mano qué número le toca a cada una
  // según cuáles están presentes se vuelve frágil apenas se agrega una
  // nueva (exactamente lo que pasó al sumar la sección de sesión).
  let sectionNumber = 0;
  const nextSection = (title: string): string => {
    sectionNumber += 1;
    return `## ${sectionNumber}. ${title}`;
  };

  lines.push(`# Context Pack — ${project.name}`);
  lines.push('');
  lines.push(`**Generado por DevPilot · ${pack.createdAt}**`);
  lines.push('');
  lines.push('---');
  lines.push('');

  lines.push(nextSection('Información del proyecto'));
  lines.push('');
  lines.push(`- **Nombre:** ${project.name}`);
  lines.push(`- **Stack:** ${stackLine(snapshot)}`);
  lines.push(`- **Archivos en el proyecto:** ${snapshot.fileCount}`);
  if (snapshot.gitCommit) lines.push(`- **Commit actual:** \`${snapshot.gitCommit}\``);
  lines.push('');

  if (pack.projectKnowledge.length > 0) {
    lines.push(nextSection('Project Knowledge'));
    lines.push('');
    lines.push(
      '*(Memoria de largo plazo del proyecto — arquitectura, convenciones, etc. Generada por heurísticas del Scanner o editada a mano; ver `devpilot knowledge list`. Siempre completa, no filtrada por relevancia a esta tarea puntual.)*',
    );
    lines.push('');
    lines.push(pack.projectKnowledgeText ?? '');
    lines.push('');
  }

  lines.push(nextSection('Tarea del usuario'));
  lines.push('');
  lines.push('> ' + pack.task.rawText.split('\n').join('\n> '));
  lines.push('');

  if (pack.sessionMemory) {
    lines.push(nextSection('Memoria de sesión'));
    lines.push('');
    lines.push(
      `*(Sesión activa \`${pack.sessionMemory.id}\`, iniciada ${pack.sessionMemory.startedAt} — ver \`devpilot session show ${pack.sessionMemory.id}\` para el log completo.)*`,
    );
    lines.push('');
    if (pack.sessionMemory.taskSummary) {
      lines.push(`**Resumen:** ${pack.sessionMemory.taskSummary}`);
      lines.push('');
    }
    if (pack.sessionMemory.events.length === 0) {
      lines.push('*(sin eventos registrados todavía en esta sesión)*');
    } else {
      lines.push(`Últimos ${pack.sessionMemory.events.length} evento(s) de esta sesión:`);
      lines.push('');
      for (const event of pack.sessionMemory.events) {
        const detailText = event.detail ? ` — ${JSON.stringify(event.detail)}` : '';
        lines.push(`- \`${event.timestamp}\` **${event.kind}**${detailText}`);
      }
    }
    lines.push('');
  }

  lines.push(nextSection('Decisiones del negocio'));
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
    lines.push(nextSection('Restricciones de alcance'));
    lines.push('');
    for (const item of pack.constraints) lines.push(`- ${item}`);
    lines.push('');
  }

  if (pack.recentChanges && pack.recentChanges.files.length > 0) {
    lines.push(nextSection('Cambios sin commitear'));
    lines.push('');
    lines.push(
      '*(Working tree contra HEAD — ver GitAdapter, 02/07 Incremento 3. Esto es lo que se está tocando ahora mismo, todavía sin commitear; complementa a la Memoria de sesión de arriba.)*',
    );
    lines.push('');
    for (const file of pack.recentChanges.files) {
      const fence = pickFence(file.patch);
      lines.push(`\`${file.path}\``);
      lines.push(fence + 'diff');
      lines.push(file.patch);
      lines.push(fence);
      lines.push('');
    }
  }

  lines.push(nextSection('Archivos relevantes'));
  lines.push('');
  lines.push(
    '*(Relevancia calculada por el Context Planner: Nivel 1 — texto/nombre de ruta —, Nivel 2 — imports directos —, Nivel 3 — símbolos exportados/declarados vía AST — y Nivel 4 — recencia y afinidad de mensaje en Git —, ver 04. Nivel 3/4 solo aportan boost a lo que Nivel 1/2 ya encontró — o, en el caso de Nivel 3, a un archivo que exporta el símbolo exacto que la tarea menciona.)*',
  );
  lines.push('');
  if (pack.relevantFiles.length === 0) {
    lines.push(
      '*(El Context Planner no encontró archivos relevantes para esta tarea. Prueba con palabras clave más específicas del código, entre backticks — ej. `NombreDeFuncion` o `NOMBRE_DE_CONSTANTE`.)*',
    );
  } else {
    for (const file of pack.relevantFiles) {
      const compactedNote = file.compactedToSignatures ? ' — ⚠️ solo firmas (Context Compaction)' : '';
      lines.push(`### \`${file.path}\` — **relevancia ${file.score.score}%**${compactedNote}`);
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

  lines.push(nextSection('Estimación de tokens'));
  lines.push('');
  const emoji = CLASSIFICATION_EMOJI[pack.tokenEstimate.classification];
  lines.push(`**≈ ${pack.tokenEstimate.totalTokens} tokens estimados** (caracteres/4) → ${emoji} \`${pack.tokenEstimate.classification}\`.`);
  lines.push('');
  if (pack.compaction) {
    lines.push(
      `**Context Compaction aplicada** (${pack.compaction.strategiesApplied.join(', ')}) — el pack se pasó de 🟢, ver detalle abajo:`,
    );
    lines.push('');
    for (const note of pack.compaction.notes) lines.push(`- ${note}`);
    lines.push('');
  }

  lines.push(nextSection('Instrucciones de formato de respuesta'));
  lines.push('');
  lines.push(pack.responseInstructions);
  lines.push('');

  return lines.join('\n');
}
