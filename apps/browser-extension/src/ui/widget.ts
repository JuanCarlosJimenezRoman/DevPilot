// Widget flotante mínimo, sin frameworks (consistente con el resto de
// DevPilot: no sumar dependencias/complejidad sin un consumidor real, ver
// nota de `ClaudeCodeProvider`/`GitAdapter` en 06/07). Dos acciones nada
// más, cada una con feedback explícito de éxito/fallo — nunca una acción
// silenciosa, mismo criterio que el resto del proyecto.

function devpilotSetStatus(statusEl: HTMLElement, message: string, kind: 'ok' | 'warn' | 'error'): void {
  statusEl.textContent = message;
  statusEl.style.color = kind === 'ok' ? '#5eead4' : kind === 'warn' ? '#fbbf24' : '#f87171';
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- usada desde otros content scripts que comparten este mismo scope global (sin bundler, ver manifest.json); ESLint lintea archivo por archivo y no lo ve.
function devpilotMountWidget(adapter: DevPilotSiteAdapter): void {
  if (document.getElementById('devpilot-bridge-widget')) return; // ya montado (navegación SPA, re-inyección, etc.)

  const collapsedKey = 'devpilot-bridge-collapsed';
  let collapsed = sessionStorage.getItem(collapsedKey) === '1';

  const root = document.createElement('div');
  root.id = 'devpilot-bridge-widget';
  root.style.cssText = `
    all: initial;
    position: fixed; bottom: 16px; right: 16px; z-index: 2147483647;
    font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  `;

  const toggle = document.createElement('button');
  toggle.textContent = 'DP';
  toggle.title = 'DevPilot Bridge';
  toggle.style.cssText = `
    all: initial; cursor: pointer; display: block; width: 40px; height: 40px;
    border-radius: 20px; background: #1e293b; color: #5eead4; font-weight: 700;
    font: 13px/40px -apple-system, sans-serif; text-align: center;
    box-shadow: 0 2px 10px rgba(0,0,0,.35); border: 1px solid #334155;
  `;

  const panel = document.createElement('div');
  panel.style.cssText = `
    all: initial; display: block; width: 240px; margin-top: 8px;
    background: #1e293b; color: #f1f5f9; border-radius: 10px; padding: 12px;
    box-shadow: 0 4px 16px rgba(0,0,0,.4); border: 1px solid #334155;
    font: 12px/1.5 -apple-system, sans-serif;
  `;

  panel.innerHTML = `
    <div style="font-weight:700; margin-bottom:6px; color:#e2e8f0;">DevPilot Bridge</div>
    <div style="color:#94a3b8; margin-bottom:10px;">${adapter.displayName}</div>
  `;

  const pasteBtn = document.createElement('button');
  pasteBtn.textContent = '📋 Pegar Context Pack';
  pasteBtn.style.cssText = devpilotButtonStyle();

  const autoSubmitLabel = document.createElement('label');
  autoSubmitLabel.style.cssText = 'all: initial; display:flex; align-items:center; gap:6px; margin:8px 0; color:#94a3b8; cursor:pointer;';
  const autoSubmitCheckbox = document.createElement('input');
  autoSubmitCheckbox.type = 'checkbox';
  autoSubmitLabel.appendChild(autoSubmitCheckbox);
  autoSubmitLabel.appendChild(document.createTextNode('Enviar automáticamente (experimental)'));

  const copyBtn = document.createElement('button');
  copyBtn.textContent = '📥 Copiar última respuesta';
  copyBtn.style.cssText = devpilotButtonStyle();

  const status = document.createElement('div');
  status.style.cssText = 'all: initial; display:block; margin-top:8px; min-height:14px; color:#94a3b8;';

  panel.appendChild(pasteBtn);
  panel.appendChild(autoSubmitLabel);
  panel.appendChild(copyBtn);
  panel.appendChild(status);

  function render(): void {
    root.innerHTML = '';
    if (collapsed) {
      root.appendChild(toggle);
    } else {
      root.appendChild(toggle);
      root.appendChild(panel);
    }
  }

  toggle.addEventListener('click', () => {
    collapsed = !collapsed;
    sessionStorage.setItem(collapsedKey, collapsed ? '1' : '0');
    render();
  });

  pasteBtn.addEventListener('click', () => {
    void (async () => {
      const composer = adapter.findComposer();
      if (!composer) {
        devpilotSetStatus(status, 'No encontré el cuadro de texto en esta página. Pégalo a mano.', 'error');
        return;
      }
      let text: string;
      try {
        text = await navigator.clipboard.readText();
      } catch {
        devpilotSetStatus(status, 'No pude leer el portapapeles (permiso denegado). Pégalo a mano (Ctrl/Cmd+V).', 'error');
        return;
      }
      if (!text) {
        devpilotSetStatus(status, 'El portapapeles está vacío. Corre `devpilot context` primero.', 'warn');
        return;
      }
      adapter.insertText(composer, text);
      if (autoSubmitCheckbox.checked) {
        const attempted = adapter.trySubmit(composer);
        devpilotSetStatus(status, attempted ? 'Pegado y envío intentado — verifica que se haya enviado.' : 'Pegado. No pude enviarlo automáticamente.', 'ok');
      } else {
        devpilotSetStatus(status, `Pegado (${text.length} caracteres). Revisa y envía a mano.`, 'ok');
      }
    })();
  });

  copyBtn.addEventListener('click', () => {
    void (async () => {
      const text = adapter.findLatestAssistantMessageText();
      if (!text) {
        devpilotSetStatus(status, 'No pude identificar la última respuesta automáticamente. Cópiala a mano y pégala en `devpilot import`.', 'warn');
        return;
      }
      try {
        await navigator.clipboard.writeText(text);
        devpilotSetStatus(status, `Copiado (${text.length} caracteres) — pégalo en \`devpilot import\`.`, 'ok');
      } catch {
        devpilotSetStatus(status, 'No pude escribir en el portapapeles (permiso denegado).', 'error');
      }
    })();
  });

  render();
  document.body.appendChild(root);
}

function devpilotButtonStyle(): string {
  return `
    all: initial; display:block; width:100%; box-sizing:border-box;
    cursor:pointer; margin-top:4px; padding:8px 10px; border-radius:6px;
    background:#334155; color:#f1f5f9; text-align:left;
    font: 12px/1.4 -apple-system, sans-serif;
  `;
}
