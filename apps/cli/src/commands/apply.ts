import type { Command } from 'commander';
import { applyChange, buildApplyPlan, recordApplyBenchmark } from '@devpilot/core';
import { createConfirmer } from './shared/confirmer.js';

const STATUS_LABEL: Record<string, string> = {
  valid: '✅ valid',
  warning: '⚠️  warning',
  reject: '❌ reject',
};

const SKIP_LABEL: Record<string, string> = {
  'skipped-reject': 'rechazado por el validador — no se ofrece (ver `devpilot diff` para el detalle)',
  'skipped-already-applied': 'ya se aplicó antes',
  'skipped-warning-not-included': 'es `warning` — pasa `--include-warnings` (o `--only <id>`) para incluirlo explícitamente',
  'skipped-not-selected': 'no es la propuesta indicada con `--only`',
};

function colorizeDiff(diffText: string): string {
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

export function registerApplyCommand(program: Command): void {
  program
    .command('apply')
    .description(
      'Aplica de verdad al disco los cambios `valid` (y, si se pide explícitamente, `warning`) ya importados — con confirmación por cada uno (Tool Engine, ver 05). `reject` nunca se ofrece.',
    )
    .option('--project <ruta>', 'Ruta del proyecto (por defecto, el directorio actual)', '.')
    .option('--context-pack <id>', 'Id del Context Pack cuyas propuestas aplicar (por defecto, el más reciente)')
    .option('--include-warnings', 'Incluye también los cambios `warning` (el usuario ya los revisó con `devpilot diff`)', false)
    .option('--only <id>', 'Aplica exactamente esta propuesta por id (ignora --include-warnings; sigue bloqueando `reject`)')
    .option(
      '--yes-to <riesgo>',
      'Pre-aprueba visualmente las operaciones de este nivel de riesgo sin preguntar una por una. Solo se acepta "write" — `delete` nunca es bypassable (ver 05).',
    )
    .action(
      async (options: {
        project: string;
        contextPack?: string;
        includeWarnings: boolean;
        only?: string;
        yesTo?: string;
      }) => {
        if (options.yesTo && options.yesTo !== 'write') {
          console.error(
            `--yes-to "${options.yesTo}" no es válido. Solo "write" puede pre-aprobarse; "delete" nunca es bypassable (ver docs/architecture/05-tool-engine-and-security.md).`,
          );
          process.exitCode = 1;
          return;
        }
        const preApproveWrite = options.yesTo === 'write';
        const confirmer = createConfirmer();

        try {
          const plan = await buildApplyPlan({
            rawPath: options.project,
            contextPackId: options.contextPack,
            includeWarnings: options.includeWarnings,
            onlyProposalId: options.only,
          });

          console.log(`Context Pack: ${plan.contextPackId}`);
          console.log('');

          const results = { applied: 0, rejectedByUser: 0, errores: 0, saltados: 0 };

          for (const entry of plan.entries) {
            if (entry.eligibility !== 'eligible') {
              console.log(`⏭  ${entry.filePath} — ${SKIP_LABEL[entry.eligibility] ?? entry.eligibility}`);
              results.saltados += 1;
              continue;
            }

            console.log(
              `${STATUS_LABEL[entry.validationStatus] ?? entry.validationStatus} · ${entry.filePath} · herramienta: ${entry.toolName} · riesgo: ${entry.riskLevel}`,
            );

            if (entry.buildError) {
              console.log(`  No se pudo preparar este cambio: ${entry.buildError}`);
              console.log('');
              results.errores += 1;
              continue;
            }

            if (entry.pathGuardReason) {
              console.log(`  ⚠ PathGuard: ${entry.pathGuardReason}`);
            }
            if (entry.diffText) {
              console.log('');
              console.log(colorizeDiff(entry.diffText));
              console.log('');
            }

            const riskLabel = entry.riskLevel === 'delete' ? 'BORRAR este archivo' : `escribir en ${entry.filePath}`;
            const autoApprove = entry.riskLevel === 'write' && preApproveWrite;
            const approved = autoApprove ? true : await confirmer.confirm(`¿Aplicar (${riskLabel})?`);

            if (autoApprove) {
              console.log('  (pre-aprobado por --yes-to write)');
            }

            const outcome = await applyChange(plan.rootPath, entry, approved);
            if (!outcome.approved) {
              console.log(`  ✗ ${outcome.resultSummary}`);
              results.rejectedByUser += 1;
            } else if (!outcome.ok) {
              console.log(`  ✗ ${outcome.resultSummary}`);
              results.errores += 1;
            } else {
              console.log(`  ✓ ${outcome.resultSummary}`);
              results.applied += 1;
            }
            console.log('');
          }

          console.log(
            `Resumen: ${results.applied} aplicados, ${results.rejectedByUser} rechazados por el usuario, ${results.errores} con error, ${results.saltados} saltados.`,
          );

          // Benchmark automático por tarea (03/04, ver 07) — se actualiza al
          // final de cada corrida, tenga o no cambios elegibles (si todo se
          // saltó, igual queda constancia de que se corrió `apply`).
          await recordApplyBenchmark(plan.rootPath, plan.contextPackId, {
            erroresEnEstaCorrida: results.errores,
          });
        } catch (err) {
          console.error(`Error al aplicar: ${(err as Error).message}`);
          process.exitCode = 1;
        } finally {
          confirmer.close();
        }
      },
    );
}
