import type { Command } from 'commander';
import { assertNonEmptyTask, buildAndPersistContext, EmptyTaskError } from '@devpilot/core';

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
    .option(
      '--include <ruta>',
      'Fuerza que este archivo entre al pack completo, sin importar su score de relevancia (repetible). Desde sesión 14, `devpilot context` ya detecta solo el archivo que la tarea menciona con su ruta completa (y, si existe, el archivo de rutas de backend del mismo dominio) — usá este flag para casos que la auto-detección no cubre, ej. una página que combina varios dominios de backend.',
      collect,
      [],
    )
    .action(
      async (
        tarea: string,
        options: {
          project: string;
          confirmed: string[];
          open: string[];
          constraint: string[];
          maxFiles: string;
          include: string[];
        },
      ) => {
        try {
          // Falla rápido, antes de tocar el planner/lectura de archivos ni
          // el registro de proyectos: una tarea vacía o solo espacios no
          // es una tarea (ver `assertNonEmptyTask` en contextPackBuilder.ts,
          // que es la red de seguridad para cualquier otro caller — esta
          // validación acá es la que da el error claro y temprano al
          // usuario del CLI).
          assertNonEmptyTask(tarea);

          const result = await buildAndPersistContext({
            rawPath: options.project,
            taskText: tarea,
            confirmedDecisions: options.confirmed,
            openDecisions: options.open,
            constraints: options.constraint,
            maxFiles: Number.parseInt(options.maxFiles, 10) || undefined,
            includePaths: options.include,
          });

          const { pack } = result;
          console.log(`Context Pack generado: ${pack.id}`);
          console.log(`  Keywords detectadas: ${pack.task.extractedKeywords.join(', ') || '(ninguna)'}`);
          console.log(
            `  Archivos incluidos: ${pack.relevantFiles.length} de ${result.candidateCount} candidato(s) encontrados`,
          );
          for (const file of pack.relevantFiles) {
            // `explicit-include` cubre tres orígenes desde la auto-inclusión
            // de sesión 14 (ver relevancePlanner.ts/autoInclude.ts): el
            // `--include` manual del usuario, el archivo objetivo
            // auto-detectado por mención completa en la tarea, y un archivo
            // de rutas de backend del mismo dominio auto-detectado — el
            // `detail` de la razón ya distingue cuál de los tres fue, se
            // muestra tal cual en vez de un texto genérico para que quede
            // claro por qué entró.
            const includeReason = file.score.reasons.find((r) => r.kind === 'explicit-include');
            console.log(
              `    - ${file.path} (${file.score.score}%)${includeReason ? `  📌 ${includeReason.detail}` : ''}`,
            );
          }
          if (result.missingIncludePaths.length > 0) {
            console.error(
              `  ✖ No se pudo incluir con --include (no existe en el proyecto o no se pudo leer como texto): ${result.missingIncludePaths.join(', ')}`,
            );
          }
          console.log(
            `  Tokens estimados: ${pack.tokenEstimate.totalTokens} (${pack.tokenEstimate.classification})`,
          );
          if (pack.compaction) {
            console.log(`  Context Compaction aplicada: ${pack.compaction.strategiesApplied.join(', ')}`);
          }
          if (pack.recentChanges && pack.recentChanges.files.length > 0) {
            console.log(`  Cambios sin commitear incluidos: ${pack.recentChanges.files.length} archivo(s)`);
          }
          console.log(`  Markdown: ${result.markdownPath}`);
          console.log(`  JSON:     ${result.jsonPath}`);
          console.log(
            result.copiedToClipboard
              ? '  Copiado al portapapeles — pégalo en tu chat de IA favorito.'
              : '  No se pudo copiar al portapapeles automáticamente — copia el contenido del Markdown de arriba a mano.',
          );
        } catch (err) {
          if (err instanceof EmptyTaskError) {
            console.error(`✖ ${err.message}`);
          } else {
            console.error(`Error al generar el Context Pack: ${(err as Error).message}`);
          }
          process.exitCode = 1;
        }
      },
    );
}
