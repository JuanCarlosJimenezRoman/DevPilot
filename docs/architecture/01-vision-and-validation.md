# 01 — Visión y validación crítica (Fase A)

> **Estado (2026-09-09):** Juan revisó este documento y el resto de la Fase A-J. Los tres supuestos abiertos quedaron resueltos — ver la sección "Supuestos" al final, y el detalle técnico en 03, 06 y 07.
>
> **El Paso 0 ya se ejecutó** (ver `paso0-context-pack-camino-al-deporte.md`, tarea real: calcular `TamanoPaquete` a partir del carrito). Resultado: **hipótesis central validada** — ambos modelos (DeepSeek, ChatGPT) entendieron el Context Pack reducido y ubicaron los archivos correctos sin explicación adicional. Pero la prueba también reveló, con evidencia real y no hipotética, que **el contrato necesita dos piezas que no estaban explícitas en el diseño original: un `ChangeValidator` (no solo un parser) y una sección de "Decisiones confirmadas vs. abiertas" en el propio Context Pack.** Detalle completo del hallazgo y del rediseño en 06; esto ya está incorporado en el resto de la documentación.

## Resultado del Paso 0 (evidencia real, no hipotética)

```
✅ Context Pack comprensible sin explicación adicional
✅ Ambos modelos ubicaron los archivos correctos con contexto reducido
✅ El contrato DEVPILOT_CHANGE / SEARCH-REPLACE es entendible
⚠️ Los modelos pueden inventar decisiones de negocio no documentadas
   (DeepSeek inventó umbrales de volumen/peso que no estaban en el pack)
⚠️ Un fallback silencioso mal pensado puede colar un riesgo de negocio
   (DeepSeek: dimensiones desconocidas → 0 → clasificado como CHICO)
⚠️ El formato de patch puede salir ligeramente inválido incluso cuando el
   razonamiento es bueno (ChatGPT: marcadores SEARCH/REPLACE mal formados)
```

Conclusión: **ninguna de las dos respuestas debía aplicarse automáticamente tal como vino** — y eso es exactamente lo que el diseño de "nunca aplicar en ambigüedad" (06) está para atrapar. La prueba no solo validó la hipótesis central, también expuso qué necesitaba el `ChangeValidator` para hacer su trabajo de verdad, con casos reales en vez de imaginados.

## El problema real

Hoy, cuando cambias de IA (Claude Code → ChatGPT web → DeepSeek web), pierdes contexto. Cada herramienta reconstruye por su cuenta "qué es este proyecto", y tú pagas ese costo dos veces: en tokens (si usas API) y en tiempo (si lo explicas a mano). DevPilot ataca esto poniendo la memoria y el contexto *fuera* de la IA, en una capa local que cualquier modelo puede consumir.

Esto es un problema real y la propuesta original lo diagnostica bien. La idea central — **"la IA no debe ser la memoria del proyecto, DevPilot debe serlo"** — es la decisión de diseño correcta y todo lo demás debe subordinarse a ella.

## Qué está bien (y no debe negociarse)

- **Local-first.** Nada de esto necesita un servidor. Correcto para v1 y probablemente para siempre en el core.
- **Provider-agnostic + BYOAI.** Es el diferenciador real. Nadie más está construyendo "memoria de proyecto reutilizable entre ChatGPT web, Claude web y DeepSeek web sin automatizar el navegador".
- **Separar tipos de memoria** (Project Knowledge / Project State / Session Memory / Decision Records / Task Context). Esto imita cómo un ingeniero senior organiza el contexto mentalmente. Es una base sólida y NO la simplificaría.
- **Niveles progresivos de contexto** (texto → imports → símbolos → git → semántico opcional). Evita depender de embeddings desde el día uno. Correcto.
- **SQLite + archivos planos**, en vez de una sola base de datos monolítica para todo. Correcto: SQLite para metadata consultable, Markdown/JSON en disco para contenido largo y legible por humanos (y por Git).
- **Reglas anti-sobreingeniería** (nada de vector DB, cloud, k8s, multi-agente complejo en v1). Esto es disciplina, no debe aflojarse.

