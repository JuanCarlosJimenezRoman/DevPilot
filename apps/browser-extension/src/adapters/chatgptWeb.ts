// Adapter para ChatGPT (chatgpt.com / chat.openai.com, que redirige al
// primero). Igual que claudeWeb.ts: selector específico primero, heurística
// genérica de dom-utils.ts como respaldo.

function chatgptMatchesHostname(hostname: string): boolean {
  return hostname === 'chatgpt.com' || hostname === 'chat.openai.com' || hostname.endsWith('.chatgpt.com');
}

function chatgptFindComposer(): HTMLElement | null {
  const specific = document.querySelector<HTMLElement>('#prompt-textarea, div[contenteditable="true"]#prompt-textarea');
  return specific ?? devpilotFindGenericComposer();
}

function chatgptInsertText(composer: HTMLElement, text: string): void {
  devpilotInsertTextGeneric(composer, text);
}

function chatgptTrySubmit(composer: HTMLElement): boolean {
  const form = composer.closest('form');
  const button = (form ?? document).querySelector<HTMLButtonElement>(
    'button[data-testid="send-button"], button[aria-label*="Send" i]',
  );
  if (button && !button.disabled) {
    button.click();
    return true;
  }
  return devpilotTrySubmitViaEnter(composer);
}

function chatgptFindLatestAssistantMessageText(): string | null {
  const nodes = document.querySelectorAll<HTMLElement>('[data-message-author-role="assistant"]');
  const last = nodes.length > 0 ? nodes[nodes.length - 1] : undefined;
  const text = last?.innerText?.trim();
  if (text) return text;
  return devpilotFindGenericLatestMessage(chatgptFindComposer());
}

window.__devpilotBridge.registerAdapter({
  id: 'chatgpt-web',
  displayName: 'ChatGPT',
  matchesHostname: chatgptMatchesHostname,
  findComposer: chatgptFindComposer,
  insertText: chatgptInsertText,
  trySubmit: chatgptTrySubmit,
  findLatestAssistantMessageText: chatgptFindLatestAssistantMessageText,
});
