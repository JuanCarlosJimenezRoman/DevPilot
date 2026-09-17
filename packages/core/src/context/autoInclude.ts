import type { ProjectFileEntry } from '../project/fileWalker.js';

// Auto-inclusión del Context Planner (sesión 14, "uso real" ronda 1 — ver
// arquitectura-v1-resumen.md). Dos bugs reales encontrados usando DevPilot
// de verdad contra Camino al Deporte, ambos con el mismo síntoma de fondo
// ("la IA no tenía el archivo que de verdad necesitaba, aunque el pack se
// viera razonable"), y la misma solución: garantizar inclusión igual que
// `--include` manual (score 100, nunca truncado — ver contextPackBuilder.ts
// e `isExplicitInclude` ahí), pero detectado automáticamente para que el
// usuario no tenga que saber de antemano que hace falta pedirlo a mano.

// Carpetas donde tiene sentido buscar un archivo de "rutas" de backend —
// acota la búsqueda de `detectRelatedBackendFiles` para no matchear por
// casualidad un archivo de frontend que se llame igual (ej. un componente
// `Reportes.tsx` no debería contar como "ruta de backend de reportes").
//
// Debe ser el nombre del directorio PADRE INMEDIATO del archivo candidato
// (ver `isDirectChildOfRouteDir` más abajo) — no alcanza con que la ruta
// "contenga" alguno de estos nombres en cualquier punto. Bug real
// encontrado en sesión 2026-09-17 contra Camino al Deporte, refactor de
// `configuracion/page.tsx`: con el chequeo viejo (`ruta.includes('/routes/')`
// en cualquier parte), `backend/src/routes/tienda/configuracion.js` —un
// endpoint público de envíos del checkout, DENTRO de una subcarpeta
// `tienda/` que a su vez está dentro de `routes/`— calificaba igual que
// `backend/src/routes/reportes.js` (archivo de dominio de primer nivel), y
// como su nombre de archivo (`configuracion.js`) coincidía exacto con el
// dominio del frontend (`configuracion`), se auto-incluía con toda
// confianza (100%, marcado como auto-detectado) siendo el archivo
// INCORRECTO — mientras que el que de verdad hacía falta,
// `backend/src/routes/configuracionTienda.js` (nombre distinto al dominio,
// por eso nunca matcheaba por nombre), se quedaba sin forzar y compactado a
// firmas, exactamente el problema original que este archivo entero existe
// para resolver. Confirmado por Juan leyendo el código real de ambos
// archivos y el router de Express (`backend/src/index.js`) antes de
// reportarlo — no es una suposición.
const BACKEND_ROUTE_DIR_HINTS = ['routes', 'controllers', 'api'];

export interface AutoIncludeMatch {
  relPath: string;
  detail: string;
}

/**
 * Bug real #1: el archivo que el usuario pide refactorizar explícitamente
 * en el texto de la tarea (`devpilot context "Necesito refactorizar el
 * siguiente archivo: <ruta completa>..."`, que es como el propio flujo de
 * uso real arma la tarea) puede perder el ranking de Nivel 1 contra
 * archivos con más superposición de keywords genéricos de la plantilla +
 * boost de recencia en Git, y quedar totalmente AFUERA del Context Pack —
 * no truncado, ausente. Confirmado inspeccionando un Context Pack real
 * contra Camino al Deporte (tarea de refactor de `metodos-pago/page.tsx`)
 * donde el archivo objetivo ni siquiera aparecía en la lista de candidatos,
 * y por eso `devpilot import` no tenía nada real contra qué generar un
 * patch.
 *
 * Esta función detecta cualquier ruta de archivo del proyecto que aparezca
 * mencionada completa (cualquier separador `/`/`\`, cualquier
 * mayúscula/minúscula) en el texto de la tarea, y la trata igual que
 * `--include <ruta>` manual — mismo mecanismo ya construido y probado
 * (relevancePlanner.ts la sube a score 100; contextPackBuilder.ts nunca la
 * trunca), solo que detectado solo, sin que el usuario tenga que saberlo de
 * antemano.
 */
export function detectExplicitFileMentions(files: ProjectFileEntry[], taskText: string): AutoIncludeMatch[] {
  const normalizedText = taskText.replace(/\\/g, '/').toLowerCase();
  const matches: AutoIncludeMatch[] = [];
  for (const file of files) {
    const relLower = file.relPath.toLowerCase();
    // Exige al menos una carpeta real antes del nombre de archivo y un
    // mínimo de longitud — evita que un nombre corto y genérico (ej.
    // "index.ts", "utils.ts") matchee por casualidad contra prosa suelta de
    // la tarea que no lo esté nombrando de verdad.
    if (!relLower.includes('/')) continue;
    if (relLower.length < 12) continue;
    if (normalizedText.includes(relLower)) {
      matches.push({
        relPath: file.relPath,
        detail: 'el archivo aparece mencionado con su ruta completa en el texto de la tarea (auto-detectado)',
      });
    }
  }
  return matches;
}

