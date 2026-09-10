import type { Command } from 'commander';
import { DEFAULT_BENCHMARK_LIMIT, listProjectTaskBenchmarks } from '@devpilot/core';

const OUTCOME_LABEL: Record<string, string> = {
  success: '✅ success',
  partial: '🟡 partial',
  failed: '❌ failed',
  not_applied: '⚪ not_applied',
};

function fmtPercent(ratio: number | null): string {
  return ratio === null ? '—' : `${Math.round(ratio * 100)}%`;
}

function fmtNumber(n: number | null): string {
  return n === null ? '—' : String(n);
}

export function registerBenchmarkCommand(program: Command): void {
  program
    .command('benchmark')
    .description(
      'Muestra el benchmark automático por tarea (task_benchmarks, ver 03/04/07): tokens de contexto, archivos incluidos vs. usados, cambios importados vs. aplicados, y el resultado de cada tarea. Es el número real detrás de "DevPilot ahorra contexto", no una intuición.',
    )
    .option('--project <ruta>', 'Ruta del proyecto (por defecto, el directorio actual)', '.')
    .option('--limit <n>', `Cuántas tareas recientes mostrar (por defecto ${DEFAULT_BENCHMARK_LIMIT})`, String(DEFAULT_BENCHMARK_LIMIT))
    .action(async (options: { project: string; limit: string }) => {
      try {
        const limit = Number.parseInt(options.limit, 10);
        if (!Number.isFinite(limit) || limit <= 0) {
          console.error(`--limit "${options.limit}" no es un número válido mayor que 0.`);
          process.exitCode = 1;
          return;
        }

        const { rows, summary } = await listProjectTaskBenchmarks({ rawPath: options.project, limit });

        if (rows.length === 0) {
          console.log('Todavía no hay ninguna tarea con benchmark registrado — corre `devpilot context "<tarea>"` para generar la primera.');
          return;
        }

        for (const row of rows) {
          const outcomeLabel = OUTCOME_LABEL[row.outcome ?? ''] ?? row.outcome ?? '(sin resultado)';
          console.log(`${outcomeLabel} · ${row.taskText}`);
          console.log(`  Context Pack: ${row.contextPackId}`);
          console.log(
            `  tokens de contexto: ${fmtNumber(row.contextTokens)} · archivos incluidos: ${fmtNumber(row.filesIncluded)} · archivos usados: ${fmtNumber(row.filesUsed)} (${row.filesUsed !== null && row.filesIncluded ? fmtPercent(row.filesUsed / row.filesIncluded) : '—'}) · archivos de más: ${fmtNumber(row.filesUnnecessary)}`,
          );
          console.log(
            `  respuesta de la IA: ${fmtNumber(row.responseSizeChars)} caracteres · cambios importados: ${fmtNumber(row.changesImported)} · cambios aplicados: ${fmtNumber(row.changesApplied)} (${row.changesApplied !== null && row.changesImported ? fmtPercent(row.changesApplied / row.changesImported) : '—'})`,
          );
          console.log(`  generada: ${row.createdAt}`);
          console.log('');
        }

        console.log(`Resumen sobre ${summary.totalTasks} tarea(s) mostrada(s):`);
        console.log(
          `  archivos incluidos que sí se usaron: ${fmtPercent(summary.avgFilesUsedRatio)} en promedio (${summary.tasksWithFileData} tarea(s) con datos — el resto todavía no corrió \`devpilot apply\`)`,
        );
        console.log(
          `  cambios importados que terminaron aplicados: ${fmtPercent(summary.avgChangesAppliedRatio)} en promedio (${summary.tasksWithChangeData} tarea(s) con datos)`,
        );
        const outcomeSummary = Object.entries(summary.outcomeCounts)
          .map(([outcome, count]) => `${count} ${OUTCOME_LABEL[outcome] ?? outcome}`)
          .join(', ');
        console.log(`  resultados: ${outcomeSummary}`);
      } catch (err) {
        console.error(`Error al leer el benchmark: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
}
