// Contrato de cada adapter de sitio. Deliberadamente angosto: la extensión
// (ver docs/architecture/06, sección "Browser Bridge") solo automatiza el
// copiar/pegar físico. NUNCA parsea la respuesta ni decide si un cambio es
// válido — eso sigue siendo trabajo exclusivo de `devpilot import`
// (ChangeParser/ChangeValidator). Un adapter que no logra encontrar algo
// debe devolver null/false explícito, nunca adivinar.
interface DevPilotSiteAdapter {
  id: string;
  displayName: string;
  matchesHostname(hostname: string): boolean;
  /** Encuentra el cuadro de texto donde escribir el prompt. null si no se encontró con confianza razonable. */
  findComposer(): HTMLElement | null;
  /** Inserta texto en el composer simulando una pegada real (dispara los eventos que el framework del sitio espera). */
  insertText(composer: HTMLElement, text: string): void;
  /** Intenta enviar el mensaje. Devuelve true si se intentó una acción de envío (no hay forma confiable de confirmar éxito desde fuera del sitio). */
  trySubmit(composer: HTMLElement): boolean;
  /** Texto plano de la última respuesta del asistente visible en la página. null si no se pudo identificar con confianza. */
  findLatestAssistantMessageText(): string | null;
}

interface DevPilotBridgeGlobal {
  adapters: DevPilotSiteAdapter[];
  registerAdapter(adapter: DevPilotSiteAdapter): void;
  pickAdapter(hostname: string): DevPilotSiteAdapter | null;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- fusión ambiental de la interfaz global Window (agrega `__devpilotBridge`); nunca se instancia como tipo por nombre, por eso ESLint la ve "sin usar".
interface Window {
  __devpilotBridge: DevPilotBridgeGlobal;
}
