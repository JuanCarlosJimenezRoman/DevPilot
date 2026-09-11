import { createInterface } from 'node:readline/promises';

// Confirmador de aprobaciones (Tool Engine, 05) — extraído desde
// `apply.ts` al implementar el Incremento 4 (`devpilot analyze --deep`,
// ver `analyze.ts`), que necesita exactamente el mismo comportamiento
// y/N por entrada. Comportamiento sin cambios respecto de la versión
// original (ver git blame de apply.ts si hace falta el historial): un
// refactor puro de extracción, no una reescritura — ambos comandos ahora
// comparten una sola implementación en vez de mantener dos copias que
// podrían desalinearse.
//
// Abstrae la diferencia entre una terminal interactiva real y stdin no
// interactivo (pipe, redirección desde archivo, `yes |`, o tests de estos
// comandos):
//
//   - TTY real: pregunta una por una con readline, como espera un humano.
//   - No-TTY: lee TODO stdin de una sola vez (ya está disponible completo
//     en el pipe) y consume una línea por confirmación, sin más llamadas a
//     readline. Si el input se agota antes de que se necesiten más
//     respuestas, se trata como "no" y se avisa explícitamente en vez de
//     quedarse colgado.
//
// (Se probó primero con `readline.createInterface` re-creada en cada
// pregunta: eso perdía las respuestas siguientes porque `rl.close()`
// descarta el buffer interno de líneas. Con stdin no interactivo, además,
// Node lee todo el pipe de una vez y emite `end` sobre la interfaz de
// readline apenas se agota el input — como el código hace trabajo async
// entre pregunta y pregunta, la interfaz ya está cerrada para cuando llega
// la segunda pregunta. Es una condición de carrera real de Node con
// streams no-TTY, no un bug de la lógica de este archivo.)

function isAffirmative(answer: string): boolean {
  return /^y(es)?$/i.test(answer.trim());
}

export interface Confirmer {
  confirm(promptText: string): Promise<boolean>;
  close(): void;
}

export function createConfirmer(): Confirmer {
  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return {
      async confirm(promptText: string): Promise<boolean> {
        const answer = await rl.question(`${promptText} [y/N] `);
        return isAffirmative(answer);
      },
      close(): void {
        rl.close();
      },
    };
  }

  let pendingLines: string[] | null = null;
  const readAllStdinLines = async (): Promise<string[]> => {
    if (pendingLines) return pendingLines;
    let data = '';
    process.stdin.setEncoding('utf8');
    await new Promise<void>((resolve, reject) => {
      process.stdin.on('data', (chunk) => {
        data += chunk;
      });
      process.stdin.on('end', () => resolve());
      process.stdin.on('error', reject);
    });
    pendingLines = data.split('\n');
    return pendingLines;
  };

  return {
    async confirm(promptText: string): Promise<boolean> {
      const lines = await readAllStdinLines();
      const next = lines.shift();
      if (next === undefined) {
        console.log(`${promptText} [y/N] (sin más respuestas en stdin — se trata como "no")`);
        return false;
      }
      console.log(`${promptText} [y/N] ${next.trim()}`);
      return isAffirmative(next);
    },
    close(): void {
      // No hay nada que cerrar: no se creó ninguna interfaz de readline en
      // este modo, y destruir process.stdin aquí no es necesario ni
      // deseable (Node lo limpia solo al terminar el proceso).
    },
  };
}
