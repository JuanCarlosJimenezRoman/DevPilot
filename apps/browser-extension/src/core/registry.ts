// Registro simple de adapters. Cada archivo de adapter se auto-registra al
// cargar (ver manifest.json: los content scripts de un mismo frame
// comparten el mismo "mundo aislado", así que este objeto global es visible
// para los tres adapters y para el content script de entrada).

function devpilotRegisterAdapter(adapter: DevPilotSiteAdapter): void {
  window.__devpilotBridge.adapters.push(adapter);
}

function devpilotPickAdapter(hostname: string): DevPilotSiteAdapter | null {
  return window.__devpilotBridge.adapters.find((adapter) => adapter.matchesHostname(hostname)) ?? null;
}

window.__devpilotBridge = {
  adapters: [],
  registerAdapter: devpilotRegisterAdapter,
  pickAdapter: devpilotPickAdapter,
};
