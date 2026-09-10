import type { Command } from 'commander';
import { createDecision, getProjectDecision, listProjectDecisions, supersedeDecision } from '@devpilot/core';

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

const STATUS_LABEL: Record<string, string> = {
  proposed: '🟡 proposed',
  accepted: '✅ accepted',
  superseded: '⚪ superseded',
};

export function registerDecideCommand(program: Command): void {
  const decide = program
    .command('decide <titulo>')
    .description(
      'Crea una Decision Record (ADR liviano, ver 03/04): memoria de largo plazo que sobrevive a cualquier sesión futura, y que `devpilot context` busca automáticamente por relevancia a cada tarea nueva.',
    )
    .option('--project <ruta>', 'Ruta del proyecto (por defecto, el directorio actual)', '.')
    .option('--context <texto>', 'Por qué se tomó esta decisión — el problema/situación que la motivó')
    .option('--decision <texto>', 'Qué se decidió, en concreto')
    .option('--consequences <texto>', 'Qué implica esta decisión hacia adelante (trade-offs, deuda técnica aceptada, etc.)')
    .option('--tag <valor>', 'Tag para facilitar el matching por relevancia (repetible)', collect, [])
    .option('--related-file <ruta>', 'Archivo relacionado con esta decisión, relativo al proyecto (repetible)', collect, [])
    .option('--status <estado>', 'Estado inicial: "proposed" o "accepted" (por defecto)', 'accepted')
    .action(
      async (
        titulo: string,
        options: {
          project: string;
          context?: string;
          decision?: string;
          consequences?: string;
          tag: string[];
          relatedFile: string[];
          status: string;
        },
      ) => {
        if (!options.context || !options.decision) {
          console.error(
            'Hacen falta `--context "<por qué>"` y `--decision "<qué se decidió>"` para crear una Decision Record con sentido (ver 04, formato tipo ADR).',
          );
          process.exitCode = 1;
          return;
        }
        if (options.status !== 'proposed' && options.status !== 'accepted') {
          console.error(`--status "${options.status}" no es válido al crear — usa "proposed" o "accepted" ("superseded" se llega con \`devpilot decide supersede <id>\`).`);
          process.exitCode = 1;
          return;
        }

        try {
          const { decision, markdownPath } = await createDecision({
            rawPath: options.project,
            title: titulo,
            context: options.context,
            decisionText: options.decision,
            consequences: options.consequences,
            tags: options.tag,
            relatedFiles: options.relatedFile,
            status: options.status as 'proposed' | 'accepted',
          });

          console.log(`Decision Record creada: ${decision.id}`);
          console.log(`  Título:  ${decision.title}`);
          console.log(`  Estado:  ${STATUS_LABEL[decision.status] ?? decision.status}`);
          if (decision.tags.length > 0) console.log(`  Tags:    ${decision.tags.join(', ')}`);
          console.log(`  Espejo:  ${markdownPath}`);
          console.log('`devpilot context` la va a considerar automáticamente en tareas futuras relacionadas.');
        } catch (err) {
          console.error(`Error al crear la decisión: ${(err as Error).message}`);
          process.exitCode = 1;
        }
      },
    );

  // Nota (bug real de Commander encontrado al probar esto, no de nuestra
  // lógica): NINGUNO de los subcomandos de abajo (`list`/`show`/
  // `supersede`) declara su propio `--project` — solo `decide` (arriba) lo
  // tiene. Si un subcomando declara una opción con el MISMO nombre que ya
  // existe en su padre, Commander la asocia SIEMPRE al padre sin importar
  // en qué posición del comando aparezca el flag (antes o después del
  // nombre del subcomando) — el subcomando termina leyendo su propio
  // default, nunca el valor que el usuario pasó. Confirmado con un repro
  // aislado de Commander antes de tocar este archivo. La forma correcta es
  // declarar la opción una sola vez, en el padre, y que cada subcomando la
  // lea vía `cmd.parent.opts()` (el último parámetro que Commander pasa a
  // la acción es el propio objeto `Command`).
  decide
    .command('list')
    .description('Lista las Decision Records del proyecto.')
    .action(async (_options: unknown, cmd: Command) => {
      const project = (cmd.parent?.opts().project as string | undefined) ?? '.';
      try {
        const decisions = await listProjectDecisions(project);
        if (decisions.length === 0) {
          console.log('No hay ninguna Decision Record todavía. Usa `devpilot decide "<título>"` para crear la primera.');
          return;
        }
        for (const d of decisions) {
          const tagsSuffix = d.tags.length > 0 ? ` [${d.tags.join(', ')}]` : '';
          console.log(`${STATUS_LABEL[d.status] ?? d.status} · ${d.id} · ${d.title}${tagsSuffix}`);
        }
      } catch (err) {
        console.error(`Error al listar decisiones: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });

  decide
    .command('show <id>')
    .description('Muestra el detalle completo de una Decision Record.')
    .action(async (id: string, _options: unknown, cmd: Command) => {
      const project = (cmd.parent?.opts().project as string | undefined) ?? '.';
      try {
        const d = await getProjectDecision(project, id);
        if (!d) {
          console.error(`No existe ninguna decisión con id ${id} en este proyecto. Usa \`devpilot decide list\` para ver los ids disponibles.`);
          process.exitCode = 1;
          return;
        }
        console.log(`${d.title}  (${d.id})`);
        console.log(`Estado: ${STATUS_LABEL[d.status] ?? d.status} · Creada: ${d.createdAt} · Usada en ${d.usedInPacksCount} Context Pack(s)`);
        if (d.tags.length > 0) console.log(`Tags: ${d.tags.join(', ')}`);
        if (d.relatedFiles.length > 0) console.log(`Archivos relacionados: ${d.relatedFiles.join(', ')}`);
        console.log('');
        console.log('Contexto:');
        console.log(`  ${d.context}`);
        console.log('');
        console.log('Decisión:');
        console.log(`  ${d.decision}`);
        if (d.consequences) {
          console.log('');
          console.log('Consecuencias:');
          console.log(`  ${d.consequences}`);
        }
      } catch (err) {
        console.error(`Error al mostrar la decisión: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });

  decide
    .command('supersede <id>')
    .description('Marca una Decision Record como superseded — nunca se borra, pero deja de ofrecerse como "confirmada" en Context Packs nuevos.')
    .action(async (id: string, _options: unknown, cmd: Command) => {
      const project = (cmd.parent?.opts().project as string | undefined) ?? '.';
      try {
        const updated = await supersedeDecision(project, id);
        console.log(`Marcada como superseded: ${updated.title} (${updated.id})`);
      } catch (err) {
        console.error(`Error al marcar la decisión como superseded: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });

  // --project sigue documentado en `devpilot decide --help` (arriba) pero
  // no en `devpilot decide list --help` etc. — es un poco menos
  // descubrible así, pero preferible al bug de silenciosamente ignorar el
  // valor pasado. Ver el comentario de arriba para el porqué.
}
