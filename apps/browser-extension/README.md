# DevPilot Bridge (extensión de navegador)

Incremento 5 del roadmap (`docs/architecture/07-roadmap.md`). Automatiza el
copiar/pegar **físico** entre `devpilot context` y un chat web de IA
(Claude.ai, ChatGPT, DeepSeek Chat) — nada más. El parseo y la validación de
la respuesta siguen siendo trabajo exclusivo de `devpilot import`
(`ChangeParser`/`ChangeValidator`, ver `docs/architecture/06`). Esta
extensión nunca es una dependencia funcional de DevPilot: si falla o no está
instalada, el flujo manual de copiar/pegar de siempre sigue funcionando
exactamente igual.

## Qué hace

En `claude.ai`, `chatgpt.com`/`chat.openai.com` y `chat.deepseek.com`
inyecta un widget flotante ("DP", esquina inferior derecha) con dos botones:

- **📋 Pegar Context Pack**: lee el portapapeles (lo que dejó ahí
  `devpilot context`) y lo inserta en el cuadro de texto del chat. Por
  defecto no envía el mensaje — hay un checkbox "Enviar automáticamente
  (experimental)" para quien quiera saltarse también ese clic, marcado como
  experimental a propósito porque no hay forma confiable de confirmar desde
  fuera del sitio que el envío realmente ocurrió.
- **📥 Copiar última respuesta**: intenta identificar el último mensaje del
  asistente visible en la página y lo copia al portapapeles, listo para
  pegarlo en `devpilot import`.

Si no logra encontrar el cuadro de texto o la respuesta con confianza
razonable, lo dice explícitamente en el widget en vez de adivinar (mismo
criterio de "fallar explícito, nunca silencioso" del resto de DevPilot) — en
ese caso, simplemente copia/pega a mano como siempre.

## Cómo instalarla (modo desarrollador, sin publicar)

1. `pnpm --filter @devpilot/browser-extension build` (o `npm run
   build:extension` desde la raíz del repo) — genera `dist/` a partir de
   `src/`.
2. En Chrome/Edge: `chrome://extensions` → activar "Modo de desarrollador" →
   "Cargar descomprimida" → seleccionar esta carpeta
   (`apps/browser-extension`, la que contiene `manifest.json`).
3. Abrir `claude.ai`, `chatgpt.com` o `chat.deepseek.com` — debería aparecer
   el botón "DP" flotante.

Después de cada cambio en `src/`, hay que volver a correr el build y luego
pulsar "Actualizar" en `chrome://extensions` (o recargar la extensión).

## Estado de validación

Los selectores específicos de cada sitio (`src/adapters/*.ts`) son mejor
esfuerzo: los tres sitios son SPAs de terceros que cambian su HTML sin
aviso, así que cada uno tiene una heurística genérica de respaldo
(`src/core/dom-utils.ts`) que se activa si el selector específico no
encuentra nada.

**Validado en vivo (sesión 11)** contra el DOM real de claude.ai, ChatGPT y
DeepSeek Chat, con sesión logueada en los tres — sin necesitar cargar la
extensión empaquetada: se inyectó el JS ya compilado de `dist/` directo en
pestañas reales vía Claude in Chrome y se ejecutó cada función del adapter
contra el DOM real, insertando y borrando texto de prueba sin llegar nunca
a enviar un mensaje real. Se encontraron y corrigieron selectores que
estaban mal adivinados — el detalle completo está en
`docs/architecture/07-roadmap.md`, sección Incremento 5. En resumen:
composer y botón de envío eran correctos en los tres sitios (con ajustes
menores); el selector de "última respuesta del asistente" estaba mal en
Claude.ai y DeepSeek (corregidos a `[data-perf-row="assistant"]` +
`.standard-markdown`/`.progressive-markdown` en Claude.ai,
`.ds-assistant-message-main-content` en DeepSeek) y era correcto tal cual en
ChatGPT.

**Lo único que sigue sin validarse, y no se puede automatizar de forma
remota**: cargar la extensión descomprimida de verdad en `chrome://extensions`
(el diálogo nativo no es accesible por automatización) y confirmar que el
botón "Copiar última respuesta" escribe al portapapeles con un clic físico
real — la Clipboard API exige foco real de documento a nivel de sistema
operativo, algo que una pestaña controlada por automatización nunca tiene
("Document is not focused"). El código ya maneja ese caso explícito (mensaje
de error accionable en vez de fallar en silencio), pero confirmar el camino
feliz de punta a punta necesita que alguien lo pruebe con la extensión
cargada de verdad. Si eso funciona, este incremento queda cerrado sin
necesitar más cambios de código.

## Por qué no hay bundler

Los `content_scripts` de `manifest.json` listan varios archivos `.js` que
Chrome ejecuta en orden dentro del mismo "mundo aislado" del content
script — comparten el mismo scope global sin necesidad de módulos ES ni
bundler. Cada `.ts` en `src/` se compila así (sin `import`/`export`,
`"module": "none"` en `tsconfig.json`) a un `.js` global independiente;
`registry.ts` expone `window.__devpilotBridge` y cada adapter se
autoregistra ahí al cargar. Evita sumar una dependencia de build nueva
(esbuild/webpack/etc.) para algo de este tamaño — mismo criterio que
`GitAdapter`/`clipboard.ts` en el resto del proyecto: no widgetear sin un
consumidor real que lo justifique.
