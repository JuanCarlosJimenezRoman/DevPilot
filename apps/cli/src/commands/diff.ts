import type { Command } from 'commander';
import { computeDiff } from '@devpilot/core';

const STATUS_LABEL: Record<string, string> = {
  valid: '✅ valid — listo para aplicar',
  warning: '⚠️  warning — decisión pendiente',
  reject: '❌ reject — no se ofrece para aplicar',
};

function colorizeDiff(diffText: string): string {
  // Coloreado mínimo, sin dependencia nueva (mismo criterio que
  // clipboard.ts): +/- de contenido en verde/rojo, encabezados de hunk en
  // cian, cabeceras ---/+++ sin color (para no confundirlas con líneas de
  // contenido que empiezan igual).
  return diffText
    .split('\n')
    .map((line) => {
      if (line.startsWith('+++') || line.startsWith('---')) return line;
      if (line.startsWith('+')) return `\x1b[32m${line}\x1b[0m`;
      if (line.startsWith('-')) return `\x1b[31m${line}\x1b[0m`;
      if (line.startsWith('@@')) return `\x1b[36m${line}\x1b[0m`;
      return line;
    })
    .join('\n');
}

export function registerDiffCommand(program: Command): void {
  program
    .command('diff')
    .description(
      'Reconstruye y muestra el diff real de los cambios ya importados contra el Context Pack más reciente. Nunca toca disco — eso es `devpilot apply`.',
    )
    .option('--project <ruta>', 'Ruta del proyecto (por defecto, el directorio actual)', '.')
    .option('--context-pack <id>', 'Id del Context Pack cuyas propuestas mostrar (por defecto, el más reciente)')
    .action(async (options: { project: string; contextPack?: string }) => {
      try {
        const result = await computeDiff({ rawPath: options.project, contextPackId: options.contextPack });

        if (result.entries.length === 0) {
          console.log(`Context Pack: ${result.contextPackId}`);
          console.log('No hay cambios importados todavía para este Context Pack. Corre `devpilot import` primero.');
          return;
        }

        console.log(`Context Pack: ${result.contextPackId}`);
        console.log('');

        for (const entry of result.entries) {
          console.log(`${STATUS_LABEL[entry.validationStatus] ?? entry.validationStatus} · ${entry.filePath}`);
          console.log(
            `  operación: ${entry.operation} · formato: ${entry.format} · confianza: ${entry.confidence}%`,
          );
          for (const check of entry.failingChecks) {
            console.log(`  - ${check.name}: ${check.detail ?? '(sin detalle)'}`);
          }
          console.log('');
          if (entry.diffText) {
            console.log(colorizeDiff(entry.diffText));
          } else if (entry.buildError) {
            console.log(`  (no se pudo construir el diff: ${entry.buildError})`);
          }
          console.log('');
        }

        const counts = { valid: 0, warning: 0, reject: 0 };
        for (const e of result.entries) counts[e.validationStatus] += 1;
        console.log(`Resumen: ${counts.valid} valid, ${counts.warning} warning, ${counts.reject} reject.`);
        console.log(
          'Nada se aplicó — `devpilot apply` (próxima pieza del roadmap) aplicará los `valid`/`warning` ya resueltos.',
        );
      } catch (err) {
        console.error(`Error al generar el diff: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
}
