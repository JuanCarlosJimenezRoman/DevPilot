import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '@devpilot/shared';

// ClaudeCodeProvider — Incremento 4 ("Claude Code", ver 07). Primer y único
// consumidor real de `packages/core/src/providers/` (README.md decía desde
// el Incremento 0 "ClaudeCodeProvider llega en el Incremento 4" — sin
// código hasta ahora).
//
// 06 documenta una interfaz `AIProvider` completa y genérica (`execute()`
// devolviendo `AsyncIterable<AIEvent>` con streaming/tool-calls, pensada
// para eventualmente soportar cualquier provider incluido uno interactivo
// con la propia UI de DevPilot). v1 de esta pieza NO implementa esa
// interfaz completa a propósito — mismo criterio ya aplicado en
// `gitAdapter.ts` (omite `commit()`) y `permissionGuard.ts` (`RiskLevel`
// angosto): el único consumidor real hoy es `devpilot analyze --deep`
// (deepAnalysisService.ts), que necesita una sola llamada no interactiva
// que devuelva el texto final de la respuesta — no streaming de deltas de
// texto, no eventos de tool-call intermedios (Claude Code corre sus
// propias herramientas puertas adentro del subprocess, en modo
// `--permission-mode plan`; DevPilot no necesita verlas, solo el resultado
// final). Wirear la interfaz completa de 06 sin un consumidor real que la
// necesite violaría ese mismo principio que ya sigue el resto del código.
// Si en el futuro aparece un consumidor que sí necesite streaming/tool
// events (ej. un modo interactivo), se amplía entonces.

const logger = createLogger('core:claude-code-provider');

const execFileAsync = promisify(execFile);

export interface ProviderCapabilities {
  streaming: boolean;
  toolCalling: boolean;
  requiresApiKey: boolean;
  costModel: 'none' | 'session-plan' | 'metered-api';
  supportsSessions: boolean;
  supportsCancellation: boolean;
}

export interface ClaudeCodeAvailability {
  available: boolean;
  /** Motivo legible cuando `available` es `false` (binario no encontrado, o el subprocess ni siquiera pudo arrancar). */
  reason?: string;
  /** Lo que imprimió `claude --version` (o el error crudo), para diagnóstico — nunca se usa para decidir `available`, ver el comentario de `isAvailable()`. */
  detail?: string;
}

export interface RunAnalysisResult {
  ok: true;
  /** Texto final de la respuesta de Claude Code — ya extraído del sobre `--output-format json` (ver `extractResultText`). */
  text: string;
}

export interface RunAnalysisError {
  ok: false;
  /** Mensaje legible y específico — nunca una excepción sin capturar (06: "fallar de forma explícita y legible, no silenciosa"). */
  message: string;
  /** 'not-available' (binario no encontrado), 'rejected' (el binario corrió pero devolvió error/exit code != 0 — ej. flags no soportados, sesión no iniciada), 'timeout', 'unparsable-output' (el JSON de salida no tiene la forma esperada — ver nota de robustez en 06 sobre flags que pueden cambiar entre versiones). */
  kind: 'not-available' | 'rejected' | 'timeout' | 'unparsable-output';
  /** stdout/stderr crudo, cuando lo hay — para que el CLI pueda mostrarlo si el usuario quiere el detalle completo. */
  raw?: string;
}

export type RunAnalysisOutcome = RunAnalysisResult | RunAnalysisError;

export interface ClaudeCodeProvider {
  id: 'claude-code';
  displayName: string;
  capabilities: ProviderCapabilities;
  /**
   * Feature-detection (06: "¿está instalado?"). Deliberadamente NO valida
   * flags ni formato de salida acá — un hallazgo real de esta pieza (ver
   * `07-roadmap.md`, Incremento 4): en al menos un entorno real, el
   * binario `claude` existe y arranca perfectamente (el subprocess no
   * falla con ENOENT) pero rechaza `--version` igual que rechazaría
   * cualquier otro flag no soportado en ese entorno puntual — si
   * `isAvailable()` interpretara ese rechazo como "no instalado", daría un
   * falso negativo. La única pregunta que puede responderse con
   * confianza sin invocar la operación real es "¿el proceso arranca?"
   * (ENOENT vs. cualquier otra cosa) — la pregunta de "¿y funciona con
   * los flags que necesito?" se responde recién al correr
   * `runDeepAnalysis()`, que sí falla explícito y legible si el formato
   * de salida no es el esperado (ver `RunAnalysisError`).
   */
  isAvailable(): Promise<ClaudeCodeAvailability>;
  /**
   * Invoca `claude -p "<prompt>"` en modo no interactivo, con
   * `--permission-mode plan` (solo lectura/plan — Claude Code puede leer y
   * explorar el proyecto con sus propias herramientas, pero no editar
   * archivos directamente, ver 06) y `--output-format json` para obtener
   * el resultado final de forma parseable. `cwd` es el root del proyecto
   * a analizar — así Claude Code explora el código real sin que DevPilot
   * tenga que armarle un Context Pack completo del proyecto entero.
   */
  runDeepAnalysis(prompt: string, opts: { cwd: string; timeoutMs?: number }): Promise<RunAnalysisOutcome>;
}

const DEFAULT_AVAILABILITY_TIMEOUT_MS = 8_000;
const DEFAULT_ANALYSIS_TIMEOUT_MS = 10 * 60 * 1_000; // un análisis profundo real puede tardar minutos
const MAX_OUTPUT_BYTES = 20 * 1024 * 1024; // mismo límite que GitAdapter (gitAdapter.ts) para no cortar salidas grandes

