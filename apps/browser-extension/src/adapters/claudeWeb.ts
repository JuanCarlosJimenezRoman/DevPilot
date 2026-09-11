// Adapter para claude.ai. Selectores específicos son "mejor esfuerzo": el
// sitio puede cambiar su HTML en cualquier momento (ver nota de robustez de
// 06 sobre providers). Por eso cada función cae a la heurística genérica de
// dom-utils.ts si el selector específico no encuentra nada, en vez de
// fallar directo.

function claudeMatchesHostname(hostname: string): boolean {
  return hostname === 'claude.ai' || hostname.endsWith('.claude.ai');
}

function claudeFindComposer(): HTMLElement | null {
  const specific = document.querySelector<HTMLElement>(
    'div[contenteditable="true"].ProseMirror, div[contenteditable="true"][aria-label*="Claude" i], div[contenteditable="true"][aria-label*="prompt" i]',
  );
  return specific ?? devpilotFindGenericComposer();
}

function claudeInsertText(composer: HTMLElement, text: string): void {
  devpilotInsertTextGeneric(composer, text);
}

function claudeTrySubmit(composer: HTMLElement): boolean {
  const form = composer.closest('form');
  const button = (form ?? document).querySelector<HTMLButtonElement>(
    'button[aria-label*="Send" i], button[aria-label*="Enviar" i]',
  );
  if (button && !button.disabled) {
    button.click();
    return true;
  }
  return devpilotTrySubmitViaEnter(composer);
}

function claudeFindLatestAssistantMessageText(): string | null {
  const nodes = document.querySelectorAll<HTMLElement>(
    '[data-testid="chat-message-content"], [data-testid="message-content"]',
  );
  const last = nodes.length > 0 ? nodes[nodes.length - 1] : undefined;
  const text = last?.innerText?.trim();
  if (text) return text;
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
