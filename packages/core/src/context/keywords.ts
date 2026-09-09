// Extracción de keywords de la tarea — Context Planner Nivel 1 (ver 04).
// Deliberadamente simple: tokenización + una lista de stopwords, sin NLP.
// Preferimos identificadores "tipo código" (camelCase, snake_case,
// SCREAMING_SNAKE) y términos entre backticks tal cual, porque son los que
// más fielmente apuntan a símbolos reales del proyecto — que es
// exactamente lo que el Paso 0 mostró que funciona (ver 01).

const STOPWORDS = new Set([
  // español
  'el', 'la', 'los', 'las', 'de', 'del', 'que', 'y', 'a', 'en', 'un', 'una',
  'unos', 'unas', 'con', 'para', 'por', 'se', 'su', 'sus', 'no', 'sin', 'es',
  'al', 'lo', 'como', 'ya', 'esta', 'este', 'estos', 'estas', 'pero', 'o',
  'si', 'más', 'muy', 'todo', 'toda', 'todos', 'todas', 'cuando', 'donde',
  'hay', 'ser', 'está', 'están', 'fue', 'ha', 'han', 'nos', 'le', 'les',
  'quiero', 'quiere', 'poder', 'puede', 'pueden', 'hacer', 'sobre', 'entre',
  // inglés
  'the', 'a', 'an', 'and', 'or', 'of', 'in', 'to', 'for', 'with', 'on', 'at',
  'is', 'be', 'this', 'that', 'these', 'those', 'it', 'as', 'from', 'by',
  'are', 'was', 'were', 'not', 'but', 'so', 'if', 'when', 'where', 'have',
  'has', 'had', 'do', 'does', 'did', 'can', 'could', 'should', 'would',
]);

const MAX_KEYWORDS = 25;

function isIdentifierLike(token: string): boolean {
  return /_/.test(token) || /[a-z][A-Z]/.test(token) || (token.length >= 3 && token === token.toUpperCase());
}

export function extractKeywords(taskText: string): string[] {
  const seen = new Set<string>();
  const keywords: string[] = [];

  const add = (raw: string): void => {
    const token = raw.trim();
    if (token.length < 3) return;
    const dedupeKey = token.toLowerCase();
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    keywords.push(token);
  };

  // 1) Términos entre backticks — casi siempre nombres reales de símbolos,
  // rutas o identificadores que el usuario escribió a propósito.
  const backtickRe = /`([^`\n]{2,60})`/g;
  let match: RegExpExecArray | null;
  while ((match = backtickRe.exec(taskText)) !== null) {
    const term = match[1];
    if (term) add(term);
  }

  // 2) Tokens tipo identificador (camelCase/snake_case/SCREAMING_SNAKE) sin
  // backticks — igual de valiosos, y no siempre el usuario los marca.
  const identifierRe = /\b[A-Za-z][A-Za-z0-9_]{2,}\b/g;
  while ((match = identifierRe.exec(taskText)) !== null) {
    const token = match[0];
    if (isIdentifierLike(token)) add(token);
  }

  // 3) Palabras sueltas (≥4 letras, no stopword) como señal más débil de
  // texto libre.
  const wordRe = /\b[\p{L}][\p{L}0-9]{3,}\b/gu;
  while ((match = wordRe.exec(taskText)) !== null) {
    const token = match[0];
    if (STOPWORDS.has(token.toLowerCase())) continue;
    add(token);
  }

  return keywords.slice(0, MAX_KEYWORDS);
}
