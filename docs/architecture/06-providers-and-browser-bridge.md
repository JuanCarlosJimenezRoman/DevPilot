# 06 — Provider Architecture y Browser Bridge (Fases H, I)

## La interfaz `AIProvider`

La interfaz propuesta originalmente era un buen punto de partida pero le faltaba: detección de disponibilidad (¿está instalado/logueado?), cancelación real, y — clave para este proyecto — un provider que represente "un humano pegando en un chat web" como ciudadano de primera clase, no como caso especial.

```ts
interface ProviderCapabilities {
  streaming: boolean;
  toolCalling: boolean;
  requiresApiKey: boolean;
  costModel: 'none' | 'session-plan' | 'metered-api';  // ver nota sobre Claude Code abajo
  supportsSessions: boolean;
  supportsCancellation: boolean;
  maxContextTokens?: number;
}

interface AIRequest {
  sessionId?: string;
  prompt: string;
  contextPack?: ContextPack;
  systemInstructions?: string;
  tools?: ToolDefinition[];
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

type AIEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; name: string; params: unknown }
  | { type: 'tool-result'; name: string; result: unknown }
  | { type: 'error'; error: { message: string; retryable: boolean } }
  | { type: 'done'; usage?: { inputTokens?: number; outputTokens?: number } };

interface AIProvider {
  id: string;
  displayName: string;
  capabilities: ProviderCapabilities;
  isAvailable(): Promise<boolean>;      // feature-detection: ¿binario instalado?, ¿API key presente?
  execute(request: AIRequest): AsyncIterable<AIEvent>;
  cancel?(sessionId: string): Promise<void>;
}
```

## `ManualProvider` — el flujo "pegar en un chat web", formalizado

Este es el provider que hace que el flujo manual (DeepSeek web, Claude web, ChatGPT web) sea un ciudadano de primera clase del sistema, no un atajo fuera de la arquitectura:

- `execute()` no llama a ninguna IA. Renderiza el `ContextPack` a Markdown, lo copia al portapapeles, y emite `done` inmediatamente.
- La respuesta real de la IA llega más tarde, fuera de banda, vía `devpilot import <archivo-o-texto>`.
- `capabilities`: `streaming: false`, `toolCalling: false`, `requiresApiKey: false`.

Esto es deliberado: modelar el caso "sin automatización" como un provider más — no como una rama especial del código — es lo que mantiene el resto del sistema (Context Planner, Tool Engine, sesiones) idéntico sin importar si la IA fue Claude Code, DeepSeek web, o ChatGPT web.

## `ClaudeCodeProvider`

Invoca el binario `claude` instalado localmente vía subprocess, en modo no interactivo:

- Modo `--print`/`-p` con `--output-format stream-json` (o `json` si no se necesita streaming) para obtener salida estructurada y parseable, en vez de texto libre de terminal.
- `--permission-mode` restringido (ej. modo de solo lectura/plan) cuando se usa para `analyze --deep`, ya que el objetivo es que Claude Code *proponga* conocimiento, no que edite archivos directamente sin pasar por el Tool Engine de DevPilot.
- `isAvailable()` verifica que el binario exista en PATH y que haya una sesión válida (ej. `claude --version` o un comando de status), sin fallar el resto de DevPilot si no lo hay.
- Manejo de errores: proceso no encontrado, timeout, salida no parseable, exit code distinto de cero — todos se mapean a eventos `{ type: 'error' }`, nunca excepciones no controladas que tumben el CLI de DevPilot.
- `capabilities`: `toolCalling: true` (Claude Code tiene sus propias herramientas), `requiresApiKey: false`, `costModel: 'session-plan'` (**confirmado con Juan**: usa la sesión/suscripción existente del usuario, no una API pagada por llamada — pero **no es gratis ni ilimitado**, está sujeto a los límites de uso del plan del usuario. El producto nunca debe presentarlo como "IA gratis"; la UI del CLI debe reflejar `costModel` para que el usuario sepa qué está usando), `supportsCancellation: true` (kill del subprocess).

Nota de robustez: los flags exactos del CLI de Claude Code pueden cambiar entre versiones. `ClaudeCodeProvider` debe versionar/validar la salida esperada y fallar de forma explícita y legible (no silenciosa) si el formato cambió, en vez de asumir compatibilidad ciega.

