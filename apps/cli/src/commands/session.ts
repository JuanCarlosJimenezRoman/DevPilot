import type { Command } from 'commander';
import {
  addSessionNote,
  endActiveSession,
  getProjectSession,
  listProjectSessions,
  promoteSessionEvent,
  startSession,
} from '@devpilot/core';

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

function statusLabel(row: { endedAt: string | null }): string {
  return row.endedAt ? '⚪ cerrada' : '🟢 activa';
}

export function registerSessionCommand(program: Command): void {
  // Mismo bug de Commander documentado en decide.ts: `--project` se
  // declara UNA sola vez, acá, en el comando padre — ningún subcomando de
  // abajo lo redeclara. Cada subcomando lo lee vía `cmd.parent.opts()`.
  const session = program
    .command('session')
    .description(
      'Session Memory (04, "una sesión = una invocación conceptual de trabajo"): agrupa varios comandos CLI bajo un mismo hilo, con un log turno-a-turno que `devpilot context` incluye automáticamente mientras está activa.',
    )
    .option('--project <ruta>', 'Ruta del proyecto (por defecto, el directorio actual)', '.');

  session
    .command('start <resumen>')
    .description('Abre una sesión nueva. Falla si ya hay una activa — cerrala primero con `devpilot session end`.')
    .option('--provider <nombre>', 'Qué IA se va a usar en esta sesión (Claude/ChatGPT/DeepSeek/...), solo informativo')
    .action(async (resumen: string, options: { provider?: string }, cmd: Command) => {
      const project = (cmd.parent?.opts().project as string | undefined) ?? '.';
      try {
        const row = await startSession({ rawPath: project, taskSummary: resumen, providerUsed: options.provider });
        console.log(`Sesión iniciada: ${row.id}`);
        console.log(`  Resumen: ${row.taskSummary}`);
        console.log('`devpilot context`/`import`/`apply`/`decide` van a loguear eventos acá automáticamente mientras esta sesión siga activa.');
      } catch (err) {
        console.error(`Error al iniciar la sesión: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });

  session
    .command('end')
    .description('Cierra la sesión activa del proyecto (no hace falta indicar un id — solo puede haber una activa a la vez).')
    .option('--summary <texto>', 'Reemplaza el resumen de la sesión con este texto al cerrarla')
    .action(async (options: { summary?: string }, cmd: Command) => {
      const project = (cmd.parent?.opts().project as string | undefined) ?? '.';
      try {
        const row = await endActiveSession({ rawPath: project, summary: options.summary });
        console.log(`Sesión cerrada: ${row.id}`);
        if (row.taskSummary) console.log(`  Resumen: ${row.taskSummary}`);
      } catch (err) {
        console.error(`Error al cerrar la sesión: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });

  session
    .command('list')
    .description('Lista las sesiones del proyecto, más reciente primero.')
    .option('--limit <n>', 'Cuántas mostrar (por defecto 20)', '20')
    .action(async (options: { limit: string }, cmd: Command) => {
      const project = (cmd.parent?.opts().project as string | undefined) ?? '.';
      try {
        const rows = await listProjectSessions(project, Number(options.limit));
        if (rows.length === 0) {
          console.log('No hay ninguna sesión todavía. Usa `devpilot session start "<resumen>"` para empezar la primera.');
          return;
        }
        for (const row of rows) {
          const rango = row.endedAt ? `${row.startedAt} → ${row.endedAt}` : `${row.startedAt} → (activa)`;
          console.log(`${statusLabel(row)} · ${row.id} · ${rango}${row.taskSummary ? ` · ${row.taskSummary}` : ''}`);
        }
      } catch (err) {
        console.error(`Error al listar sesiones: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });

  session
    .command('show <id>')
    .description('Muestra el detalle de una sesión: resumen + el log completo de eventos (índice, timestamp, tipo, detalle).')
    .action(async (id: string, _options: unknown, cmd: Command) => {
      const project = (cmd.parent?.opts().project as string | undefined) ?? '.';
      try {
        const detail = await getProjectSession(project, id);
        if (!detail) {
          console.error(`No existe ninguna sesión con id ${id} en este proyecto. Usa \`devpilot session list\` para ver los ids disponibles.`);
          process.exitCode = 1;
          return;
        }
        console.log(`${statusLabel(detail)} · ${detail.id}`);
        console.log(`Iniciada: ${detail.startedAt}${detail.endedAt ? ` · Cerrada: ${detail.endedAt}` : ''}`);
        if (detail.taskSummary) console.log(`Resumen: ${detail.taskSummary}`);
        if (detail.providerUsed) console.log(`Proveedor: ${detail.providerUsed}`);
        console.log('');
        if (detail.events.length === 0) {
          console.log('(sin eventos registrados todavía)');
        } else {
          console.log(`Eventos (${detail.events.length}):`);
          detail.events.forEach((event, index) => {
            const detailText = event.detail ? ` — ${JSON.stringify(event.detail)}` : '';
            console.log(`  [${index}] ${event.timestamp} · ${event.kind}${detailText}`);
          });
          console.log('');
          console.log('Usa `devpilot session promote <id> --event <índice> --title "..." --decision "..."` para convertir uno de estos eventos en una Decision Record real.');
        }
      } catch (err) {
        console.error(`Error al mostrar la sesión: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });

  session
    .command('note <texto>')
    .description('Agrega una nota manual a la sesión activa — para algo que vale la pena recordar y que ningún comando logueó solo. Requiere una sesión activa.')
    .action(async (texto: string, _options: unknown, cmd: Command) => {
      const project = (cmd.parent?.opts().project as string | undefined) ?? '.';
      try {
        const { sessionId } = await addSessionNote(project, texto);
        console.log(`Nota agregada a la sesión ${sessionId}.`);
      } catch (err) {
        console.error(`Error al agregar la nota: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });

  session
    .command('promote <id>')
    .description(
      'Promueve un evento del log de una sesión (activa o ya cerrada) a una Decision Record real (04: "candidata a promoverse a una Decision Record si algo importante se decidió").',
    )
    .requiredOption('--event <índice>', 'Índice del evento dentro del log de la sesión (ver `devpilot session show <id>`)')
    .requiredOption('--title <título>', 'Título de la Decision Record resultante')
    .requiredOption('--decision <texto>', 'Qué se decidió, en concreto')
    .option('--context <texto>', 'Por qué se tomó esta decisión — si no se pasa, se genera uno describiendo de qué evento viene')
    .option('--consequences <texto>', 'Qué implica esta decisión hacia adelante')
    .option('--tag <valor>', 'Tag para facilitar el matching por relevancia (repetible)', collect, [])
    .option('--related-file <ruta>', 'Archivo relacionado con esta decisión, relativo al proyecto (repetible)', collect, [])
    .option('--status <estado>', 'Estado inicial: "proposed" o "accepted" (por defecto)', 'accepted')
    .action(
      async (
        id: string,
        options: {
          event: string;
          title: string;
          decision: string;
          context?: string;
          consequences?: string;
          tag: string[];
          relatedFile: string[];
          status: string;
        },
        cmd: Command,
      ) => {
        const project = (cmd.parent?.opts().project as string | undefined) ?? '.';
        if (options.status !== 'proposed' && options.status !== 'accepted') {
          console.error(`--status "${options.status}" no es válido — usa "proposed" o "accepted".`);
          process.exitCode = 1;
          return;
        }
        const eventIndex = Number(options.event);
        if (!Number.isInteger(eventIndex) || eventIndex < 0) {
          console.error(`--event "${options.event}" no es un índice válido — tiene que ser un entero ≥ 0 (ver \`devpilot session show ${id}\`).`);
          process.exitCode = 1;
          return;
        }

        try {
          const { decision, markdownPath } = await promoteSessionEvent({
            rawPath: project,
            sessionId: id,
            eventIndex,
            title: options.title,
            decisionText: options.decision,
            context: options.context,
            consequences: options.consequences,
            tags: options.tag,
            relatedFiles: options.relatedFile,
            status: options.status as 'proposed' | 'accepted',
          });
          console.log(`Decision Record creada a partir del evento [${eventIndex}] de la sesión ${id}: ${decision.id}`);
          console.log(`  Título:  ${decision.title}`);
          console.log(`  Espejo:  ${markdownPath}`);
        } catch (err) {
          console.error(`Error al promover el evento: ${(err as Error).message}`);
          process.exitCode = 1;
        }
      },
    );
}
