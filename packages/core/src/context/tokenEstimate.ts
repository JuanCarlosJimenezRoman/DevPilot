import type { TokenEstimate } from '@devpilot/shared';

// Estimación de tokens — ver 04 "Token Estimation". Aproximación
// deliberadamente simple (caracteres/4): distintos proveedores tokenizan
// distinto y v1 no necesita esa precisión, solo una señal para clasificar
// 🟢/🟡/🔴. Umbrales literales aquí por el mismo motivo que en
// relevancePlanner.ts — `.devpilot/config.json` aún no existe.
const GREEN_MAX = 4000;
const YELLOW_MAX = 12000;

export function estimateTokens(parts: { label: string; text: string }[]): TokenEstimate {
  const perFile: Record<string, number> = {};
  let totalTokens = 0;

  for (const { label, text } of parts) {
    const tokens = Math.ceil(text.length / 4);
    perFile[label] = tokens;
    totalTokens += tokens;
  }

  const classification: TokenEstimate['classification'] =
    totalTokens < GREEN_MAX ? 'green' : totalTokens <= YELLOW_MAX ? 'yellow' : 'red';

  return { totalTokens, perFile, classification };
}