## Qué es innecesario o debe recortarse para v1

El documento original mezcla **visión del producto** (correcta, a 12-18 meses) con **alcance de v1** (que tal como está descrito es en realidad un v2/v3). Señalo específicamente:

- **Análisis AST/símbolos multi-lenguaje** (Nivel 3) es un proyecto en sí mismo. V1 debe limitarse a TypeScript/JavaScript (que es tu stack real hoy) con extracción de imports por regex/lexer ligero, no un parser AST completo. Symbols de verdad (funciones, clases, exports) puede vivir en incremento 2, no en el primer corte.
- **Cuatro formatos de Context Pack** (clipboard, Markdown, texto, JSON) es redundancia. Ver decisión abajo: solo necesitas un formato canónico interno + un renderer de exportación.
- **Analyze --deep con Claude Code** es valioso pero no debe estar en el primer incremento: agrega una dependencia externa (el CLI de Claude Code) al flujo crítico antes de que el flujo crítico exista.
- **Desktop UI / Electron / Browser Extension** — ya están correctamente pospuestos en el documento original. Lo confirmo: no tocarlos hasta que el CLI funcione end-to-end.
- **Estructura de monorepo completa desde el día 1** (`apps/desktop`, `apps/browser-extension`, `packages/providers`, `packages/context`, `packages/tools`, `packages/browser`, todos como paquetes pnpm separados desde el commit inicial) es fricción prematura: cada paquete nuevo son tsconfig, build, tests y versión propios. Recomiendo empezar con 3 paquetes reales (`core`, `storage`, `shared`) + `apps/cli`, y fragmentar `core` en paquetes nuevos únicamente cuando de verdad duela mantenerlo junto (por ejemplo, cuando aparezca el segundo provider o la segunda UI). El diseño en 02 explica exactamente dónde están esas costuras para que separar después sea barato.

## Qué es riesgoso (y cómo se mitiga)

1. **"Importar la respuesta de la IA" es el punto más frágil de todo el sistema.** Un modelo puede responder con código en cualquier formato: bloques con o sin ruta de archivo, diffs unificados, texto libre mezclado con explicaciones. Si DevPilot intenta "adivinar" un único formato rígido, va a fallar constantemente; si el parser es demasiado permisivo, puede aplicar cambios incorrectos sin que el usuario se dé cuenta.
   **Mitigación (revisada con Juan):** no es un parser único y rígido, son **tres capas** — (1) el Context Pack le pide a la IA un formato recomendado, con una variante "amigable" además de la estructurada; (2) el parser es *tolerante* y reconoce varios formatos de entrada (bloques DevPilot, JSON, Markdown con encabezado de archivo, diff estándar, fences genéricos); (3) si la confianza de interpretación no es alta, **DevPilot nunca aplica nada automáticamente** — muestra la respuesta cruda y pide confirmación manual. Además, cuando la IA propone un parche (no el archivo completo), DevPilot verifica que el fragmento "SEARCH" siga existiendo tal cual en el archivo actual antes de aplicar — si el archivo cambió desde que se generó la respuesta, se marca como no aplicable en vez de sobrescribir a ciegas. Diseño completo en 06. Esto sigue siendo el punto **crítico a validar con una prueba manual real antes de escribir el parser.**

2. **`run_command` (terminal) es la herramienta más peligrosa del sistema.** Un "aprobar/no aprobar" genérico no es suficiente si el comando puede ser `rm -rf` o similar.
   **Mitigación:** en v1, mostrar el comando exacto, pedir confirmación explícita siempre (sin bypass por defecto), y opcionalmente una lista de comandos permitidos/bloqueados configurable por proyecto. Ver 05.