## Providers futuros (no en v1, mismo contrato)

`DeepSeekApiProvider`, `OpenAiApiProvider`: adaptadores HTTP delgados sobre la misma interfaz `AIProvider`, `requiresApiKey: true`, la key vive en `config.json` o variables de entorno del usuario — nunca en el repo. `LocalAiProvider` (Ollama u otro): mismo contrato, `requiresApiKey: false`. Ninguno de estos requiere cambios en Context Engine, Tool Engine o CLI — es exactamente el punto de la abstracción.

## Browser Bridge — arquitectura agnóstica de sitio

La idea original de "no depender del HTML de un sitio específico" es correcta y se resuelve con una observación clave: **el Browser Bridge no necesita saber en qué sitio web estuvo el usuario.** Lo único que necesita es (a) darle al usuario el Context Pack en un formato fácil de pegar, y (b) parsear la respuesta cruda de texto que el usuario pegue de vuelta — y ese parseo depende del **contrato de formato de respuesta** que ya viaja dentro del propio Context Pack (ver 01 y 04), no del sitio de origen.

```ts
interface BrowserBridgeAdapter {
  id: string;                                    // 'clipboard-generic' | 'deepseek-web' | 'claude-web' | ...
  prepareTransfer(pack: ContextPack): TransferPayload;
  parseResponse(raw: string): ParsedResponse;
}

interface TransferPayload {
  text: string;              // Markdown listo para copiar
  copiedToClipboard: boolean;
}

interface ParsedResponse {
  changes: FileChangeProposal[];
  assumedDecisions: string[]; // lo que la IA declaró como decisión propia (ver Capa 1 endurecida, abajo)
  unparsedNotes: string;      // texto que no se pudo mapear a un cambio de archivo, mostrado al usuario tal cual, nunca descartado
}

interface FileChangeProposal {
  path: string;
  operation: 'create' | 'edit' | 'delete' | 'patch';
  format: 'devpilot-block' | 'json' | 'markdown-file' | 'diff' | 'fence-only';
  newContent?: string;        // para create/edit de archivo completo
  diff?: string;               // si la IA respondió en diff unificado
  patch?: SearchReplacePatch;  // para operation='patch' — ver contrato abajo
}

interface SearchReplacePatch {
  search: string;             // fragmento que la IA afirma que existe en el archivo actual
  replace: string;
}
```

**V1 implementa únicamente `ClipboardGenericAdapter`**: funciona igual sin importar si el usuario usó DeepSeek, Claude o ChatGPT, porque no automatiza nada del sitio — copia el pack, y luego parsea lo que el usuario pegue de vuelta según el contrato de formato. Los adapters específicos de sitio (`deepseek-web`, `claude-web`, ...) quedan reservados para una futura extensión de navegador cuya única función sería automatizar el copiar/pegar físico (UX), nunca el parseo — el parseo siempre es responsabilidad del contrato de formato, no del sitio. Esto es justo lo que evita el acoplamiento fràgil que la propuesta original quería evitar.

### El pipeline de import: Parser → Validator, no Parser → Apply (rediseñado tras el Paso 0)

El diseño original conectaba el parser directo al diff/apply. La prueba real del Paso 0 (01) demostró que hace falta una etapa intermedia explícita que audite **lo que el parser entendió**, no solo su forma:

```
                 RESPUESTA DE LA IA
                        │
                        ▼
                 ┌─────────────┐
                 │   PARSER    │   (Capa 2 — reconoce formato, no juzga contenido)
                 └──────┬──────┘
                        ▼
                 FileChangeProposal[]
                        │
                        ▼
                 ┌─────────────┐
                 │  VALIDATOR  │   (nuevo — juzga si es seguro de mostrar/aplicar)
                 └──────┬──────┘
           ┌────────────┼────────────┐
           ▼            ▼            ▼
        VALID        WARNING       REJECT
           │            │            │
           ▼            ▼            ▼
         DIFF      PREGUNTAR AL   SIN ACCIÓN
           │          USUARIO   (se muestra la nota,
           ▼                     nunca se aplica)
        APPLY
```

