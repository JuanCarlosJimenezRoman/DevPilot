// Contrato de formato de respuesta — Capa 1 (endurecida tras el Paso 0),
// ver docs/architecture/06-providers-and-browser-bridge.md. Este texto se
// embebe tal cual en cada Context Pack (`responseInstructions`) y en el
// Markdown exportado. Cambios aquí son cambios al contrato real que
// `ChangeParser`/`ChangeValidator` (próxima pieza del Incremento 1) van a
// tener que reconocer — no es solo texto decorativo.
export const RESPONSE_INSTRUCTIONS_ES = [
  'Responde tus cambios usando bloques `<DEVPILOT_CHANGE>`. Para cambios localizados (la mayoría), usa un patch de búsqueda/reemplazo — **no reescribas el archivo completo**:',
  '',
  '```devpilot-change',
  '<DEVPILOT_CHANGE path="ruta/al/archivo.ts" operation="patch">',
  '<<<<<<< SEARCH',
  '(fragmento EXACTO que existe hoy en el archivo, tal cual aparece arriba)',
  '=======',
  '(tu reemplazo)',
  '>>>>>>> REPLACE',
  '</DEVPILOT_CHANGE>',
  '```',
  '',
  'Nota de formato: envuelve SIEMPRE el bloque completo en un fence ```devpilot-change como el de arriba (no lo dejes suelto en Markdown) — una línea compuesta solo de `=` fuera de un fence puede interpretarse como encabezado y perderse al copiar.',
  '',
  'Nota sobre archivos truncados: si un archivo de este Context Pack aparece cortado con un comentario tipo `/* ...(truncado por DevPilot: ~N caracteres omitidos aquí)... */` o `/* DevPilot — Context Compaction: contenido completo omitido... */`, ESE COMENTARIO NO EXISTE EN EL ARCHIVO REAL — es un aviso de DevPilot, no código. Nunca lo copies dentro de un bloque `SEARCH` (el patch va a fallar porque ese texto nunca va a matchear el archivo real). Si tu cambio necesita tocar la parte omitida, decilo en tu respuesta en vez de adivinar su contenido — el usuario puede volver a correr `devpilot context` con `--include <ruta>` para traer ese archivo completo.',
  '',
  'Si necesitas crear un archivo nuevo (por ejemplo una migración), usa `operation="create"` con el contenido completo dentro del mismo tipo de bloque. Si prefieres un formato más libre, también es válido un encabezado `### File: <ruta>` seguido de un fence de código `diff` estándar. Cualquier explicación de tu razonamiento va **fuera** de los bloques `<DEVPILOT_CHANGE>`, nunca mezclada dentro.',
  '',
  '**Obligatorio**: si asumiste cualquier decisión que este Context Pack no confirmó explícitamente — un umbral, un valor por defecto, qué hacer cuando falta información, un nombre de campo nuevo — decláralo en una sección aparte, fuera de cualquier bloque de cambio:',
  '',
  '```',
  '## Decisiones que asumí (no confirmadas por el contexto)',
  '- (cada decisión que tomaste sin que el Context Pack la confirmara)',
  '```',
  '',
  'Si no asumiste ninguna, escribe esa sección igual con "Ninguna". DevPilot no aplica nada automáticamente: cada cambio pasa por un validador y, si declaraste una decisión asumida, tu propuesta se muestra como una opción a revisar, no como un hecho consumado.',
].join('\n');