3. **Relevance scoring sin IA puede dar falsos negativos** (archivos relevantes con score bajo porque no comparten texto/nombre). No es resoluble al 100% con heurísticas, y no pasa nada: por eso existe el Nivel 5 (semántico opcional) y por eso el usuario siempre puede añadir archivos manualmente al Context Pack. No prometas precisión perfecta; expón el "por qué" de cada score (ver 04) para que el usuario pueda corregir.

4. **Claude Code como dependencia "opcional pero clave".** Claude Code es en sí un producto en evolución (flags, formatos de salida, políticas de permisos pueden cambiar). Aislarlo completamente detrás de la interfaz `AIProvider` (06) para que un cambio en el CLI de Claude Code no toque el resto del sistema.

## Supuestos — estado tras revisión con Juan (2026-09-09)

- **¿"no depender de ninguna API" incluye a Claude Code?** Resuelto: Claude Code **no es gratis en sentido absoluto** — depende del plan y de sus límites de uso. Se modela como un provider basado en **sesión/plan, no en API pagada por llamada** (`ClaudeCodeProvider.capabilities.requiresApiKey: false`, pero con una nota explícita de que está sujeto a límites de uso — ver 06). El producto nunca debe comunicar esto como "IA gratis e ilimitada".
- **¿DevPilot es multi-proyecto desde el día 1?** Confirmado que sí. Estructura acordada: registro global en `~/.devpilot/` (config, `registry.db`, cache liviano por proyecto) + estado/memoria completos en `<proyecto>/.devpilot/`, de forma que mover el repositorio a otra PC se lleva todo su conocimiento consigo, y el registro global simplemente se re-registra. Detalle completo en 03.
- **¿Qué tan estricto debe ser el contrato de respuesta de la IA?** Resuelto con el diseño de tres capas (formato recomendado + parser tolerante + nunca aplicar en ambigüedad) descrito arriba y detallado en 06. Sigue pendiente el **paso de validación manual** antes de programar: pegar una tarea real (ej. "Camino al Deporte") en DeepSeek Web y Claude Web y observar si respetan el formato, qué tan interpretables son las respuestas, y qué tan tolerante debe ser el parser en la práctica.
- **¿Vale la pena que el primer incremento incluya Git en absoluto?** Confirmado que no. Motivo (razonado por Juan): Git no prueba la hipótesis central del producto (Proyecto → Contexto → IA web → Respuesta → Import → Diff → Apply). Si esa cadena no funciona, ninguna integración con Git la salva; si funciona, ya hay producto. Git pasa a Incremento 3 ("Git Intelligence"). Ver 07.

## Cómo medimos si esto realmente funciona

Desde el primer prototipo, cada tarea registra un pequeño benchmark: tokens de contexto enviados, archivos incluidos vs. realmente usados (los que terminaron con un cambio aplicado), tamaño de la respuesta, cambios importados vs. aplicados, y el resultado final. Esto convierte "ahorramos contexto" de una sensación a una métrica verificable (ej. "de 32k a 8.4k tokens en esta tarea"), y con el tiempo dice si el relevance scoring heurístico es suficiente o si hace falta la capa semántica opcional (Nivel 5). Esquema completo en 03, diseño en 04.

## Formato canónico del Context Pack — decisión

La propuesta original pregunta si hacen falta los cuatro formatos (clipboard, Markdown, texto plano, JSON). Mi recomendación:

- **Canónico interno:** un objeto TypeScript tipado (validado con `zod`), nunca texto. Es lo único que el Context Planner, el compactador y los tests deben conocer.
- **JSON:** serialización de ese objeto para persistencia (`.devpilot/packs/<id>.json`), debugging, y como base para una futura API. No es para pegar en un chat.
- **Markdown:** el único formato de exportación para humanos/IA en v1. Se copia al portapapeles directamente. Un chat web pega Markdown como texto plano sin problema — no gana nada tener un "texto plano" separado, así que **se elimina como formato independiente** (si hace falta alguna vez, es un `stripMarkdown(markdown)` de una línea, no un renderer nuevo).

Esto simplifica el `ContextPackRenderer` a dos funciones: `toJSON()` y `toMarkdown()`.
