// Heurísticas genéricas, compartidas por los tres adapters de sitio, para
// cuando el selector específico de un sitio no encuentra nada (el sitio
// cambió su HTML — algo que va a pasar tarde o temprano, ver nota de
// robustez en 06 sobre ClaudeCodeProvider: "fallar de forma explícita y
// legible, no silenciosa"). Estas funciones son deliberadamente
// conservadoras: si no están razonablemente seguras, devuelven null en vez
// de arriesgarse a insertar texto en el lugar equivocado o copiar el
// mensaje equivocado. Degradar a "no se pudo, cópialo a mano" es siempre
// mejor que una automatización silenciosamente incorrecta — la extensión
// nunca es una dependencia funcional (ver 06/07), así que fallar aquí no
// bloquea nada, el usuario siempre puede copiar/pegar él mismo.

/** Busca el elemento editable "de composer" más plausible en la página: un <textarea> o un contenteditable visible, priorizando el que esté más abajo en la pantalla (patrón casi universal de los chats de IA). */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- usada desde otros content scripts que comparten este mismo scope global (sin bundler, ver manifest.json); ESLint lintea archivo por archivo y no lo ve.
function devpilotFindGenericComposer(): HTMLElement | null {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>('textarea, div[contenteditable="true"]'),
  ).filter((el) => el.offsetParent !== null && el.getBoundingClientRect().width > 40);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  return candidates[candidates.length - 1] ?? null;
}

/** Inserta texto en un elemento editable disparando los eventos que React/frameworks similares esperan para detectar el cambio (asignar `.value`/`.textContent` a mano no dispara sus listeners). */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- usada desde otros content scripts que comparten este mismo scope global (sin bundler, ver manifest.json); ESLint lintea archivo por archivo y no lo ve.
function devpilotInsertTextGeneric(el: HTMLElement, text: string): void {
  el.focus();
  const insertedViaExecCommand = document.execCommand('insertText', false, text);
  if (insertedViaExecCommand) return;

  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    const proto = Object.getPrototypeOf(el) as HTMLTextAreaElement | HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    setter?.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }

  el.textContent = text;
  el.dispatchEvent(new InputEvent('input', { bubbles: true }));
}

/** Intenta enviar simulando Enter (sin Shift) — el atajo casi universal de "enviar" en composers de chat. No hay forma confiable de confirmar éxito desde fuera del sitio, así que siempre se reporta como "intentado", nunca como "confirmado". */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- usada desde otros content scripts que comparten este mismo scope global (sin bundler, ver manifest.json); ESLint lintea archivo por archivo y no lo ve.
function devpilotTrySubmitViaEnter(el: HTMLElement): boolean {
  const opts: KeyboardEventInit = {
    key: 'Enter',
    code: 'Enter',
    bubbles: true,
    cancelable: true,
  };
  el.dispatchEvent(new KeyboardEvent('keydown', opts));
  el.dispatchEvent(new KeyboardEvent('keyup', opts));
  return true;
}

/** Heurística genérica de "última respuesta del asistente": busca el contenedor visible más grande de la página (normalmente el scroll de la conversación) y, dentro de él, el último bloque de texto sustancial que no sea ni contenga al composer. Deliberadamente conservadora: exige un mínimo de texto y evita el propio composer para no devolver el prompt que el usuario acaba de escribir. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- usada desde otros content scripts que comparten este mismo scope global (sin bundler, ver manifest.json); ESLint lintea archivo por archivo y no lo ve.
function devpilotFindGenericLatestMessage(composer: HTMLElement | null): string | null {
  const MIN_LENGTH = 20;
  const blocks = Array.from(document.querySelectorAll<HTMLElement>('main *'))
    .filter((el) => el.children.length <= 2) // preferir nodos "hoja" de contenido, no contenedores de layout
    .filter((el) => !composer || (!composer.contains(el) && !el.contains(composer)))
    .filter((el) => el.offsetParent !== null)
    .map((el) => ({ el, text: el.innerText?.trim() ?? '' }))
    .filter(({ text }) => text.length >= MIN_LENGTH);

  if (blocks.length === 0) return null;

  // El último en el orden del documento suele ser el mensaje más reciente
  // en un feed de chat que crece hacia abajo.
  blocks.sort((a, b) => {
    const posA = a.el.getBoundingClientRect().top;
    const posB = b.el.getBoundingClientRect().top;
    return posA - posB;
  });
  const last = blocks[blocks.length - 1];
  return last ? last.text : null;
}
