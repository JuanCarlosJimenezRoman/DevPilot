import type { Command } from 'commander';
import { importChanges } from '@devpilot/core';

const STATUS_LABEL: Record<string, string> = {
  valid: '✅ valid',
  warning: '⚠️  warning',
  reject: '❌ reject',
};

export function registerImportCommand(program: Command): void {
  program
    .command('import <archivo-o-texto>')
    .description(
      'Parsea (Capa 2) y valida (Capa 3) la respuesta cruda de una IA contra el Context Pack más reciente. Nunca aplica nada — eso es `devpilot apply`.',
    )
    .option('--project <ruta>', 'Ruta del proyecto (por defecto, el directorio actual)', '.')
    .option('--context-pack <id>', 'Id del Context Pack contra el que validar (por defecto, el más reciente)')
    .action(async (input: string, options: { project: string; contextPack?: string }) => {
      try {
        const result = await importChanges({
          rawPath: options.project,
          input,
          contextPackId: options.contextPack,
        });

        console.log(`Context Pack: ${result.contextPackId}`);
        console.log(`Cambios detectados: ${result.changes.length}`);
        console.log('');

        for (const { proposal, validation } of result.changes) {
          console.log(`${STATUS_LABEL[validation.status] ?? validation.status} · ${proposal.path}`);
          console.log(
            `  operación: ${proposal.operation} · formato: ${proposal.format} · confianza: ${validation.confidence}%`,
          );
          for (const check of validation.checks) {
            if (!check.passed) console.log(`  - ${check.name}: ${check.detail ?? '(sin detalle)'}`);
          }
          console.log('');
        }

        if (result.assumedDecisions.length > 0) {
          console.log('Decisiones que la IA declaró haber asumido:');
          for (const item of result.assumedDecisions) console.log(`  - ${item}`);
          console.log('');
        }

        if (result.unparsedNotes) {
          console.log('Texto sin mapear a ningún cambio (mostrado tal cual, nunca descartado):');
          console.log('---');
          console.log(result.unparsedNotes);
          console.log('---');
        }

        const rejected = result.changes.filter((c) => c.validation.status === 'reject').length;
        const warnings = result.changes.filter((c) => c.validation.status === 'warning').length;
        const valid = result.changes.filter((c) => c.validation.status === 'valid').length;
        console.log(`Resumen: ${valid} valid, ${warnings} warning, ${rejected} reject.`);
        console.log('Nada se aplicó — usa `devpilot diff` para revisar y `devpilot apply` para aplicar.');
      } catch (err) {
        console.error(`Error al importar: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
}
