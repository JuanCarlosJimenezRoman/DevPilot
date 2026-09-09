import type { Command } from 'commander';
import { addProject, listProjects } from '@devpilot/core';

function formatValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return '(no detectado)';
  return String(value);
}

export function registerProjectCommand(program: Command): void {
  const project = program.command('project').description('Gestión de proyectos registrados en DevPilot.');

  project
    .command('add <ruta>')
    .description('Escanea una carpeta y la registra (o actualiza) como proyecto de DevPilot.')
    .action(async (ruta: string) => {
      try {
        const { project: p, snapshot, state } = await addProject(ruta);
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
