import ts from 'typescript';

// Extracción de símbolos (Incremento 3 — ver 04 "Indexer" y 07): "AST
// ligero" quiere decir `ts.createSourceFile` (parseo sintáctico puro) sin
// armar un `ts.Program`/TypeChecker completo — no necesitamos resolver
// tipos ni imports cruzados, solo qué declara y exporta CADA archivo por
// separado. Esto es deliberadamente más pesado que el lexer por regex que
// usa importGraph.ts (Nivel 2) — por diseño: acá si necesitamos precisión
// real ("¿esto es un `export`, o solo una palabra parecida en un
// comentario?"), cosa que un lexer no puede garantizar.
//
// Alcance: solo símbolos de NIVEL SUPERIOR del archivo (funciones/clases/
// interfaces/types/enums/const-let-var, más exports con nombre) —
// funciones anidadas o métodos de clase no cuentan como "símbolos" propios
// en v1 (04: "funciones/clases/exports reales", no cada identificador del
// árbol). Patrones de destructuring en declaraciones (`const { a, b } =
// ...`) se saltan a propósito — casos reales de "esto exporta algo
// nombrado" casi siempre son declaraciones simples.
//
// Cobertura dual: sintaxis ESM (`export function`/`export const`/`export
// { x }`/`export default`) Y CommonJS (`exports.x = ...`/`module.exports
// = ...`) -- necesario porque proyectos reales mixtos (ej. un backend
// Express en JS plano junto a un frontend TypeScript moderno, el caso real
// de Camino al Deporte usado para validar esta pieza) usan ambos estilos
// en el mismo repo.

export interface ExtractedSymbol {
  name: string;
  kind: string;
  lineStart: number;
  lineEnd: number;
  isExported: boolean;
}

function scriptKindForPath(relPath: string): ts.ScriptKind {
  const dot = relPath.lastIndexOf('.');
  const ext = dot === -1 ? '' : relPath.slice(dot).toLowerCase();
  switch (ext) {
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.ts':
    case '.mts':
    case '.cts':
      return ts.ScriptKind.TS;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.Unknown;
  }
}

function lineRange(sourceFile: ts.SourceFile, node: ts.Node): { lineStart: number; lineEnd: number } {
  const lineStart = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const lineEnd = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
  return { lineStart, lineEnd };
}

function hasExportModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const modifiers = ts.getModifiers(node);
  return (modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function varDeclKind(flags: ts.NodeFlags): string {
  if (flags & ts.NodeFlags.Const) return 'const';
  if (flags & ts.NodeFlags.Let) return 'let';
  return 'var';
}

function recordSymbol(
  byName: Map<string, ExtractedSymbol>,
  sourceFile: ts.SourceFile,
  name: string,
  kind: string,
  node: ts.Node,
  isExported: boolean,
): void {
  const existing = byName.get(name);
  if (existing) {
    // Un símbolo puede verse más de una vez (ej. declarado y luego
    // re-exportado vía `export { x }`, o `exports.x = x` sobre algo ya
    // declarado) -- nunca se pisa la línea original, solo se sube el flag
    // de exportado si hace falta.
    if (isExported) existing.isExported = true;
    return;
  }
  const { lineStart, lineEnd } = lineRange(sourceFile, node);
  byName.set(name, { name, kind, lineStart, lineEnd, isExported });
}

// --- CommonJS: exports.X / module.exports.X / module.exports = ... -------

/** `exports.X` o `module.exports.X` -> devuelve `X`; cualquier otro shape -> `null`. */
function simpleExportPropertyName(left: ts.Expression): string | null {
  if (!ts.isPropertyAccessExpression(left)) return null;
  if (ts.isIdentifier(left.expression) && left.expression.text === 'exports') {
    return left.name.text;
  }
  if (
    ts.isPropertyAccessExpression(left.expression) &&
    ts.isIdentifier(left.expression.expression) &&
    left.expression.expression.text === 'module' &&
    left.expression.name.text === 'exports'
  ) {
    return left.name.text;
  }
  return null;
}

/** `module.exports` a secas (el objeto completo, para `module.exports = <rhs>`). */
function isModuleExportsWhole(node: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'module' &&
    node.name.text === 'exports'
  );
}

