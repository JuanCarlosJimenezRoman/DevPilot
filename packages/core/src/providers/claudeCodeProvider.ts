import { createLogger } from '@devpilot/shared';
import spawn from 'cross-spawn';

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
 * Documentación original (06): el CLI de Claude Code, en modo `-p
 * --output-format json`, envuelve la respuesta final en un objeto con (al
 * menos) un campo `result` de tipo string. Si el stdout es JSON válido y
 * trae ese campo, se usa tal cual — nunca se asume el resto de la forma
 * exacta, para no romper si una versión futura agrega/renombra otros
 * campos (cost, session_id, etc.) que a DevPilot no le importan.
 *
 * Hallazgo real (sesión 9, ver 07-roadmap.md — primera corrida contra un
 * binario `claude` real y sin restricciones, v2.1.269 en Windows):
 * `--permission-mode plan` combinado con `--output-format json` NO
 * envuelve la respuesta en ese sobre — el modo plan imprime el texto
 * final directo a stdout, texto plano, sin importar `--output-format`. La
 * nota de robustez original ya anticipaba que el formato de salida podía
 * cambiar entre versiones; confirmado esto con una corrida real, la
 * respuesta correcta no es tratarlo como error — es usar el stdout crudo
 * tal cual como texto final. El resto del pipeline
 * (`deepAnalysisParser.ts`) ya es tolerante y extrae los bloques
 * `<DEVPILOT_KNOWLEDGE>`/`<DEVPILOT_DECISION>` de texto plano sin
 * depender de ningún sobre JSON — validado con una propuesta real
 * completa devuelta por este mismo binario.
 *
 * Solo se reporta error (`unparsable-output`) cuando no hay absolutamente
 * nada que parsear (stdout vacío) — ahí sí no hay texto útil que pasarle
 * al parser tolerante.
 */
function extractResultText(stdout: string): { text: string } | { error: string } {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return { error: 'La salida de `claude` está vacía.' };
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'result' in parsed &&
      typeof (parsed as { result: unknown }).result === 'string'
    ) {
      return { text: (parsed as { result: string }).result };
    }
    // JSON válido pero sin el campo `result` esperado — no se descarta,
    // cae al mismo fallback que la salida no-JSON: se usa el texto crudo.
  } catch {
    // no era JSON — cae al fallback de abajo.
  }
  return { text: trimmed };
}

interface ClaudeInvocationResult {
  /** Código de salida del proceso, o `null` si nunca llegó a terminar normalmente (timeout/señal). */
  status: number | null;
  /** Señal que terminó el proceso (ej. `SIGTERM` por timeout), o `null`. */
  signal: NodeJS.Signals | null;
  /** Error a nivel de spawn: binario no encontrado (ENOENT), timeout (ETIMEDOUT), etc. `undefined` si el proceso arrancó y terminó, sin importar el código de salida. */
  error?: NodeJS.ErrnoException;
  stdout: string;
  stderr: string;
}

/**
 * Invoca el binario `claude` usando `cross-spawn` en vez de
 * `node:child_process` directo.
 *
 * Hallazgo real (sesión 9, ver 07-roadmap.md — primera validación en
 * Windows real fuera de un sandbox restringido): `execFile('claude', ...)`
 * sin `shell: true` no puede arrancar el binario en Windows. `npm install
 * -g` ahí no deja un `.exe` suelto en el PATH — deja wrappers
 * `claude.cmd`/`claude.ps1` que a su vez invocan el binario real dentro de
 * `node_modules`, y `execFile`/`spawn` de Node sin shell no sabe ejecutar
 * archivos `.cmd` directamente (hace falta pasar por `cmd.exe`). El
 * síntoma es un `ENOENT` idéntico al de "no está instalado", aunque
 * `claude --version` funcione perfecto a mano en la misma terminal.
 * `cross-spawn` resuelve esto — y de paso cita cada argumento
 * correctamente para `cmd.exe`, algo que hacer a mano con `shell: true` es
 * fácil de hacer mal si el prompt trae comillas, espacios o caracteres
 * especiales del shell (`&`, `|`, `%`, `^`) — y en Mac/Linux se comporta
 * igual que `child_process.spawn` normal, sin cambiar nada ahí.
 *
 * Se usa la variante síncrona (`spawn.sync`) a propósito: DevPilot es un
 * CLI de un solo comando por invocación, no un servidor — no hay nada más
 * corriendo en el event loop mientras se espera a Claude Code, así que
 * bloquear acá es correcto y evita reimplementar a mano el buffering de
 * stdout/stderr y el manejo de timeout que antes daba gratis
 * `execFileAsync` (la variante async de `cross-spawn` no ofrece esa
 * superficie por sí sola; solo la sync matchea la de
 * `child_process.spawnSync`, con `timeout`/`maxBuffer`/`encoding`
 * incluidos).
 */