`ChangeValidator` es un módulo nuevo, explícitamente separado del `ChangeParser` (antes vivían implícitamente juntos en `parseResponse()`). El parser solo reconoce forma; el validador decide si es seguro seguir adelante:

```ts
interface ChangeValidator {
  validate(proposal: FileChangeProposal, projectRoot: string, contextPack: ContextPack): ValidationResult;
}

interface ValidationResult {
  status: 'valid' | 'warning' | 'reject';
  confidence: number;              // 0-100, no solo 'high'/'low'/'ambiguous' — mostrable como barra en el CLI
  checks: ValidationCheck[];
}

interface ValidationCheck {
  name:
    | 'path-exists'                 // ¿la ruta está dentro del proyecto indexado?
    | 'operation-valid'             // ¿create/edit/delete/patch bien formado?
    | 'search-match'                // solo patch: ¿el fragmento SEARCH (con dedent) existe en el archivo actual?
    | 'marker-well-formed'          // ¿los delimitadores <<<<<<</=======/>>>>>>> son reconocibles, con recuperación por prefijo si falta el divisor?
    | 'whole-file-boundary-match'   // solo markdown-file/fence-only sin marcadores de patch: ¿el bloque empieza/termina como el archivo real?
    | 'naming-convention'           // para tipos de archivo con convención propia conocida (ej. migraciones de Prisma)
    | 'undocumented-decision';      // ¿el cambio introduce valores/campos/umbrales que no aparecen en el Context Pack?
  passed: boolean;
  detail?: string;
}
```

*(Ver "Segunda ronda de evidencia" más abajo para el detalle de `whole-file-boundary-match` y `naming-convention` — se añadieron a partir de casos reales, no de diseño especulativo.)*

Los cinco checks se combinan así: cualquier `path-exists`/`operation-valid`/`search-match` fallido → `reject` (no es cuestión de negocio, es que el patch no es aplicable, punto). `marker-well-formed` fallido pero el contenido igual es reconstruible → `warning`, se muestra al usuario con la anomalía señalada en vez de rechazar de plano (ver robustez de marcadores). `undocumented-decision` detectado → siempre `warning`, nunca `reject` automático — porque puede ser una propuesta legítima y útil, solo que no auto-aplicable (ver más abajo).

**El caso `undocumented-decision` es el hallazgo más importante del Paso 0.** DeepSeek propuso umbrales de volumen/peso (`CHICO: 0–5000 cm³`, pesos de 1kg/3kg/7kg) que no aparecían en ningún lado del Context Pack — los inventó. Sin un check para esto, DevPilot habría mostrado ese patch con la misma confianza que un cambio trivial y bien fundamentado. La detección en v1 es **heurística, no semántica** (DevPilot no "entiende" que un umbral es inventado): se marca `undocumented-decision` cuando el cambio introduce (a) un campo nuevo en el esquema de datos (nueva columna/modelo Prisma) que no estaba mencionado en el Context Pack, o (b) literales numéricos nuevos usados como umbral/constante de negocio (heurística simple: número seguido de comparación o en una estructura de rangos) que no aparecen en ningún archivo del pack ni en las restricciones. Es deliberadamente conservador — puede haber falsos positivos — porque el costo de una alerta de más es mucho menor que el de una decisión de negocio colada sin que nadie la revise.

Este mismo check es lo que habría atrapado el problema más serio de la prueba: el fallback silencioso "dimensiones desconocidas → 0 → `CHICO`" de DeepSeek no es un problema de formato de patch, es una decisión de negocio implícita (qué hacer cuando falta información) que nunca se documentó. El Validator no puede "entender" que subestima el costo — pero si el contrato (ver Capa 1 endurecida, abajo) exige que la IA declare sus propios fallbacks como decisión asumida, y el Validator marca cualquier cambio con `assumedDecisions` no vacío como `warning`, el efecto práctico es el mismo: nada de esto se aplica sin que el usuario lo vea explícitamente.

### Segunda ronda de evidencia — se corrió el `ChangeValidator` a mano contra archivos reales