function applyCjsExportAssignment(
  byName: Map<string, ExtractedSymbol>,
  sourceFile: ts.SourceFile,
  stmt: ts.ExpressionStatement,
  expr: ts.BinaryExpression,
): void {
  const propName = simpleExportPropertyName(expr.left);
  if (propName) {
    recordSymbol(byName, sourceFile, propName, 'export', stmt, true);
    return;
  }
  if (!isModuleExportsWhole(expr.left)) return;

  const rhs = expr.right;
  if (ts.isIdentifier(rhs)) {
    // `module.exports = algoYaDeclaradoArriba;` -- sube ese símbolo a
    // exportado en vez de inventar uno nuevo llamado "algoYaDeclarado".
    recordSymbol(byName, sourceFile, rhs.text, 'export', stmt, true);
  } else if (ts.isObjectLiteralExpression(rhs)) {
    for (const prop of rhs.properties) {
      if (ts.isShorthandPropertyAssignment(prop)) {
        recordSymbol(byName, sourceFile, prop.name.text, 'export', prop, true);
      } else if (ts.isPropertyAssignment(prop) && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))) {
        recordSymbol(byName, sourceFile, prop.name.text, 'export', prop, true);
      }
      // spreads (`...otraCosa`) y nombres calculados (`[expr]: ...`) se
      // saltan -- no hay un nombre estático confiable que extraer.
    }
  } else {
    // `module.exports = function() {...}` (anónima), una clase anónima, o
    // cualquier otra expresión sin nombre reconocible -- se registra como
    // el export por defecto del archivo, mismo criterio que
    // `export default <expr-sin-nombre>` en ESM más abajo.
    recordSymbol(byName, sourceFile, 'default', 'export-default', stmt, true);
  }
}

function isCjsExportAssignment(stmt: ts.Statement): stmt is ts.ExpressionStatement & { expression: ts.BinaryExpression } {
  if (!ts.isExpressionStatement(stmt)) return false;
  const expr = stmt.expression;
  return ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.EqualsToken;
}

// --- Extracción principal --------------------------------------------

/**
 * Extrae los símbolos de nivel superior de `content` (ya leído por el
 * caller, ver indexer.ts). `relPath` decide el `ScriptKind` (TS/TSX/JS/
 * JSX) para que el parser interprete JSX/generics correctamente. Nunca
 * lanza: un archivo con sintaxis inválida (ej. a medio editar) devuelve
 * `[]` en vez de romper el reindexado completo.
 */
export function extractSymbols(relPath: string, content: string): ExtractedSymbol[] {
  const scriptKind = scriptKindForPath(relPath);
  if (scriptKind === ts.ScriptKind.Unknown) return [];

  let sourceFile: ts.SourceFile;
  try {
    sourceFile = ts.createSourceFile(relPath, content, ts.ScriptTarget.Latest, false, scriptKind);
  } catch {
    return [];
  }

  const byName = new Map<string, ExtractedSymbol>();

  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      recordSymbol(byName, sourceFile, stmt.name.text, 'function', stmt, hasExportModifier(stmt));
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      recordSymbol(byName, sourceFile, stmt.name.text, 'class', stmt, hasExportModifier(stmt));
    } else if (ts.isInterfaceDeclaration(stmt)) {
      recordSymbol(byName, sourceFile, stmt.name.text, 'interface', stmt, hasExportModifier(stmt));
    } else if (ts.isTypeAliasDeclaration(stmt)) {
      recordSymbol(byName, sourceFile, stmt.name.text, 'type', stmt, hasExportModifier(stmt));
    } else if (ts.isEnumDeclaration(stmt)) {
      recordSymbol(byName, sourceFile, stmt.name.text, 'enum', stmt, hasExportModifier(stmt));
    } else if (ts.isVariableStatement(stmt)) {
      const exported = hasExportModifier(stmt);
      const kind = varDeclKind(stmt.declarationList.flags);
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          recordSymbol(byName, sourceFile, decl.name.text, kind, decl, exported);
        }
      }
    } else if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
      if (ts.isIdentifier(stmt.expression) && byName.has(stmt.expression.text)) {
        const existing = byName.get(stmt.expression.text);
        if (existing) existing.isExported = true;
      } else {
        recordSymbol(byName, sourceFile, 'default', 'export-default', stmt, true);
      }
    } else if (
      ts.isExportDeclaration(stmt) &&
      !stmt.moduleSpecifier &&
      stmt.exportClause &&
      ts.isNamedExports(stmt.exportClause)
    ) {
      // `export { foo, bar as baz }` -- re-exporta símbolos de ESTE
      // archivo (con `moduleSpecifier` sería un re-export de otro módulo,
      // ver el filtro de arriba). Se marca exportado tanto el nombre local
      // (`foo`) como el alias externo si difiere (`baz`) -- una tarea
      // puede mencionar cualquiera de los dos.
      for (const el of stmt.exportClause.elements) {
        const localName = (el.propertyName ?? el.name).text;
        const exportedName = el.name.text;
        const existing = byName.get(localName);
        if (existing) existing.isExported = true;
        if (exportedName !== localName || !existing) {
          recordSymbol(byName, sourceFile, exportedName, 'export', el, true);
        }
      }
    } else if (isCjsExportAssignment(stmt)) {
      applyCjsExportAssignment(byName, sourceFile, stmt, stmt.expression);
    }
  }

  return [...byName.values()];
}
