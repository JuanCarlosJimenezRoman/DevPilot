import type { Project } from '@devpilot/shared';

// Prompt de `devpilot analyze --deep` (Incremento 4, ver 07). A diferencia
// del Context Pack de `devpilot context` (contextPackBuilder.ts), acá NO se
// arma un paquete con contenido de archivos: Claude Code corre como
// subprocess con `cwd` en el root del proyecto y sus propias herramientas
// de lectura (06: "toolCalling: true... Claude Code tiene sus propias
// herramientas"), así que puede explorar el código real por su cuenta. El
// prompt solo necesita dar el contrato de salida y las señales que
// DevPilot ya tiene (para no pedirle que redescubra lo que ya se sabe, y
// para que no proponga contenido que contradiga un knowledge doc manual).

export interface ExistingKnowledgeSummary {
  type: string;
  title: string;
  source: string;
}

export interface ExistingDecisionSummary {
  title: string;
}

export interface BuildDeepAnalysisPromptParams {
  project: Project;
  existingKnowledge: ExistingKnowledgeSummary[];
  existingDecisions: ExistingDecisionSummary[];
  /** `null` si no es un repo git o si es el primer análisis profundo — en ese caso se pide un análisis completo. */
  lastDeepAnalysisCommit: string | null;
  /** Rutas tocadas desde `lastDeepAnalysisCommit` (git diff --name-status), como pista de dónde mirar primero — nunca reemplaza la exploración propia de Claude Code, ver comentario de abajo. `null` si no aplica (sin análisis previo, o proyecto sin git). */
  changedFilesSinceLastAnalysis: string[] | null;
}

const OUTPUT_CONTRACT = `## Formato de respuesta obligatorio

Para cada pieza de conocimiento que quieras proponer, usa EXACTAMENTE este formato (uno o más bloques, uno por documento):

<DEVPILOT_KNOWLEDGE type="architecture">
... contenido en Markdown completo para ese documento ...
</DEVPILOT_KNOWLEDGE>

Tipos válidos para "type": "architecture", "modules", "database", "business-rules", "conventions" (documentos canónicos de Project Knowledge), o "custom" (para cualquier otro conocimiento que no encaje en los anteriores — en ese caso agregá también \`title="..."\`, obligatorio solo para "custom").

Si detectás una decisión de diseño o de negocio real ya tomada en el código (no una que estés proponiendo vos), describila así:

<DEVPILOT_DECISION>
title: <título corto>
context: <por qué hizo falta esta decisión>
decision: <qué se decidió>
consequences: <opcional — qué implica esto>
</DEVPILOT_DECISION>

No uses ningún otro formato de marcador. Cualquier texto fuera de estos bloques (explicaciones, dudas, aclaraciones) es válido y se te va a mostrar igual al usuario, pero no se va a guardar como conocimiento del proyecto — así que poné todo el contenido real DENTRO de los bloques.`;

export function buildDeepAnalysisPrompt(params: BuildDeepAnalysisPromptParams): string {
  const lines: string[] = [];

  lines.push(
    `Estás corriendo como Claude Code invocado por DevPilot (\`devpilot analyze --deep\`) sobre el proyecto "${params.project.name}", en modo de solo lectura/plan: podés explorar el código con tus propias herramientas, pero NO edites ni crees archivos — tu tarea es proponer contenido para la memoria de conocimiento del proyecto (Project Knowledge de DevPilot), no modificar el código.`,
  );
  lines.push('');
  lines.push(
    'Explorá el proyecto (estructura de carpetas, código real de los módulos principales, configuración) y generá documentos honestos: si no tenés señal suficiente para un tipo de documento, simplemente no lo incluyas — nunca inventes contenido para rellenar.',
  );
  lines.push('');

  lines.push('## Qué proponer');
  lines.push('');
  lines.push(
    '- **`architecture`**: cómo está organizado el proyecto de verdad (capas, módulos principales, cómo se comunican) — más allá de lo que ya dice el stack detectado automáticamente.',
  );
  lines.push(
    '- **`modules`**: qué hace cada módulo/carpeta principal del código real, en términos que alguien nuevo en el proyecto entendería.',
  );
  lines.push(
    '- **`business-rules`**: reglas de negocio reales que encuentres en el código (validaciones, umbrales, casos especiales) — no inventadas, solo las que el código realmente implementa.',
  );
  lines.push('- **`database`** / **`conventions`**: solo si tenés algo que agregar a lo que el Scanner ya infirió (ver abajo) — no dupliques sin aportar nada nuevo.');
  lines.push(
    '- **Decisiones detectadas**: decisiones de diseño reales que el código refleja (ej. "se usa X en vez de Y por Z razón" si es inferible del código/comentarios/commits), no decisiones hipotéticas.',
  );
  lines.push('');

  if (params.existingKnowledge.length > 0) {
    lines.push('## Project Knowledge que ya existe (no lo repitas sin aportar algo nuevo)');
    lines.push('');
    for (const doc of params.existingKnowledge) {
      lines.push(`- \`${doc.type}\` — "${doc.title}" (origen: ${doc.source})`);
    }
    lines.push('');
    lines.push(
      'Nota: si un documento existente es de origen "manual", DevPilot nunca lo va a sobreescribir aunque vos propongas contenido para ese tipo (el usuario lo escribió a mano a propósito) — igual podés proponerlo si creés que agrega valor, pero no hace falta que evites ese tipo por completo.',
    );
    lines.push('');
  } else {
    lines.push('## Project Knowledge existente: ninguno todavía.');
    lines.push('');
  }

  if (params.existingDecisions.length > 0) {
    lines.push('## Decisiones ya registradas (no las repitas)');
    lines.push('');
    for (const decision of params.existingDecisions) {
      lines.push(`- ${decision.title}`);
    }
    lines.push('');
  }

  if (params.lastDeepAnalysisCommit) {
    lines.push(
      `## Análisis incremental — ya se corrió un análisis profundo antes (commit \`${params.lastDeepAnalysisCommit}\`)`,
    );
    lines.push('');
    if (params.changedFilesSinceLastAnalysis && params.changedFilesSinceLastAnalysis.length > 0) {
      lines.push('Archivos tocados desde entonces (pista de dónde mirar primero, no una lista cerrada — explorá lo que haga falta más allá de esta lista si el resto del proyecto también es relevante para lo que vayas a proponer):');
      lines.push('');
      for (const file of params.changedFilesSinceLastAnalysis.slice(0, 200)) {
        lines.push(`- ${file}`);
      }
      if (params.changedFilesSinceLastAnalysis.length > 200) {
        lines.push(`- ... y ${params.changedFilesSinceLastAnalysis.length - 200} archivo(s) más.`);
      }
    } else {
      lines.push('No hay archivos nuevos tocados desde el último análisis (o el proyecto no es un repo git) — igual podés proponer contenido si encontrás algo que el análisis anterior no haya cubierto.');
    }
    lines.push('');
  } else {
    lines.push('## Este es el primer análisis profundo de este proyecto — evaluá el proyecto completo.');
    lines.push('');
  }

  lines.push(OUTPUT_CONTRACT);

  return lines.join('\n');
}
