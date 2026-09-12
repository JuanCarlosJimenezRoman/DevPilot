// Adapter para ChatGPT (chatgpt.com / chat.openai.com, que redirige al
// primero). Igual que claudeWeb.ts: selector específico primero, heurística
// genérica de dom-utils.ts como respaldo. Composer (`#prompt-textarea`),
// botón de envío (`data-testid="send-button"`) y mensajes del asistente
// (`[data-message-author-role="assistant"]`) validados en vivo contra una
// sesión real logueada (sesión 11, ver 07-roadmap.md) — de los tres sitios,
// el que más selectores específicos confirmó tal cual estaban.

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
  // Validado en vivo (sesión 11): el botón real usa
  // `data-testid="send-button"` con aria-label localizado ("Enviar
  // mensaje" en español, "Send message" en inglés) — no vive dentro de un
  // <form>, así que se busca en todo el documento en vez de acotar a
  // `closest('form')`.
  const button = document.querySelector<HTMLButtonElement>(
    'button[data-testid="send-button"], button[aria-label*="Enviar" i], button[aria-label*="Send" i]',
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
