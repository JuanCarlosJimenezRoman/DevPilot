import { CANONICAL_TYPES, type CanonicalKnowledgeType } from '../knowledge/knowledgeService.js';

// DeepAnalysisParser — Incremento 4 ("Claude Code", ver 07). Mismo espíritu
// que `changeParser.ts` (06, Capa 2): reconoce FORMA, nunca juzga
// contenido; texto que no calza con ningún bloque reconocido nunca se
// descarta, se acumula en `unparsedNotes` y se muestra siempre al usuario
// (mismo principio ya aplicado a `unparsedNotes`/`ParsedResponse` en 06).
//
// Contrato de salida (documentado también en `deepAnalysisPrompt.ts`, que
// es lo que de verdad se le pide a Claude Code que siga) — dos tipos de
// bloque, deliberadamente simples (a diferencia de `<DEVPILOT_CHANGE>`, acá
// no hay SEARCH/REPLACE que reconstruir contra un archivo real, solo
// contenido propuesto de knowledge doc o campos de una decisión):
//
//   <DEVPILOT_KNOWLEDGE type="architecture">
//   ...contenido Markdown completo propuesto para ese knowledge doc...
//   </DEVPILOT_KNOWLEDGE>
//
//   <DEVPILOT_KNOWLEDGE type="custom" title="Título custom">
//   ...
//   </DEVPILOT_KNOWLEDGE>
//
//   <DEVPILOT_DECISION>
//   title: ...
//   context: ...
//   decision: ...
//   consequences: ... (opcional)
//   </DEVPILOT_DECISION>

// Reusa el mismo tipo/lista de knowledgeService.ts (no lo redefine acá) —
// evita duplicar la fuente de verdad de "cuáles son los 5 tipos
// canónicos", igual que ya reusa `slugify`/`CANONICAL_TITLES`
// deepAnalysisService.ts.
function isCanonicalKnowledgeType(value: string): value is CanonicalKnowledgeType {
  return (CANONICAL_TYPES as readonly string[]).includes(value);
}

export interface KnowledgeProposal {
  /** Tipo tal como lo declaró Claude Code — si no es uno de los 5 canónicos ni "custom", se trata como "custom" igual (ver `parseDeepAnalysisResponse`) para no perder la propuesta por un typo de tipo. */
  type: CanonicalKnowledgeType | 'custom';
  /** Requerido para `type: 'custom'` (mismo contrato que `devpilot knowledge edit`, ver knowledgeService.ts); `undefined` para los tipos canónicos, que ya tienen título por defecto. */
  title?: string;
  content: string;
}

export interface DecisionProposal {
  title: string;
  context: string;
  decision: string;
  consequences?: string;
}

export interface DeepAnalysisParseResult {
  knowledgeProposals: KnowledgeProposal[];
  decisionProposals: DecisionProposal[];
  /** Texto fuera de cualquier bloque reconocido — nunca se descarta, ver comentario de arriba. Vacío si toda la respuesta se pudo mapear a bloques. */
  unparsedNotes: string;
}

function parseAttrs(attrString: string): { type: string | null; title: string | null } {
  const typeMatch = attrString.match(/type\s*=\s*"([^"]*)"/);
  const titleMatch = attrString.match(/title\s*=\s*"([^"]*)"/);
  return { type: typeMatch?.[1] ?? null, title: titleMatch?.[1] ?? null };
}

const KNOWLEDGE_BLOCK_RE = /<DEVPILOT_KNOWLEDGE\s+([^>]*)>([\s\S]*?)<\/DEVPILOT_KNOWLEDGE>/g;
const DECISION_BLOCK_RE = /<DEVPILOT_DECISION\s*>([\s\S]*?)<\/DEVPILOT_DECISION>/g;

/**
 * Parsea `title:`/`context:`/`decision:`/`consequences:` dentro de un
 * bloque `<DEVPILOT_DECISION>` — un campo por línea (o varias líneas
 * seguidas que no empiezan con `<campo>:` se acumulan en el campo
 * anterior, tolerante a contexto/decisión multi-línea real). `null` si
 * faltan `title`, `context` o `decision` (los tres obligatorios de
 * `CreateDecisionParams` en decisionService.ts) — un bloque incompleto no
 * es una decisión reconocible, se deja para `unparsedNotes` en vez de
 * proponer una Decision Record a medias.
 */
function parseDecisionFields(blockContent: string): DecisionProposal | null {
  const fieldRe = /^(title|context|decision|consequences)\s*:\s*(.*)$/i;
  const fields: Record<string, string[]> = {};
  let currentField: string | null = null;

  for (const rawLine of blockContent.split('\n')) {
    const match = rawLine.match(fieldRe);
    if (match) {
      currentField = match[1]!.toLowerCase();
      fields[currentField] = [match[2] ?? ''];
      continue;
    }
    if (currentField && rawLine.trim().length > 0) {
      fields[currentField]!.push(rawLine);
    }
  }

  const title = fields.title?.join('\n').trim();
  const context = fields.context?.join('\n').trim();
  const decision = fields.decision?.join('\n').trim();
  const consequences = fields.consequences?.join('\n').trim();

  if (!title || !context || !decision) return null;
  return { title, context, decision, consequences: consequences || undefined };
}

export function parseDeepAnalysisResponse(raw: string): DeepAnalysisParseResult {
  const text = raw.replace(/\r\n/g, '\n');
  const knowledgeProposals: KnowledgeProposal[] = [];
  const decisionProposals: DecisionProposal[] = [];

  // Se recorre una sola vez, reemplazando cada bloque reconocido (sea
  // válido o no) por una cadena vacía, para que lo que sobre en `text` sea
  // exactamente `unparsedNotes` — mismo enfoque que un ChangeParser
  // "resta lo reconocido, lo que queda es lo no reconocido", sin necesitar
  // rastrear offsets a mano.
  let remaining = text;

  remaining = remaining.replace(KNOWLEDGE_BLOCK_RE, (_full, attrString: string, blockContent: string) => {
    const { type, title } = parseAttrs(attrString);
    const content = blockContent.trim();
    if (!type || content.length === 0) return ''; // bloque sin type o vacío: no es una propuesta reconocible, se descarta el marcador pero no debería perder información real (un bloque vacío no tiene información)
    const resolvedType = isCanonicalKnowledgeType(type) ? type : 'custom';
    if (resolvedType === 'custom' && !title) {
      // "custom" sin título: no se puede identificar el doc (mismo
      // requisito que `devpilot knowledge edit`, ver knowledgeService.ts)
      // — se deja como si no se hubiera reconocido el bloque, para que el
      // usuario vea el contenido crudo en `unparsedNotes` en vez de
      // perderlo silenciosamente.
      return `${_full}\n`;
    }
    knowledgeProposals.push({ type: resolvedType, title: title ?? undefined, content });
    return '';
  });

  remaining = remaining.replace(DECISION_BLOCK_RE, (full, blockContent: string) => {
    const proposal = parseDecisionFields(blockContent);
    if (!proposal) return `${full}\n`; // incompleto: se preserva crudo en unparsedNotes, no se descarta
    decisionProposals.push(proposal);
    return '';
  });

  return {
    knowledgeProposals,
    decisionProposals,
    unparsedNotes: remaining.trim(),
  };
}
