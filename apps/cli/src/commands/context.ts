import type { Command } from 'commander';
import { buildAndPersistContext } from '@devpilot/core';

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

export function registerContextCommand(program: Command): void {
  program
    .command('context <tarea>')
    .description(
      'Corre el Context Planner sobre un proyecto ya registrado y genera un Context Pack (Markdown + JSON, persistido en .devpilot/context/, copiado al portapapeles).',
    )
    .option('--project <ruta>', 'Ruta del proyecto (por defecto, el directorio actual)', '.')
    .option('--confirmed <texto>', 'Decisión de negocio ya confirmada (repetible)', collect, [])
    .option(
      '--open <texto>',
      'Punto abierto que la IA puede proponer pero no debe asumir como definitivo (repetible)',
      collect,
      [],
    )
    .option('--constraint <texto>', 'Restricción de alcance/técnica (repetible)', collect, [])
    .option('--max-files <n>', 'Máximo de archivos a incluir en el pack (compactación)', '8')
    .action(
      async (
        tarea: string,
        options: { project: string; confirmed: string[]; open: string[]; constraint: string[]; maxFiles: string },
      ) => {
        try {
          const result = await buildAndPersistContext({
            rawPath: options.project,
            taskText: tarea,
            confirmedDecisions: options.confirmed,
            openDecisions: options.open,
            constraints: options.constraint,
            maxFiles: Number.parseInt(options.maxFiles, 10) || undefined,
          });

          const { pack } = result;
          console.log(`Context Pack generado: ${pack.id}`);
          console.log(`  Keywords detectadas: ${pack.task.extractedKeywords.join(', ') || '(ninguna)'}`);
          console.log(
            `  Archivos incluidos: ${pack.relevantFiles.length} de ${result.candidateCount} candidato(s) encontrados`,
          );
          for (const file of pack.relevantFiles) {
            console.log(`    - ${file.path} (${file.score.score}%)`);
          }
          console.log(
            `  Tokens estimados: ${pack.tokenEstimate.totalTokens} (${pack.tokenEstimate.classification})`,
          );
          console.log(`  Markdown: ${result.markdownPath}`);
          console.log(`  JSON:     ${result.jsonPath}`);
          console.log(
            result.copiedToClipboard
              ? '  Copiado al portapapeles — pégalo en tu chat de IA favorito.'
              : '  No se pudo copiar al portapapeles automáticamente — copia el contenido del Markdown de arriba a mano.',
          );
        } catch (err) {
          console.error(`Error al generar el Context Pack: ${(err as Error).message}`);
          process.exitCode = 1;
        }
      },
    );
}
