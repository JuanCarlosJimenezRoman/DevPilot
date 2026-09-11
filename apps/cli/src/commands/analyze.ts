import type { Command } from 'commander';
import { applyDecisionEntry, applyKnowledgeEntry, logDeepAnalysisEvent, markDeepAnalysisCommit, runDeepAnalysis } from '@devpilot/core';
import { createConfirmer } from './shared/confirmer.js';

// `devpilot analyze --deep` — Incremento 4 ("Claude Code", ver 07):
// ClaudeCodeProvider en modo solo lectura/plan propone contenido para
// Project Knowledge (y decisiones detectadas); cada propuesta se muestra
// como diff y se aprueba individualmente antes de escribir — mismo flujo
// de aprobación del Tool Engine que ya usa `devpilot apply` (ver
// applyService.ts/permissionGuard.ts, 05). Un solo comando de punta a
// punta (ver el comentario de cabecera de deepAnalysisService.ts para por
// qué, a diferencia de `import`+`apply`, esta pieza no se separa en dos
// comandos).

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

const SKIP_LABEL: Record<string, string> = {
  'skipped-manual': 'este tipo tiene un doc editado a mano — nunca se sobreescribe (ver 04)',
  'skipped-unchanged': 'el contenido propuesto es idéntico al actual',
  'skipped-invalid': 'propuesta inválida, no se puede aplicar',
};

