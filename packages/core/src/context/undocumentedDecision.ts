import type { ContextPack, FileChangeProposal } from '@devpilot/shared';

// Heurística `undocumented-decision` — el hallazgo más importante del Paso
// 0 (ver 06): DeepSeek propuso umbrales de volumen/peso que no aparecían
// en ningún lado del Context Pack. Detección heurística, no semántica —
// "puede haber falsos positivos... el costo de una alerta de más es mucho
// menor que el de una decisión de negocio colada sin que nadie la revise".
// Dos señales, tal cual las describe 06:
//   (a) un modelo Prisma nuevo que no se menciona en el pack
//   (b) un literal numérico usado en comparación que no aparece en el pack

const PRISMA_MODEL_RE = /\bmodel\s+(\w+)\s*\{/g;
// número seguido o precedido de un operador de comparación — la forma más
// simple y barata de detectar "esto se usa como umbral", sin necesitar un
// parser real.
const NUMERIC_THRESHOLD_RE = /(-?\d+(?:\.\d+)?)\s*(?:<=|>=|<|>|===|==)|(?:<=|>=|<|>|===|==)\s*(-?\d+(?:\.\d+)?)/g;

function changedText(proposal: FileChangeProposal): string {
  if (proposal.operation === 'patch') return proposal.patch?.replace ?? '';
  return proposal.newContent ?? proposal.diff ?? '';
}

function buildPackText(contextPack: ContextPack): string {
  return [
    ...contextPack.relevantFiles.map((f) => f.content),
    ...contextPack.businessDecisions.confirmed,
    ...contextPack.businessDecisions.open,
    ...contextPack.constraints,
  ].join('\n');
}

// `packText.includes(num)` puro es casi inútil en la práctica: cualquier
// Context Pack de tamaño real (código con números de línea, IDs, fechas,
// puertos, índices de arreglo...) contiene "5", "8" o "0" como *substring*
// de algún otro número en algún lado, aunque ese número no tenga nada que
// ver con el umbral propuesto — probado contra el Context Pack real de
// camino-al-deporte: "5", "8" y "0" aparecen ahí como substring aunque el
// pack nunca menciona esos umbrales. Se exige que el número aparezca como
// token completo (no como parte de otro número más largo, p. ej. "5" no
// cuenta si solo aparece dentro de "2025" o "150").
function numberAppearsAsToken(num: string, packText: string): boolean {
  const escaped = num.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![\\d.])${escaped}(?![\\d.])`);
  return re.test(packText);
}

export interface UndocumentedDecisionResult {
  detected: boolean;
  detail?: string;
}

export function detectUndocumentedDecision(
  proposal: FileChangeProposal,
  contextPack: ContextPack,
): UndocumentedDecisionResult {
  const newText = changedText(proposal);
  if (!newText.trim()) return { detected: false };

  const packText = buildPackText(contextPack);
  const findings: string[] = [];

  if (proposal.path.endsWith('.prisma') || /\bmodel\s+\w+\s*\{/.test(newText)) {
    PRISMA_MODEL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PRISMA_MODEL_RE.exec(newText)) !== null) {
      const modelName = m[1];
      if (modelName && !packText.includes(modelName)) {
        findings.push(`modelo Prisma nuevo "${modelName}" no mencionado en el Context Pack`);
      }
    }
  }

  const numbers = new Set<string>();
  NUMERIC_THRESHOLD_RE.lastIndex = 0;
  let nm: RegExpExecArray | null;
  while ((nm = NUMERIC_THRESHOLD_RE.exec(newText)) !== null) {
    const num = nm[1] ?? nm[2];
    if (num) numbers.add(num);
  }
  for (const num of numbers) {
    if (!numberAppearsAsToken(num, packText)) {
      findings.push(`valor numérico "${num}" usado como umbral/comparación, no aparece en el Context Pack`);
    }
  }

  return findings.length > 0 ? { detected: true, detail: findings.join('; ') } : { detected: false };
}
