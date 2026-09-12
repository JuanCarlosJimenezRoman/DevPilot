// Adapter para claude.ai. Selectores validados en vivo (sesión 11, ver
// docs/architecture/07-roadmap.md) contra el DOM real de claude.ai
// (2026-09-12) usando Claude in Chrome para inspeccionar la página sin
// necesidad de cargar la extensión empaquetada — composer, botón de envío y
// el contenido real del último mensaje del asistente confirmados contra una
// sesión real logueada. Cada selector específico sigue teniendo la
// heurística genérica de dom-utils.ts como respaldo, porque el sitio puede
// cambiar este HTML en cualquier momento sin aviso.

function claudeMatchesHostname(hostname: string): boolean {
  return hostname === 'claude.ai' || hostname.endsWith('.claude.ai');
}

function claudeFindComposer(): HTMLElement | null {
  const specific = document.querySelector<HTMLElement>(
    '[data-testid="chat-input"] div[contenteditable="true"], div[contenteditable="true"].ProseMirror',
  );
  return specific ?? devpilotFindGenericComposer();
}

function claudeInsertText(composer: HTMLElement, text: string): void {
  devpilotInsertTextGeneric(composer, text);
}

function claudeTrySubmit(composer: HTMLElement): boolean {
  const button = document.querySelector<HTMLButtonElement>(
    '[data-testid="chat-input-send"], button[aria-label*="Enviar" i], button[aria-label*="Send" i]',
  );
  if (button && !button.disabled) {
    button.click();
    return true;
  }
  return devpilotTrySubmitViaEnter(composer);
}

function claudeFindLatestAssistantMessageText(): string | null {
  // `[data-perf-row="assistant"]` es la fila real del último mensaje del
  // asistente (el transcript de claude.ai está virtualizado: normalmente
  // solo la fila visible/última existe en el DOM). Dentro de esa fila,
  // `.standard-markdown`/`.progressive-markdown` es el contenido real
  // renderizado — evita capturar el resumen de herramientas usadas
  // ("Se usaron N herramientas...") que Cowork agrega arriba del mensaje.
  const rows = document.querySelectorAll<HTMLElement>('[data-perf-row="assistant"]');
  const lastRow = rows.length > 0 ? rows[rows.length - 1] : undefined;
  if (lastRow) {
    const markdown = lastRow.querySelector<HTMLElement>('.standard-markdown, .progressive-markdown');
    const text = (markdown ?? lastRow).innerText?.trim();
    if (text) return text;
  }

  // Selectores de respaldo por si el sitio deja de usar `data-perf-row`.
  const legacyNodes = document.querySelectorAll<HTMLElement>(
    '[data-testid="chat-message-content"], [data-testid="message-content"]',
  );
  const legacyLast = legacyNodes.length > 0 ? legacyNodes[legacyNodes.length - 1] : undefined;
  const legacyText = legacyLast?.innerText?.trim();
  if (legacyText) return legacyText;

  return devpilotFindGenericLatestMessage(claudeFindComposer());
}

window.__devpilotBridge.registerAdapter({
  id: 'claude-web',
  displayName: 'Claude.ai',
  matchesHostname: claudeMatchesHostname,
  findComposer: claudeFindComposer,
  insertText: claudeInsertText,
  trySubmit: claudeTrySubmit,
  findLatestAssistantMessageText: claudeFindLatestAssistantMessageText,
});
