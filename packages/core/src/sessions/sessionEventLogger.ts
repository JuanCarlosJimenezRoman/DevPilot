import { appendSessionEvent, getActiveSession, openProjectDb } from '@devpilot/storage';

// Punto único y sin dependencias de otros servicios de `core` desde el que
// cualquier pieza (`devpilot context`/`import`/`apply`/`decide`) puede: (a)
// saber si hay una sesión activa para este proyecto, y (b) agregar un
// evento a su log si la hay — así el `.jsonl` de una sesión termina siendo
// un timeline real de "qué pasó" (04: "detalle turno-a-turno"), no algo que
// el usuario tiene que llenar a mano con `devpilot session note`.
//
// Deliberadamente en su propio archivo, NO en sessionService.ts: éste
// último necesita importar `createDecision` de decisionService.ts (para
// `devpilot session promote`), y decisionService.ts necesita loguear un
// evento al crear una decisión — importar sessionService.ts desde
// decisionService.ts habría cerrado un ciclo entre ambos módulos. Este
// archivo solo depende de `@devpilot/storage`, así que cualquiera de los
// dos puede importarlo sin problema.
//
// Loguear es siempre best-effort y silencioso cuando no hay sesión activa
// — Session Memory es opcional (04), ningún comando existente debe
// empezar a fallar por no haber corrido `devpilot session start` antes.

/** `null` si no hay ninguna sesión activa para este proyecto — no es un error, solo dice que no hay dónde loguear. Asume `rootPath` ya resuelto (`path.resolve`), igual que el resto de los servicios de `core`. */
export function getActiveSessionId(rootPath: string): string | null {
  const projectDb = openProjectDb(rootPath);
  try {
    return getActiveSession(projectDb)?.id ?? null;
  } finally {
    projectDb.close();
  }
}

/** Agrega un evento al log de la sesión activa del proyecto, si hay una. No hace nada si no la hay — no lanza, no bloquea el comando que lo llama. */
export async function logSessionEvent(
  rootPath: string,
  kind: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  const sessionId = getActiveSessionId(rootPath);
  if (!sessionId) return;
  await appendSessionEvent(rootPath, sessionId, {
    timestamp: new Date().toISOString(),
    kind,
    detail,
  });
}