Juan repitió la prueba (mismo Context Pack del Paso 0, todavía sin el contrato endurecido) y esta vez se verificaron las respuestas de ChatGPT y DeepSeek línea por línea contra el contenido real de `backend/src/routes/tienda/envios.js`, `backend/src/routes/envios.js` y `backend/prisma/schema.prisma`. Esto ya no es hipotético — es la lógica del `ChangeValidator` corrida a mano sobre datos reales, y confirmó varias cosas que el diseño anterior no había anticipado con esta precisión.

**Hallazgo A — el divisor `=======` desapareció en TODOS los bloques `SEARCH/REPLACE` de ChatGPT, pero el contenido de `SEARCH` en sí era correcto en la mayoría de los casos.** Al aislar cada fragmento y compararlo contra el archivo real, 5 de los 6 patches a `envios.js`/`routes/envios.js` tenían un `SEARCH` que coincidía **exactamente** con el archivo real (una vez ignorada la indentación) — el problema no fue que el modelo apuntara mal, fue que el separador `=======` se perdió en algún punto del trayecto (la respuesta del chat → el portapapeles → el mensaje pegado). La hipótesis más probable: una línea compuesta solo de `=` inmediatamente debajo de una línea de texto es sintaxis válida de Markdown para un encabezado `H1` estilo Setext — cualquier renderizador/editor Markdown en el camino puede interpretarla como formato y no como texto literal, y perderla al copiar. **Esto es un riesgo de transporte, no de razonamiento del modelo**, y es corregible en el diseño del contrato:

- No usar una línea compuesta solo de `=` (ni de `-`, por la misma razón — es sintaxis de H2 Setext) como divisor suelto.
- Alternativa recomendada: envolver todo el bloque `<DEVPILOT_CHANGE>` en un fence de código explícito (` ```devpilot-change ` … ` ``` `) para que cualquier renderizador Markdown en el camino lo trate como texto literal opaco, no como contenido a interpretar.
- Adicionalmente, el parser implementa una **recuperación heurística** para cuando el divisor no aparece: probar prefijos del bloque de longitud creciente contra el archivo real, y tomar el prefijo exacto más largo que coincida como `SEARCH`, el resto como `REPLACE`. Esto solo se usa para llegar a `warning` (nunca a `valid` directo) — es una recuperación de una ambigüedad de formato, no una confirmación de que el cambio es correcto.

**Hallazgo B — la indentación no sobrevivió el trayecto.** El archivo real usa Prisma con columnas alineadas (`id           Int      @id...`) y el código real de `envios.js` usa indentación de 4 espacios; lo recibido tenía indentación colapsada a un espacio o nula. Refinamiento: `search-match` ya no exige coincidencia byte-a-byte — aplica un *dedent* consistente (recorta la indentación común de todas las líneas del bloque, preservando la indentación relativa entre ellas) antes de comparar. Esto es más permisivo que antes pero sigue siendo estricto sobre el contenido real de cada línea, que es lo que importa para no aplicar algo sobre un archivo que ya cambió.

**Hallazgo C — el caso más peligroso de la prueba no fue de ChatGPT, fue de DeepSeek.** Esta vez DeepSeek no usó el contrato `DEVPILOT_CHANGE` en absoluto (los modelos no garantizan usar el formato recomendado de una sesión a otra — exactamente lo que la Capa 2/3 está diseñada para asumir, no una sorpresa). Presentó el nuevo modelo `ProductoVariante` de `schema.prisma` como un fragmento de código con el comentario `// backend/prisma/schema.prisma` — sin ningún marcador de patch. **Si el parser hubiera asumido "esto reemplaza el archivo completo", habría borrado las otras ~1,700 líneas del esquema real.** Verificado: el fragmento de DeepSeek no coincide ni con la primera línea real del archivo (`// Esquema de base de datos...`) ni con la última (`@@map("pedido_resena_fotos")`), así que un chequeo barato — comparar el inicio/fin del bloque propuesto contra el inicio/fin real del archivo — ya habría bastado para negarse a tratarlo como reemplazo completo. En cambio, el archivo completo que DeepSeek sí reescribió para `envios.js` empieza y termina igual que el original (`const express = require(...)` … `module.exports = router;`), así que ahí sí sería razonable ofrecerlo como reemplazo completo — siempre en `warning`, mostrado como diff línea por línea, nunca aplicado directo.

