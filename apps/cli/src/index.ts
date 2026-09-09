#!/usr/bin/env node
import { Command } from 'commander';
import { describeCore } from '@devpilot/core';

const program = new Command();

program
  .name('devpilot')
  .description('DevPilot — capa local de contexto, memoria y herramientas para proyectos de software.')
  .version('0.0.1', '-v, --version', 'muestra la versión de DevPilot');

// Los comandos reales del Incremento 1 (project add, context, import, diff,
// apply, decide — ver docs/architecture/07-roadmap.md) se agregan en
// apps/cli/src/commands/. Este incremento (0) solo demuestra que el CLI
// compila, resuelve @devpilot/core a través del workspace de pnpm, y
// responde correctamente a `devpilot --version`.
program
  .command('doctor')
  .description('Diagnóstico del entorno de desarrollo (Incremento 0): confirma que el monorepo está bien enlazado.')
  .action(() => {
    console.log(describeCore());
    console.log(`Node.js: ${process.version}`);
  });

program.parse(process.argv);
