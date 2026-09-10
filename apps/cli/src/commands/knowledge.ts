import type { Command } from 'commander';
import {
  generateInferredKnowledge,
  getProjectKnowledgeDoc,
  listProjectKnowledge,
  setManualKnowledge,
} from '@devpilot/core';

const VALID_TYPES = ['architecture', 'modules', 'database', 'business-rules', 'conventions', 'custom'] as const;
type KnowledgeType = (typeof VALID_TYPES)[number];

function isValidType(value: string): value is KnowledgeType {
  return (VALID_TYPES as readonly string[]).includes(value);
}

const SOURCE_LABEL: Record<string, string> = {
  manual: '✍️  manual',
  inferred: '🔍 inferred',
  'deep-analysis': '🤖 deep-analysis',
};

export function registerKnowledgeCommand(program: Command): void {
  // Mismo bug de Commander documentado en decide.ts/session.ts: `--project`
  // se declara UNA sola vez, acá, en el comando padre — ningún subcomando
  // de abajo lo redeclara. Cada subcomando lo lee vía `cmd.parent.opts()`.
  const knowledge = program
    .command('knowledge')
    .description(
      'Project Knowledge (04): memoria de largo plazo sobre el proyecto (arquitectura, convenciones, base de datos...) que `devpilot context` incluye siempre, completa, en cada Context Pack.',
    )
    .option('--project <ruta>', 'Ruta del proyecto (por defecto, el directorio actual)', '.');

  knowledge
    .command('generate')
    .description(
      '(Re)genera los knowledge docs "inferred" a partir del snapshot ya escaneado por `devpilot project add`. Nunca toca un doc "manual" existente.',
    )
    .action(async (_options: unknown, cmd: Command) => {
      const project = (cmd.parent?.opts().project as string | undefined) ?? '.';
      try {
        const result = await generateInferredKnowledge(project);
        if (result.generated.length > 0) {
          console.log(`Generados/actualizados: ${result.generated.map((d) => d.type).join(', ')}`);
        }
        if (result.unchanged.length > 0) {
          console.log(`Sin cambios (contenido inferido idéntico): ${result.unchanged.join(', ')}`);
        }
        if (result.skippedManual.length > 0) {
          console.log(`Saltados (ya tienen un doc manual — nunca se sobreescriben): ${result.skippedManual.join(', ')}`);
        }
        if (result.skippedNoSignal.length > 0) {
          console.log(`Sin señal suficiente todavía: ${result.skippedNoSignal.join(', ')}`);
        }
        if (result.generated.length === 0 && result.unchanged.length === 0) {
          console.log('El Scanner no tiene señal para ningún tipo canónico todavía.');
        }
      } catch (err) {
        console.error(`Error al generar Project Knowledge: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });

  knowledge
    .command('list')
    .description('Lista los knowledge docs del proyecto.')
    .action(async (_options: unknown, cmd: Command) => {
      const project = (cmd.parent?.opts().project as string | undefined) ?? '.';
      try {
        const rows = await listProjectKnowledge(project);
        if (rows.length === 0) {
          console.log('No hay ningún knowledge doc todavía. Usa `devpilot knowledge generate` o `devpilot knowledge edit <tipo> <archivo-o-texto>`.');
          return;
        }
        for (const row of rows) {
          console.log(`${SOURCE_LABEL[row.source] ?? row.source} · ${row.id} · ${row.title} · actualizado ${row.updatedAt}`);
        }
      } catch (err) {
        console.error(`Error al listar Project Knowledge: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });

  knowledge
    .command('show <id>')
    .description('Muestra el contenido completo de un knowledge doc (para los tipos canónicos, <id> es el nombre del tipo: architecture, conventions, ...).')
    .action(async (id: string, _options: unknown, cmd: Command) => {
      const project = (cmd.parent?.opts().project as string | undefined) ?? '.';
      try {
        const doc = await getProjectKnowledgeDoc(project, id);
        if (!doc) {
          console.error(`No existe ningún knowledge doc con id "${id}" en este proyecto. Usa \`devpilot knowledge list\` para ver los ids disponibles.`);
          process.exitCode = 1;
          return;
        }
        console.log(`${doc.title}  (${doc.id})`);
        console.log(`Origen: ${SOURCE_LABEL[doc.source] ?? doc.source} · Actualizado: ${doc.updatedAt}`);
        console.log('');
        console.log(doc.content);
      } catch (err) {
        console.error(`Error al mostrar el knowledge doc: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });

  knowledge
    .command('edit <tipo> <archivo-o-texto>')
    .description(
      'Crea o reemplaza un knowledge doc "manual". <tipo> es uno de architecture|modules|database|business-rules|conventions|custom. A partir de acá, `devpilot knowledge generate` nunca vuelve a tocar este doc (si es de un tipo canónico).',
    )
    .option('--title <título>', 'Requerido para tipo "custom" (define el id); opcional para los demás (reemplaza el título por defecto)')
    .action(async (tipo: string, contenido: string, options: { title?: string }, cmd: Command) => {
      const project = (cmd.parent?.opts().project as string | undefined) ?? '.';
      if (!isValidType(tipo)) {
        console.error(`"${tipo}" no es un tipo válido — usa uno de: ${VALID_TYPES.join(', ')}.`);
        process.exitCode = 1;
        return;
      }
      try {
        const row = await setManualKnowledge({
          rawPath: project,
          type: tipo,
          contentOrPath: contenido,
          title: options.title,
        });
        console.log(`Knowledge doc guardado: ${row.id}`);
        console.log(`  Título: ${row.title}`);
        console.log('`devpilot knowledge generate` no va a volver a tocar este doc.');
      } catch (err) {
        console.error(`Error al guardar el knowledge doc: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
}
