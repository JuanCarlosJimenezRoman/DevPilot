import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ContextPack, FileChangeProposal, ValidationCheck, ValidationResult } from '@devpilot/shared';
import { safeReadTextFile } from './fileReading.js';
import { dedentTolerantIncludes } from './matching.js';
import { detectUndocumentedDecision } from './undocumentedDecision.js';

// ChangeValidator — Capa 3 del contrato de tres capas (ver 06). El parser
// solo reconoce forma; esto decide si es seguro seguir adelante. Nunca pasa
// directo a `apply`: valid/warning/reject, siempre con checks explicables.

const PRISMA_MIGRATION_NAME_RE = /prisma\/migrations\/(\d{14})_[^/]+\/migration\.sql$/;

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

function checkPathExists(proposal: FileChangeProposal, projectRoot: string): ValidationCheck {
  const absPath = path.resolve(projectRoot, proposal.path);
  const withinProject = absPath === path.resolve(projectRoot) || absPath.startsWith(path.resolve(projectRoot) + path.sep);

  if (!withinProject) {
    return { name: 'path-exists', passed: false, detail: `La ruta cae fuera del proyecto: ${proposal.path}` };
  }
  if (proposal.operation === 'create') {
    // No se exige que ya exista — sí que la ruta caiga dentro del proyecto (ya verificado arriba).
    return { name: 'path-exists', passed: true };
  }
  const exists = existsSync(absPath) && statSync(absPath).isFile();
  return {
    name: 'path-exists',
    passed: exists,
    detail: exists ? undefined : `El archivo no existe en el proyecto: ${proposal.path}`,
  };
}

function checkOperationValid(proposal: FileChangeProposal): ValidationCheck {
  if (proposal.operation === 'patch' && !proposal.patch) {
    return {
      name: 'operation-valid',
      passed: false,
      detail: 'operation="patch" pero no se pudo reconocer un bloque SEARCH/REPLACE.',
    };
  }
  if ((proposal.operation === 'create' || proposal.operation === 'edit') && !proposal.newContent && !proposal.diff) {
    return {
      name: 'operation-valid',
      passed: false,
      detail: `operation="${proposal.operation}" pero no hay contenido para aplicar.`,
    };
  }
  return { name: 'operation-valid', passed: true };
}

function checkSearchMatch(proposal: FileChangeProposal, projectRoot: string): ValidationCheck | null {
  if (proposal.operation !== 'patch' || !proposal.patch) return null;

  const absPath = path.resolve(projectRoot, proposal.path);
  if (!existsSync(absPath)) {
    return { name: 'search-match', passed: false, detail: 'El archivo no existe — no hay contra qué comparar SEARCH.' };
  }
  const fileContent = safeReadTextFile(absPath);
  if (fileContent === null) {
    return { name: 'search-match', passed: false, detail: 'No se pudo leer el archivo real (¿binario o demasiado grande?).' };
  }
  const matched = dedentTolerantIncludes(proposal.patch.search, fileContent);
  return {
    name: 'search-match',
    passed: matched,
    detail: matched
      ? undefined
      : 'El fragmento SEARCH no coincide con el contenido actual del archivo — probablemente cambió desde que se generó el Context Pack.',
  };
}

function checkMarkerWellFormed(proposal: FileChangeProposal): ValidationCheck | null {
  if (proposal.operation !== 'patch' || !proposal.patch) return null;
  const wellFormed = proposal.patch.markerOrigin === 'markers';
  return {
    name: 'marker-well-formed',
    passed: wellFormed,
    detail: wellFormed
      ? undefined
      : 'El divisor ======= no apareció en la respuesta; DevPilot reconstruyó el corte SEARCH/REPLACE probando el prefijo más largo que coincide con el archivo real (ver 06) — revisa el patch antes de aplicar.',
  };
}