/**
 * El CLI real de Claude Code, en modo `-p --output-format json`, envuelve
 * la respuesta final en un objeto con (al menos) un campo `result` de tipo
 * string (ver docs/architecture/06-providers-and-browser-bridge.md, nota
 * de robustez). Se acepta cualquier objeto JSON que tenga ese campo como
 * string — nunca se asume el resto de la forma exacta, para no romper si
 * una versión futura agrega/renombra otros campos (cost, session_id,
 * etc.) que a DevPilot no le importan.
 */
function extractResultText(stdout: string): { text: string } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    return { error: `La salida de \`claude\` no es JSON válido: ${(err as Error).message}` };
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('result' in parsed) ||
    typeof (parsed as { result: unknown }).result !== 'string'
  ) {
    return {
      error:
        'La salida de `claude --output-format json` no tiene el campo `result` (string) esperado — es posible que la versión instalada de Claude Code haya cambiado el formato de salida (ver nota de robustez en 06).',
    };
  }
  return { text: (parsed as { result: string }).result };
}

/** Fábrica del provider — sin estado, cada llamada arma sus propios argumentos de subprocess. */
export function createClaudeCodeProvider(): ClaudeCodeProvider {
  return {
    id: 'claude-code',
    displayName: 'Claude Code',
    capabilities: {
      streaming: false,
      toolCalling: true,
      requiresApiKey: false,
      // 06/01: "no es gratis ni ilimitado" — usa la sesión/suscripción
      // existente del usuario, sujeta a los límites de uso de su plan.
      // Nunca se presenta como "IA gratis".
      costModel: 'session-plan',
      supportsSessions: false,
      supportsCancellation: false,
    },

    async isAvailable(): Promise<ClaudeCodeAvailability> {
      try {
        const { stdout, stderr } = await execFileAsync('claude', ['--version'], {
          timeout: DEFAULT_AVAILABILITY_TIMEOUT_MS,
          encoding: 'utf8',
        });
        return { available: true, detail: (stdout || stderr || '').trim() };
      } catch (err) {
        const nodeErr = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
        if (nodeErr.code === 'ENOENT') {
          return {
            available: false,
            reason: 'El binario `claude` no está instalado (o no está en el PATH de este shell).',
          };
        }
        // El proceso SÍ arrancó (no fue ENOENT) pero devolvió error o exit
        // code != 0 — ej. el hallazgo real documentado en 07-roadmap.md: un
        // entorno donde `claude --version` está deliberadamente
        // restringido devuelve un mensaje de error propio en vez de una
        // versión, sin que eso signifique que el binario no exista o que
        // `claude -p` (lo que realmente usa `runDeepAnalysis`) vaya a
        // fallar igual. Se reporta disponible, con el detalle crudo para
        // diagnóstico.
        const detail = [nodeErr.stdout, nodeErr.stderr, nodeErr.message].filter(Boolean).join(' | ').trim();
        return { available: true, detail: detail || undefined };
      }
    },

    async runDeepAnalysis(prompt: string, opts: { cwd: string; timeoutMs?: number }): Promise<RunAnalysisOutcome> {
      try {
        const { stdout } = await execFileAsync(
          'claude',
          ['-p', prompt, '--output-format', 'json', '--permission-mode', 'plan'],
          {
            cwd: opts.cwd,
            timeout: opts.timeoutMs ?? DEFAULT_ANALYSIS_TIMEOUT_MS,
            maxBuffer: MAX_OUTPUT_BYTES,
            encoding: 'utf8',
          },
        );
        const extracted = extractResultText(stdout);
        if ('error' in extracted) {
          logger.debug('salida de claude no reconocida:', stdout.slice(0, 500));
          return { ok: false, kind: 'unparsable-output', message: extracted.error, raw: stdout };
        }
        return { ok: true, text: extracted.text };
      } catch (err) {
        const nodeErr = err as NodeJS.ErrnoException & {
          killed?: boolean;
          signal?: string;
          stdout?: string;
          stderr?: string;
          code?: number | string;
        };

        if (nodeErr.code === 'ENOENT') {
          return {
            ok: false,
            kind: 'not-available',
            message: 'El binario `claude` no está instalado (o no está en el PATH de este shell).',
          };
        }
        if (nodeErr.killed || nodeErr.signal === 'SIGTERM') {
          return {
            ok: false,
            kind: 'timeout',
            message: `Claude Code no terminó dentro del tiempo límite (${((opts.timeoutMs ?? DEFAULT_ANALYSIS_TIMEOUT_MS) / 1000).toFixed(0)}s).`,
          };
        }

        // Exit code != 0 con el binario sí instalado: se muestra el
        // stderr/stdout crudo tal cual, nunca se intenta adivinar qué
        // pasó — ej. flags no soportados por esa versión de Claude Code,
        // sesión no iniciada, permission-mode desconocido. Ver nota de
        // robustez de 06: "fallar de forma explícita y legible... en vez
        // de asumir compatibilidad ciega".
        const raw = [nodeErr.stdout, nodeErr.stderr].filter(Boolean).join('\n').trim();
        return {
          ok: false,
          kind: 'rejected',
          message: `\`claude\` devolvió un error (código ${String(nodeErr.code ?? '?')}): ${raw || nodeErr.message}`,
          raw: raw || undefined,
        };
      }
    },
  };
}
