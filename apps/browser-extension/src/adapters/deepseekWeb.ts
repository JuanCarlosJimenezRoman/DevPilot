// Adapter para chat.deepseek.com. De los tres, el que tiene menos certeza de
// selector específico (DOM menos documentado/estable públicamente) — por
// diseño se apoya más en la heurística genérica de dom-utils.ts, que es
// justamente el respaldo pensado para este caso. Ver README.md de esta app
// para el pedido explícito de validación real contra el sitio.

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

function deepseekFindLatestAssistantMessageText(): string | null {
  const nodes = document.querySelectorAll<HTMLElement>('.ds-markdown, [class*="markdown"]');
  const last = nodes.length > 0 ? nodes[nodes.length - 1] : undefined;
  const text = last?.innerText?.trim();
  if (text) return text;
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
