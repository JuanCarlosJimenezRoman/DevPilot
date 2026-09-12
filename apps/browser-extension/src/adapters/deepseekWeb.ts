// Adapter para chat.deepseek.com. Selectores validados en vivo (sesión 11,
// ver docs/architecture/07-roadmap.md) contra el DOM real de una sesión
// logueada (2026-09-12): composer (`textarea[placeholder*="mensaje" i]`,
// confirmado con el placeholder real "Mensaje a DeepSeek"), mensajes del
// asistente (`.ds-assistant-message-main-content`, mucho más preciso que
// el `.ds-markdown` genérico usado antes de validar — ese selector genérico
// capturaba fragmentos de párrafo sueltos, no el mensaje completo) y botón
// de enviar (sin aria-label ni testid — un `div[role="button"]` con clase
// `ds-button--primary`, el más a la derecha dentro del contenedor del
// composer). De los tres sitios, el que menos señales semánticas expone —
// por eso sigue apoyándose más que los otros en la heurística genérica de
// dom-utils.ts como respaldo.

function deepseekMatchesHostname(hostname: string): boolean {
  return hostname === 'chat.deepseek.com' || hostname.endsWith('.deepseek.com');
}

function deepseekFindComposer(): HTMLElement | null {
  const specific = document.querySelector<HTMLElement>(
    'textarea#chat-input, textarea[placeholder*="Message" i], textarea[placeholder*="mensaje" i]',
  );
  return specific ?? devpilotFindGenericComposer();
}

function deepseekInsertText(composer: HTMLElement, text: string): void {
  devpilotInsertTextGeneric(composer, text);
}

function deepseekTrySubmit(composer: HTMLElement): boolean {
  let container: HTMLElement | null = composer;
  for (let i = 0; i < 4 && container?.parentElement; i += 1) container = container.parentElement;
  const scope = container ?? document;
  const candidates = Array.from(
    scope.querySelectorAll<HTMLElement>('div[role="button"].ds-button--primary, button[class*="primary" i]'),
  ).filter((el) => el.getAttribute('aria-disabled') !== 'true' && !(el as HTMLButtonElement).disabled);
  const button = candidates.length > 0 ? candidates[candidates.length - 1] : undefined;
  if (button) {
    button.click();
    return true;
  }
  return devpilotTrySubmitViaEnter(composer);
}

function deepseekFindLatestAssistantMessageText(): string | null {
  const nodes = document.querySelectorAll<HTMLElement>('.ds-assistant-message-main-content');
  const last = nodes.length > 0 ? nodes[nodes.length - 1] : undefined;
  const text = last?.innerText?.trim();
  if (text) return text;

  // Selectores de respaldo por si el sitio deja de usar esta clase.
  const legacyNodes = document.querySelectorAll<HTMLElement>('.ds-markdown, [class*="markdown"]');
  const legacyLast = legacyNodes.length > 0 ? legacyNodes[legacyNodes.length - 1] : undefined;
  const legacyText = legacyLast?.innerText?.trim();
  if (legacyText) return legacyText;

  return devpilotFindGenericLatestMessage(deepseekFindComposer());
}

window.__devpilotBridge.registerAdapter({
  id: 'deepseek-web',
  displayName: 'DeepSeek Chat',
  matchesHostname: deepseekMatchesHostname,
  findComposer: deepseekFindComposer,
  insertText: deepseekInsertText,
  trySubmit: deepseekTrySubmit,
  findLatestAssistantMessageText: deepseekFindLatestAssistantMessageText,
});
