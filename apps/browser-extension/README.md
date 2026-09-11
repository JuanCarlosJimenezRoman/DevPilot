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

## Estado de validación — pendiente de prueba real (igual que cada incremento anterior)

Los selectores específicos de cada sitio (`src/adapters/*.ts`) son mejor
esfuerzo: los tres sitios son SPAs de terceros que cambian su HTML sin
aviso, así que cada uno tiene una heurística genérica de respaldo
(`src/core/dom-utils.ts`) que se activa si el selector específico no
encuentra nada. Esto compila y lintea limpio (`tsc`/`eslint`), pero —
siguiendo el mismo patrón que Incremento 4 (sesión 8 solo con mocks, sesión
9 validado de punta a punta por Juan contra Claude Code real) — **todavía
no se probó contra los sitios reales**, porque cargar una extensión
descomprimida requiere el diálogo nativo "Cargar descomprimida" de Chrome,
que no es automatizable de forma remota.

Pendiente para la próxima sesión (o para Juan directamente): cargarla en
Chrome y probar los dos botones en los tres sitios, una sesión logueada por
sitio. Si algún selector específico falla, lo más probable es que la
heurística genérica de respaldo lo compense (aunque de forma menos precisa)
— y si ni así funciona, el widget debe decirlo explícitamente en vez de
fallar en silencio. Cualquier selector roto encontrado en esa prueba real es
un ajuste puntual en el adapter correspondiente, no un rediseño.

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
