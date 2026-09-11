// Punto de entrada del content script. Los sitios de chat son SPAs: en el
// primer tick puede que ni siquiera exista <body> con contenido real
// todavía, así que reintenta montar el widget en vez de fallar en el primer
// intento — mismo espíritu de "no fallar silencioso a la primera" que el
// resto del proyecto, aplicado aquí a un problema de timing, no de lógica.

(function devpilotBootstrap(): void {
  const adapter = window.__devpilotBridge.pickAdapter(location.hostname);
  if (!adapter) return; // no debería pasar dado el `matches` de manifest.json, pero nunca asumir

  let attempts = 0;
  const MAX_ATTEMPTS = 40; // ~10s a 250ms por intento

  const timer = window.setInterval(() => {
    attempts += 1;
    if (document.body) {
      devpilotMountWidget(adapter);
      window.clearInterval(timer);
      return;
    }
    if (attempts >= MAX_ATTEMPTS) {
      window.clearInterval(timer);
    }
  }, 250);
})();