function invokeClaude(
  args: string[],
  opts: { cwd?: string; timeoutMs: number; maxBuffer: number },
): ClaudeInvocationResult {
  const result = spawn.sync('claude', args, {
    cwd: opts.cwd,
    timeout: opts.timeoutMs,
    maxBuffer: opts.maxBuffer,
    encoding: 'utf8',
  });
  return {
    status: result.status,
    signal: result.signal,
    error: result.error as NodeJS.ErrnoException | undefined,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function isEnoent(error: NodeJS.ErrnoException | undefined): boolean {
  return error?.code === 'ENOENT';
}

function isTimeout(result: ClaudeInvocationResult): boolean {
  return result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGTERM';
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
      const result = invokeClaude(['--version'], {
        timeoutMs: DEFAULT_AVAILABILITY_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
      });

      if (isEnoent(result.error)) {
        return {
          available: false,
          reason: 'El binario `claude` no está instalado (o no está en el PATH de este shell).',
        };
      }
      if (!result.error && result.status === 0) {
        return { available: true, detail: (result.stdout || result.stderr || '').trim() };
      }
      // El proceso SÍ arrancó (no fue ENOENT) pero devolvió error, exit
      // code != 0, o timeout — ej. el hallazgo real documentado en
      // 07-roadmap.md: un entorno donde `claude --version` está
      // deliberadamente restringido devuelve un mensaje de error propio en
      // vez de una versión, sin que eso signifique que el binario no
      // exista o que `claude -p` (lo que realmente usa
      // `runDeepAnalysis`) vaya a fallar igual. Se reporta disponible, con
      // el detalle crudo para diagnóstico.
      const detail = [result.stdout, result.stderr, result.error?.message].filter(Boolean).join(' | ').trim();
      return { available: true, detail: detail || undefined };
    },

    async runDeepAnalysis(prompt: string, opts: { cwd: string; timeoutMs?: number }): Promise<RunAnalysisOutcome> {
      const timeoutMs = opts.timeoutMs ?? DEFAULT_ANALYSIS_TIMEOUT_MS;
      const result = invokeClaude(['-p', prompt, '--output-format', 'json', '--permission-mode', 'plan'], {
        cwd: opts.cwd,
        timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
      });

      if (isEnoent(result.error)) {
        return {
          ok: false,
          kind: 'not-available',
          message: 'El binario `claude` no está instalado (o no está en el PATH de este shell).',
        };
      }
      if (isTimeout(result)) {
        return {
          ok: false,
          kind: 'timeout',
          message: `Claude Code no terminó dentro del tiempo límite (${(timeoutMs / 1000).toFixed(0)}s).`,
        };
      }
      if (result.error) {
        // Error de spawn no cubierto arriba (ej. EACCES, o el proceso
        // superó `maxBuffer`) — se muestra crudo, nunca se intenta
        // adivinar qué pasó (misma filosofía que el resto de esta
        // función).
        const raw = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
        return {
          ok: false,
          kind: 'rejected',
          message: `\`claude\` no pudo ejecutarse: ${result.error.message}`,
          raw: raw || undefined,
        };
      }
      if (result.status !== 0) {
        // Exit code != 0 con el binario sí instalado: se muestra el
        // stderr/stdout crudo tal cual, nunca se intenta adivinar qué
        // pasó — ej. flags no soportados por esa versión de Claude Code,
        // sesión no iniciada, permission-mode desconocido. Ver nota de
        // robustez de 06: "fallar de forma explícita y legible... en vez
        // de asumir compatibilidad ciega".
        const raw = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
        return {
          ok: false,
          kind: 'rejected',
          message: `\`claude\` devolvió un error (código ${String(result.status ?? '?')}): ${raw || 'sin salida'}`,
          raw: raw || undefined,
        };
      }

      const extracted = extractResultText(result.stdout);
      if ('error' in extracted) {
        logger.debug('salida de claude no reconocida:', result.stdout.slice(0, 500));
        return { ok: false, kind: 'unparsable-output', message: extracted.error, raw: result.stdout };
      }
      return { ok: true, text: extracted.text };
    },
  };
}