function checkWholeFileBoundaryMatch(proposal: FileChangeProposal, projectRoot: string): ValidationCheck | null {
  const isWholeFileFormat = proposal.format === 'markdown-file' || proposal.format === 'fence-only';
  if (!isWholeFileFormat || proposal.patch || proposal.newContent === undefined) return null;

  const absPath = path.resolve(projectRoot, proposal.path);
  if (!existsSync(absPath)) {
    // archivo nuevo — no hay límites reales contra qué comparar, no aplica el riesgo de sobreescritura parcial
    return { name: 'whole-file-boundary-match', passed: true };
  }

  const realContent = (safeReadTextFile(absPath) ?? '').replace(/\r\n/g, '\n').trim();
  const proposedContent = proposal.newContent.replace(/\r\n/g, '\n').trim();
  if (realContent.length === 0) {
    return { name: 'whole-file-boundary-match', passed: true };
  }

  const boundaryLen = 80;
  const matchesStart = proposedContent.slice(0, boundaryLen) === realContent.slice(0, boundaryLen);
  const matchesEnd = proposedContent.slice(-boundaryLen) === realContent.slice(-boundaryLen);
  const passed = matchesStart && matchesEnd;

  return {
    name: 'whole-file-boundary-match',
    passed,
    detail: passed
      ? undefined
      : 'El bloque no empieza ni termina como el archivo real — no parece un reemplazo de archivo completo válido; aplicarlo tal cual podría borrar el resto del archivo (ver 06, Hallazgo C del Paso 0).',
  };
}

function checkNamingConvention(proposal: FileChangeProposal): ValidationCheck | null {
  const normalized = normalizePath(proposal.path);
  if (proposal.operation !== 'create' || !normalized.includes('prisma/migrations/')) return null;

  const ok = PRISMA_MIGRATION_NAME_RE.test(normalized);
  return {
    name: 'naming-convention',
    passed: ok,
    detail: ok
      ? undefined
      : 'Las migraciones de Prisma van en `prisma/migrations/<timestamp-14-dígitos>_<nombre>/migration.sql` — corrige la ruta antes de crear el archivo (ver 06).',
  };
}

function checkUndocumentedDecision(proposal: FileChangeProposal, contextPack: ContextPack): ValidationCheck {
  const result = detectUndocumentedDecision(proposal, contextPack);
  return { name: 'undocumented-decision', passed: !result.detected, detail: result.detail };
}

// Cualquiera de estos fallando es un problema estructural — el patch no es
// aplicable, no es una cuestión de revisión de negocio.
const REJECT_ON_FAIL = new Set(['path-exists', 'operation-valid', 'search-match', 'whole-file-boundary-match']);
// Estos requieren ojos humanos pero pueden ser propuestas legítimas.
const WARNING_ON_FAIL = new Set(['marker-well-formed', 'naming-convention', 'undocumented-decision']);

function computeStatusAndConfidence(checks: ValidationCheck[]): { status: ValidationResult['status']; confidence: number } {
  const failedReject = checks.filter((c) => REJECT_ON_FAIL.has(c.name) && !c.passed);
  const failedWarning = checks.filter((c) => WARNING_ON_FAIL.has(c.name) && !c.passed);

  if (failedReject.length > 0) return { status: 'reject', confidence: 5 };
  if (failedWarning.length > 0) return { status: 'warning', confidence: Math.max(20, 85 - failedWarning.length * 25) };
  return { status: 'valid', confidence: 95 };
}

/** Evalúa un `FileChangeProposal` ya reconocido por el parser y decide si es seguro mostrarlo/aplicarlo. Nunca aplica nada — solo clasifica. */
export function validateChange(
  proposal: FileChangeProposal,
  projectRoot: string,
  contextPack: ContextPack,
): ValidationResult {
  const checks: ValidationCheck[] = [
    checkPathExists(proposal, projectRoot),
    checkOperationValid(proposal),
    checkSearchMatch(proposal, projectRoot),
    checkMarkerWellFormed(proposal),
    checkWholeFileBoundaryMatch(proposal, projectRoot),
    checkNamingConvention(proposal),
    checkUndocumentedDecision(proposal, contextPack),
  ].filter((c): c is ValidationCheck => c !== null);


  let { status, confidence } = computeStatusAndConfidence(checks);

  // `fence-only` es el último recurso del parser (06, Capa 2) — un fence
  // de código genérico que ni siquiera trae marcadores de patch, solo una
  // ruta plausible en su primera línea. Aunque pase todos los checks
  // estructurales, la certeza de que de verdad es un cambio de archivo (y
  // no, por ejemplo, un fragmento ilustrativo dentro de la explicación de
  // la IA) es inherentemente baja — nunca se considera `valid` sin ojos
  // humanos.
  if (proposal.format === 'fence-only' && status === 'valid') {
    status = 'warning';
    confidence = Math.min(confidence, 60);
  }

  return { status, confidence, checks };
}
