import path from 'node:path';
import type { TaskBenchmarkRow } from '@devpilot/storage';
import { findProjectByRootPath, listTaskBenchmarks, openGlobalRegistryDb, openProjectDb } from '@devpilot/storage';

// `devpilot benchmark` (07, cierre del Incremento 1): la vista de lectura
// sobre `task_benchmarks` — el "¿de verdad funciona la hipótesis central?"
// con números en vez de intuición (04). No calcula nada nuevo: cada fila ya
// viene precalculada por contextService.ts/importService.ts/applyService.ts
// en el momento correspondiente; acá solo se lee y se arma un resumen
// agregado sobre las tareas que ya tienen datos suficientes.

export const DEFAULT_BENCHMARK_LIMIT = 20;

export interface BenchmarkSummary {
  totalTasks: number;
  /** Tareas con `filesIncluded > 0` y `filesUsed` ya calculado (después de `devpilot apply`) — las únicas donde tiene sentido promediar la proporción de archivos usados. */
  tasksWithFileData: number;
  /** Promedio de `filesUsed / filesIncluded` sobre esas tareas, 0-1. `null` si ninguna tarea tiene datos todavía. */
  avgFilesUsedRatio: number | null;
  /** Tareas con `changesImported > 0` — donde tiene sentido promediar cuántos cambios importados terminaron aplicados. */
  tasksWithChangeData: number;
  /** Promedio de `changesApplied / changesImported` sobre esas tareas, 0-1. `null` si ninguna tarea tiene datos todavía. */
  avgChangesAppliedRatio: number | null;
  outcomeCounts: Record<string, number>;
}

export interface BenchmarkListResult {
  rows: TaskBenchmarkRow[];
  summary: BenchmarkSummary;
}

function computeSummary(rows: TaskBenchmarkRow[]): BenchmarkSummary {
  const outcomeCounts: Record<string, number> = {};
  let filesRatioSum = 0;
  let tasksWithFileData = 0;
  let changesRatioSum = 0;
  let tasksWithChangeData = 0;

  for (const row of rows) {
    const outcome = row.outcome ?? 'desconocido';
    outcomeCounts[outcome] = (outcomeCounts[outcome] ?? 0) + 1;

    if (row.filesIncluded !== null && row.filesIncluded > 0 && row.filesUsed !== null) {
      filesRatioSum += row.filesUsed / row.filesIncluded;
      tasksWithFileData += 1;
    }
    if (row.changesImported !== null && row.changesImported > 0 && row.changesApplied !== null) {
      changesRatioSum += row.changesApplied / row.changesImported;
      tasksWithChangeData += 1;
    }
  }

  return {
    totalTasks: rows.length,
    tasksWithFileData,
    avgFilesUsedRatio: tasksWithFileData > 0 ? filesRatioSum / tasksWithFileData : null,
    tasksWithChangeData,
    avgChangesAppliedRatio: tasksWithChangeData > 0 ? changesRatioSum / tasksWithChangeData : null,
    outcomeCounts,
  };
}

export interface ListTaskBenchmarksParams {
  rawPath: string;
  limit?: number;
}

export async function listProjectTaskBenchmarks(params: ListTaskBenchmarksParams): Promise<BenchmarkListResult> {
  const rootPath = path.resolve(params.rawPath);

  const registryDb = openGlobalRegistryDb();
  let project;
  try {
    project = findProjectByRootPath(registryDb, rootPath);
  } finally {
    registryDb.close();
  }
  if (!project) {
    throw new Error(`Este proyecto no está registrado todavía. Corre \`devpilot project add ${params.rawPath}\` primero.`);
  }

  const projectDb = openProjectDb(rootPath);
  let rows: TaskBenchmarkRow[];
  try {
    rows = listTaskBenchmarks(projectDb, params.limit ?? DEFAULT_BENCHMARK_LIMIT);
  } finally {
    projectDb.close();
  }

  return { rows, summary: computeSummary(rows) };
}