Esto se formaliza como un nuevo check:

```ts
// se suma a la unión de ValidationCheck.name (arriba)
| 'whole-file-boundary-match'  // solo cuando format es 'markdown-file'/'fence-only' sin marcadores de patch:
                                 // ¿el bloque empieza/termina como el archivo real? si no, no es un archivo completo
                                 // válido — se rechaza como reemplazo total (puede seguir ofreciéndose como
                                 // referencia de solo lectura en unparsedNotes)
| 'naming-convention';          // para tipos de archivo con convención propia conocida por DevPilot (ej. migraciones
                                 // de Prisma: `<timestamp-14-dígitos>_<nombre>/migration.sql`) — el `migration.sql`
                                 // que propuso ChatGPT (`_add_tamano_paquete_producto`, sin timestamp) la rompe;
                                 // resultado: `warning`, no `reject` — el contenido SQL puede ser correcto, solo
                                 // hay que corregir la ruta antes de crear el archivo.
```

**Hallazgo D — el propio modelo a veces admite su incertidumbre en prosa, y hay que mostrarla, no descartarla.** ChatGPT agregó una nota fuera de cualquier bloque: *"el fragmento SEARCH anterior debe sustituirse usando el comentario real existente..."* — básicamente el modelo avisando que no estaba seguro de su propio patch. Esto es exactamente lo que `unparsedNotes` (06) está diseñado para capturar y mostrar tal cual, y confirma que ese campo no es un detalle menor del diseño: en este caso concreto, ignorarlo habría escondido la señal de alerta más honesta que dio el propio modelo.

**Hallazgo E — el riesgo del fallback silencioso vuelve a aparecer, y otra vez fuera del lugar correcto.** DeepSeek volvió a inventar umbrales de volumen/peso (mismo patrón que en la primera ronda) y esta vez sí reconoció el riesgo del fallback ("productos sin dimensiones... resultan en CHICO o MEDIANO") — pero enterrado en una sección de prosa libre ("Consideraciones"), no en el formato estructurado que el contrato endurecido ahora exige (`## Decisiones que asumí`, ver arriba). Confirma que pedirlo en las instrucciones no basta por sí solo — el check heurístico `undocumented-decision` del Validator sigue siendo necesario como respaldo, incluso cuando el modelo sí intenta ser transparente.

### Robustez de marcadores SEARCH/REPLACE (hallazgo original del Paso 0, ChatGPT)

ChatGPT entendió la tarea y el razonamiento de negocio mejor que DeepSeek, pero produjo delimitadores mal formados en algunos bloques (`# <<<<<<< SEARCH` con un comentario delante, `> > > > > > > REPLACE` con espacios de más). La regla de diseño correcta, confirmada por este caso real: **los delimitadores se reconocen con tolerancia (una expresión regular laxa que ignore prefijos de comentario y espacios internos en las flechas), pero el contenido de `SEARCH` se sigue comparando de forma exacta contra el archivo.** Relajar el reconocimiento de la sintaxis del contrato no es lo mismo que relajar la seguridad de la comparación — son responsabilidades distintas y no deben mezclarse. Si el parser no logra ubicar un bloque `SEARCH`/`REPLACE` ni siquiera con esa tolerancia, el cambio se marca `format: 'fence-only'` con confianza baja, nunca se descarta silenciosamente.

### El contrato de formato de respuesta — diseño de tres capas, ahora con una Capa 1 endurecida (revisado con Juan, crítico, ver 01)

No confiamos en que DeepSeek, Claude o ChatGPT obedezcan un formato rígido de forma perfecta y consistente — pero un parser demasiado permisivo puede aplicar cambios incorrectos sin que el usuario lo note. La solución no es un formato único, son tres capas independientes.

**Capa 1 — Formato recomendado en `responseInstructions`.** El Context Pack le pide a la IA responder con bloques estructurados y, cuando el cambio es un fragmento localizado (no un archivo nuevo), con un patch de tipo búsqueda/reemplazo en vez del archivo completo — así la IA no tiene que reescribir archivos grandes enteros, y DevPilot puede verificar antes de aplicar:

```
<DEVPILOT_CHANGE path="src/services/shipping.ts" operation="patch">
<<<<<<< SEARCH
const shippingCost = 200;
=======
const shippingCost = calculateShipping(destino);
>>>>>>> REPLACE
</DEVPILOT_CHANGE>
```

También se acepta una variante más amigable para modelos que prefieren Markdown estándar (encabezado `### File: <ruta>` seguido de un fence ```diff o del archivo completo). Ambas formas son "recomendadas"; ninguna es obligatoria — ver Capa 2.

**Endurecido tras el Paso 0:** el contrato ahora exige además una sección separada, fuera de cualquier bloque `<DEVPILOT_CHANGE>`, donde la IA declare explícitamente sus propias decisiones no confirmadas por el Context Pack — incluyendo valores/umbrales que inventó y **cualquier comportamiento por defecto o fallback que haya decidido para datos faltantes** (el caso concreto que expuso el Paso 0: "si no hay dimensiones, uso 0" es una decisión de negocio, no un detalle de implementación):

```
## Decisiones que asumí (no confirmadas por el contexto)
- Definí los umbrales CHICO/MEDIANO/GRANDE por volumen: ...
- Si un producto no tiene dimensiones configuradas, asumí tamaño CHICO por defecto.
```

Esto se combina con la sección **"Decisiones del negocio: confirmadas vs. abiertas"** que ahora forma parte del propio Context Pack (ver 04) — decirle a la IA de antemano qué está decidido y qué está deliberadamente abierto reduce cuánto necesita inventar en primer lugar, y la sección de arriba captura lo que igual decida asumir.

**Capa 2 — Parser tolerante.** `ClipboardGenericAdapter.parseResponse()` intenta reconocer, en este orden, varios formatos conocidos antes de rendirse: bloques `<DEVPILOT_CHANGE>`, JSON explícito, Markdown con encabezado de archivo, diff unificado estándar, y como último recurso un fence de código genérico cuya primera línea sea una ruta válida del proyecto. Cada `FileChangeProposal` detectado registra qué formato lo produjo (`format`) y con qué confianza (`confidence`). Texto que no calza con ningún patrón (ej. "Claro, aquí está el código...") no rompe nada — se acumula en `unparsedNotes` y se muestra tal cual.

**Capa 3 — El `ChangeValidator` decide, nunca el parser.** Cada `FileChangeProposal` pasa por `ChangeValidator.validate()` (ver arriba) y termina en uno de tres estados:

- **`valid`** — todos los checks estructurales pasan y no hay `undocumented-decision`: se muestra el diff normal y sigue el flujo habitual de aprobación del Tool Engine (05).
- **`warning`** — algo requiere ojos humanos antes de seguir: un marcador mal formado pero reconstruible, o (el caso más importante, validado en el Paso 0) una decisión no documentada. DevPilot **no lo aplica ni lo descarta**: se lo presenta al usuario como una decisión a tomar, con la propuesta de la IA como una opción entre otras posibles — nunca como un hecho consumado. Si el usuario la acepta, es candidata a promoverse a una Decision Record real (Incremento 2) para que la próxima tarea ya no tenga que volver a inventar lo mismo.
- **`reject`** — la ruta no existe, la operación no tiene sentido, o (el caso que ya identificamos en el diseño original) el fragmento `SEARCH` de un patch ya no coincide con el archivo actual — típicamente porque el archivo cambió después de generar el Context Pack. DevPilot no toca el proyecto y muestra por qué se rechazó.

Ningún estado permite aplicar directo: `valid` todavía pasa por la aprobación normal del Tool Engine (05); es solo el punto de partida el que cambia según qué tan confiable resultó el cambio propuesto.

**Esto ya no es un supuesto — es evidencia real.** El Paso 0 (01) demostró exactamente este escenario con dos modelos distintos: ninguna de las dos respuestas debía aplicarse tal cual llegó, y las razones fueron diferentes en cada caso (DeepSeek: decisión no documentada; ChatGPT: marcador mal formado). Ese es el resultado que justifica tener un Validator separado del Parser, no una curiosidad del experimento.
