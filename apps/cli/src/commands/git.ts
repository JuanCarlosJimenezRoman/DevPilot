import type { Command } from 'commander';
import { openGitAdapter } from '@devpilot/core';

// `devpilot git status|log|diff` (07, Incremento 3): consumidor directo de
// GitAdapter, igual que cada pieza anterior del roadmap expone su
// servicio nuevo como comando de CLI probable a mano. Mismo bug de
// Commander documentado en decide.ts/session.ts/knowledge.ts: `--project`
// se declara UNA sola vez en el comando padre (`git`), ningún subcomando
// lo redeclara -- cada uno lo lee vía `cmd.parent.opts()`.

function formatDate(iso: string): string {
  if (!iso) return '(fecha desconocida)';
  return iso.slice(0, 19).replace('T', ' ');
}

export function registerGitCommand(program: Command): void {
  const git = program
    .command('git')
    .description('Inspección de Git (GitAdapter, 02/07): status, log y diff — no requiere `devpilot project add` primero.')
    .option('--project <ruta>', 'Ruta del proyecto (por defecto, el directorio actual)', '.');

  git
    .command('status')
    .description('Muestra el estado del repositorio: rama, cambios stageados, sin stagear y sin trackear.')
    .action(async (_options: unknown, cmd: Command) => {
      const project = (cmd.parent?.opts().project as string | undefined) ?? '.';
      try {
        const { git: adapter } = openGitAdapter(project);
        if (!(await adapter.isRepo())) {
          console.log('Esta carpeta no es un repositorio git.');
          return;
        }
        const status = await adapter.status();
        console.log(`Rama: ${status.branch ?? '(detached / sin rama)'}`);
        if (status.clean) {
          console.log('Árbol de trabajo limpio — sin cambios sin commitear.');
          return;
        }
        if (status.staged.length > 0) {
          console.log(`Stageado (${status.staged.length}):`);
          for (const entry of status.staged) console.log(`  ${entry.code}  ${entry.path}`);
        }
        if (status.unstaged.length > 0) {
          console.log(`Sin stagear (${status.unstaged.length}):`);
          for (const entry of status.unstaged) console.log(`  ${entry.code}  ${entry.path}`);
        }
        if (status.untracked.length > 0) {
          console.log(`Sin trackear (${status.untracked.length}):`);
          for (const p of status.untracked) console.log(`  ??  ${p}`);
        }
      } catch (err) {
        console.error(`Error al leer el estado de git: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });

  git
    .command('log')
    .description('Muestra los commits más recientes (hash, autor, fecha, mensaje, archivos tocados).')
    .option('--limit <n>', 'Cuántos commits mostrar', '20')
    .option('--since <fecha>', 'Solo commits desde esta fecha (cualquier formato que entienda `git log --since`)')
    .action(async (options: { limit: string; since?: string }, cmd: Command) => {
      const project = (cmd.parent?.opts().project as string | undefined) ?? '.';
      try {
        const { git: adapter } = openGitAdapter(project);
        if (!(await adapter.isRepo())) {
          console.log('Esta carpeta no es un repositorio git.');
          return;
        }
        const commits = await adapter.log({
          limit: Number.parseInt(options.limit, 10) || undefined,
          since: options.since,
        });
        if (commits.length === 0) {
          console.log('Sin commits (repo sin historial todavía, o sin resultados para ese filtro).');
          return;
        }
        for (const commit of commits) {
          console.log(`${commit.hash.slice(0, 7)}  ${formatDate(commit.date)}  ${commit.authorName}`);
          console.log(`  ${commit.message}`);
          if (commit.filesChanged.length > 0) {
            console.log(`  archivos: ${commit.filesChanged.join(', ')}`);
          }
        }
      } catch (err) {
        console.error(`Error al leer el log de git: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });

  git
    .command('diff [rutas...]')
    .description('Muestra el diff unificado (working tree sin commitear contra HEAD por defecto; usa --from/--to para comparar refs).')
    .option('--from <ref>', 'Ref de origen')
    .option('--to <ref>', 'Ref de destino')
    .action(async (rutas: string[], options: { from?: string; to?: string }, cmd: Command) => {
      const project = (cmd.parent?.opts().project as string | undefined) ?? '.';
      try {
        const { git: adapter } = openGitAdapter(project);
        if (!(await adapter.isRepo())) {
          console.log('Esta carpeta no es un repositorio git.');
          return;
        }
        const diff = await adapter.diff({ from: options.from, to: options.to, paths: rutas });
        if (diff.files.length === 0) {
          console.log('Sin diferencias.');
          return;
        }
        for (const file of diff.files) {
          console.log(file.patch);
          console.log('');
        }
      } catch (err) {
        console.error(`Error al calcular el diff de git: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
}
