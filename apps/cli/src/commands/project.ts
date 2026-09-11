import type { Command } from 'commander';
import { addProject, listProjects, type ReindexResult } from '@devpilot/core';

function formatValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return '(no detectado)';
  return String(value);
}

// Refresco incremental de Project State (07): resume en una línea qué
// hizo el Indexer, para que el ahorro de trabajo (o su ausencia, en
// proyectos sin git) sea visible y no un detalle interno invisible.
function formatReindexSummary(reindex: ReindexResult): string {
  switch (reindex.mode) {
    case 'skipped':
      return `sin cambios desde el último escaneo (commit ${formatValue(reindex.currentCommit)} igual al indexado) — se saltó el reindexado, ${reindex.totalIndexed} archivo(s) en el índice`;
    case 'incremental':
      return `reindexado incremental vía \`git diff\` — ${reindex.filesAdded} nuevo(s), ${reindex.filesUpdated} actualizado(s), ${reindex.filesRemoved} eliminado(s) (${reindex.totalIndexed} en total)`;
    case 'full':
      return `reindexado completo — ${reindex.totalIndexed} archivo(s) indexado(s) (${reindex.filesAdded} nuevo(s), ${reindex.filesUpdated} ya existían)`;
    default:
      return reindex.mode;
  }
}

export function registerProjectCommand(program: Command): void {
  const project = program.command('project').description('Gestión de proyectos registrados en DevPilot.');

  project
    .command('add <ruta>')
    .description('Escanea una carpeta y la registra (o actualiza) como proyecto de DevPilot.')
    .action(async (ruta: string) => {
      try {
        const { project: p, snapshot, state, reindex } = await addProject(ruta);
        console.log(`Proyecto: ${p.name} (${p.id})`);
        console.log(`  Ruta:             ${p.rootPath}`);
        console.log(`  VCS:              ${p.vcs}`);
        console.log(`  Lenguaje(s):      ${formatValue(snapshot.language.join(', '))}`);
        console.log(`  Framework:        ${formatValue(snapshot.framework)}`);
        console.log(`  Package manager:  ${formatValue(snapshot.packageManager)}`);
        console.log(`  ORM:              ${formatValue(snapshot.orm)}`);
        console.log(`  Base de datos:    ${formatValue(snapshot.database)}`);
        console.log(`  Docker:           ${snapshot.hasDocker ? 'sí' : 'no'}`);
        console.log(`  Archivos:         ${snapshot.fileCount}`);
        console.log(`  Commit actual:    ${formatValue(snapshot.gitCommit)}`);
        console.log(`  Snapshot versión: ${state.snapshotVersion}`);
        console.log(`  Snapshot guardado en: ${state.snapshotPath}`);
        console.log(`  Índice de archivos: ${formatReindexSummary(reindex)}`);
      } catch (err) {
        console.error(`Error al registrar el proyecto: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });

  project
    .command('list')
    .description('Lista los proyectos registrados en el catálogo global (~/.devpilot/registry.db).')
    .action(() => {
      const projects = listProjects();
      if (projects.length === 0) {
        console.log('No hay proyectos registrados todavía. Usa `devpilot project add <ruta>`.');
        return;
      }
      for (const p of projects) {
        console.log(`${p.id}  ${p.name}  (${p.rootPath})`);
      }
    });
}