export function registerAnalyzeCommand(program: Command): void {
  program
    .command('analyze')
    .description('Análisis profundo del proyecto vía Claude Code (Incremento 4, ver 07). Por ahora solo soporta `--deep`.')
    .option('--project <ruta>', 'Ruta del proyecto (por defecto, el directorio actual)', '.')
    .option('--deep', 'Corre `analyze --deep`: invoca Claude Code en modo solo lectura/plan para proponer Project Knowledge y decisiones detectadas.', false)
    .option(
      '--yes-to <riesgo>',
      'Pre-aprueba visualmente las escrituras de knowledge docs/decisiones sin preguntar una por una. Solo se acepta "write" (nunca hay operaciones `delete` en este comando).',
    )
    .action(async (options: { project: string; deep: boolean; yesTo?: string }) => {
      if (!options.deep) {
        console.error('`devpilot analyze` todavía solo soporta `--deep` (ver docs/architecture/07-roadmap.md, Incremento 4).');
        process.exitCode = 1;
        return;
      }
      if (options.yesTo && options.yesTo !== 'write') {
        console.error(
          `--yes-to "${options.yesTo}" no es válido. Solo "write" puede pre-aprobarse (ver docs/architecture/05-tool-engine-and-security.md).`,
        );
        process.exitCode = 1;
        return;
      }
      const preApproveWrite = options.yesTo === 'write';
      const confirmer = createConfirmer();

      try {
        console.log('Invocando a Claude Code en modo de solo lectura/plan — esto puede tardar varios minutos en un proyecto real...');
        console.log('');

        const outcome = await runDeepAnalysis(options.project);

        if (!outcome.ok) {
          console.error(`No se pudo completar el análisis profundo: ${outcome.message}`);
          if (outcome.raw) {
            console.error('');
            console.error('Salida cruda de `claude`:');
            console.error(outcome.raw);
          }
          process.exitCode = 1;
          return;
        }

        console.log(`Commit actual: ${outcome.currentCommit ?? '(proyecto sin git, o sin commits todavía)'}`);
        console.log(
          outcome.previousDeepAnalysisCommit
            ? `Análisis profundo anterior: ${outcome.previousDeepAnalysisCommit}`
            : 'Este es el primer análisis profundo de este proyecto.',
        );
        console.log('');

        const results = { knowledgeApplied: 0, knowledgeRejected: 0, knowledgeErrors: 0, knowledgeSkipped: 0, decisionsApplied: 0, decisionsRejected: 0 };

        if (outcome.knowledgeEntries.length === 0) {
          console.log('Claude Code no propuso ningún knowledge doc.');
        }
        for (const entry of outcome.knowledgeEntries) {
          if (entry.eligibility !== 'eligible') {
            console.log(`⏭  [${entry.type}] ${entry.title} — ${SKIP_LABEL[entry.eligibility] ?? entry.eligibility}${entry.skipReason ? `: ${entry.skipReason}` : ''}`);
            results.knowledgeSkipped += 1;
            continue;
          }

          console.log(`📄 Knowledge doc propuesto: [${entry.type}] ${entry.title} (id: ${entry.id})`);
          if (entry.diffText) {
            console.log('');
            console.log(colorizeDiff(entry.diffText));
            console.log('');
          }

          const autoApprove = preApproveWrite;
          const approved = autoApprove ? true : await confirmer.confirm(`¿Escribir .devpilot/knowledge/${entry.id}.md?`);
          if (autoApprove) console.log('  (pre-aprobado por --yes-to write)');

          const applied = await applyKnowledgeEntry(outcome.rootPath, entry, approved);
          if (!applied.approved) {
            console.log(`  ✗ ${applied.resultSummary}`);
            results.knowledgeRejected += 1;
          } else if (!applied.ok) {
            console.log(`  ✗ ${applied.resultSummary}`);
            results.knowledgeErrors += 1;
          } else {
            console.log(`  ✓ ${applied.resultSummary}`);
            results.knowledgeApplied += 1;
          }
          console.log('');
        }

        if (outcome.decisionEntries.length === 0) {
          console.log('Claude Code no detectó ninguna decisión nueva.');
        }
        for (const entry of outcome.decisionEntries) {
          console.log(`🧭 Decisión detectada: "${entry.proposal.title}"`);
          console.log(`   Contexto: ${entry.proposal.context}`);
          console.log(`   Decisión: ${entry.proposal.decision}`);
          if (entry.proposal.consequences) console.log(`   Consecuencias: ${entry.proposal.consequences}`);

          const autoApprove = preApproveWrite;
          const approved = autoApprove ? true : await confirmer.confirm('¿Crear esta Decision Record?');
          if (autoApprove) console.log('  (pre-aprobado por --yes-to write)');

          if (!approved) {
            console.log('  ✗ rechazada por el usuario');
            results.decisionsRejected += 1;
            console.log('');
            continue;
          }
          const decision = await applyDecisionEntry(outcome.rootPath, entry);
          console.log(`  ✓ creada (id: ${decision.id})`);
          results.decisionsApplied += 1;
          console.log('');
        }

        if (outcome.unparsedNotes.length > 0) {
          console.log('--- Notas de Claude Code fuera de cualquier bloque reconocido (no se guardan como conocimiento, se muestran igual) ---');
          console.log(outcome.unparsedNotes);
          console.log('');
        }

        console.log(
          `Resumen — Knowledge: ${results.knowledgeApplied} aplicados, ${results.knowledgeRejected} rechazados, ${results.knowledgeErrors} con error, ${results.knowledgeSkipped} saltados. Decisiones: ${results.decisionsApplied} creadas, ${results.decisionsRejected} rechazadas.`,
        );

        // `lastDeepAnalysisCommit` se actualiza siempre que Claude Code
        // respondió de verdad (outcome.ok), sin importar cuántas
        // propuestas se aprobaron — ver el comentario de
        // `markDeepAnalysisCommit` en deepAnalysisService.ts.
        await markDeepAnalysisCommit(outcome.rootPath, outcome.projectId, outcome.currentCommit);
        await logDeepAnalysisEvent(outcome.rootPath, {
          knowledgeApplied: results.knowledgeApplied,
          decisionsApplied: results.decisionsApplied,
          unparsedNotesLength: outcome.unparsedNotes.length,
        });
      } catch (err) {
        console.error(`Error al analizar: ${(err as Error).message}`);
        process.exitCode = 1;
      } finally {
        confirmer.close();
      }
    });
}