/**
 * Bug real #2, más sistemático: en los Context Packs reales inspeccionados
 * (refactors de `resenas`, `reportes`, `proveedores` y `metodos-pago` contra
 * Camino al Deporte), NINGUNO incluyó jamás el archivo de rutas de backend
 * del MISMO dominio que la página de frontend a refactorizar — en cambio,
 * todos arrastraban siempre `productos.js`/`ventas.js` (los archivos más
 * tocados recientemente en el repo), por boost de recencia + superposición
 * de las mismas palabras genéricas de la plantilla de tarea ("dashboard",
 * "admin", "aplicar", "patrón"...). Confirmado que esto produjo al menos una
 * alucinación real de endpoints de backend inexistentes en la tarea de
 * `reportes` (ver arquitectura-v1-resumen.md).
 *
 * En Camino al Deporte (y es razonable esperar que en cualquier proyecto
 * con esta separación frontend/backend) el nombre de archivo de rutas
 * coincide con el nombre de la carpeta de dominio del frontend
 * (`dashboard/reportes/` → `routes/reportes.js`, `dashboard/proveedores/` →
 * `routes/proveedores.js`). No es infalible — dos casos reales confirmados
 * donde NO alcanza con el nombre y sigue haciendo falta `--include` manual:
 * (a) una página que combina varios dominios de backend en un solo archivo
 * de rutas que no comparte nombre con ninguno (`metodos-pago`, que junta
 * cuentas de transferencia + proveedores + config de tienda), y (b) un
 * dominio de frontend cuyo archivo de rutas real tiene un nombre DISTINTO
 * al dominio (`configuracion/page.tsx` → el archivo real es
 * `configuracionTienda.js`, no `configuracion.js` — ver sesión 2026-09-17).
 * En el caso (b) además hay que tener cuidado de no matchear por casualidad
 * un archivo de OTRO dominio que sí se llame igual al dominio buscado pero
 * viva anidado en una subcarpeta no relacionada — de ahí que
 * `isDirectChildOfRouteDir` exija que el candidato sea hijo directo de una
 * carpeta de rutas, no que la ruta simplemente "contenga" el nombre en
 * cualquier punto (ver comentario de `BACKEND_ROUTE_DIR_HINTS` arriba).
 * Cuando el archivo existe, es hijo directo de una carpeta de rutas, y su
 * nombre coincide exacto con el dominio, es una señal casi gratis que antes
 * se perdía siempre.
 */
export function detectRelatedBackendFiles(files: ProjectFileEntry[], frontendRelPaths: string[]): AutoIncludeMatch[] {
  const matches: AutoIncludeMatch[] = [];
  const seen = new Set<string>();

  for (const frontendRelPath of frontendRelPaths) {
    const domain = extractDomainSegment(frontendRelPath);
    if (!domain) continue;

    const candidateNames = candidateBackendNames(domain);
    for (const file of files) {
      if (seen.has(file.relPath)) continue;

      if (!isDirectChildOfRouteDir(file.relPath)) continue;

      const base = file.relPath.split('/').pop() ?? '';
      const baseNoExt = base.replace(/\.[^.]+$/, '').toLowerCase();
      if (!candidateNames.has(baseNoExt)) continue;

      seen.add(file.relPath);
      matches.push({
        relPath: file.relPath,
        detail: `archivo de rutas de backend del mismo dominio que ${frontendRelPath}, auto-detectado por nombre de archivo`,
      });
    }
  }

  return matches;
}

/**
 * `true` si `relPath` vive directamente dentro de una carpeta llamada
 * `routes`/`controllers`/`api` (`BACKEND_ROUTE_DIR_HINTS`) — es decir, el
 * nombre del directorio PADRE INMEDIATO es exactamente uno de esos nombres,
 * no simplemente "en algún punto de la ruta". Ver el comentario de
 * `BACKEND_ROUTE_DIR_HINTS` para el bug real (sesión 2026-09-17) que motivó
 * este chequeo más estricto en vez de un `includes()` sobre toda la ruta.
 */
function isDirectChildOfRouteDir(relPath: string): boolean {
  const segments = relPath.split('/');
  if (segments.length < 2) return false;
  const parentDir = segments[segments.length - 2]?.toLowerCase() ?? '';
  return BACKEND_ROUTE_DIR_HINTS.includes(parentDir);
}

/**
 * Extrae el segmento de "dominio" de una página de dashboard, ej.
 * `frontend/src/app/(admin)/dashboard/reportes/page.tsx` → `reportes`;
 * `.../dashboard/productos/[id]/page.tsx` → `productos` (sube un nivel más
 * si el segmento inmediato es un parámetro dinámico de Next.js entre
 * corchetes). `null` si la ruta no es un archivo `page.*` de este tipo de
 * estructura — no hay nada razonable que adivinar para otros archivos.
 */
function extractDomainSegment(relPath: string): string | null {
  const segments = relPath.split('/');
  const fileIdx = segments.length - 1;
  if (!/^page\.(tsx?|jsx?)$/.test(segments[fileIdx] ?? '')) return null;

  let domainIdx = fileIdx - 1;
  if (domainIdx < 0) return null;
  if (/^\[.+\]$/.test(segments[domainIdx] ?? '')) domainIdx -= 1; // ej. [id]
  if (domainIdx < 0) return null;

  const domain = segments[domainIdx];
  if (!domain || /^\(.+\)$/.test(domain)) return null; // ej. (admin) — grupo de rutas de Next.js, no un dominio
  return domain;
}

/**
 * Nombres de archivo candidatos (sin extensión, minúsculas) para un dominio
 * de frontend — cubre las variantes de convención de nombre que ya usa el
 * propio proyecto real (kebab-case tal cual, y sin guiones/camelCase para
 * dominios como "metodos-pago").
 */
function candidateBackendNames(domain: string): Set<string> {
  const kebab = domain.toLowerCase();
  const noHyphens = kebab.replace(/-/g, '');
  return new Set([kebab, noHyphens]);
}
