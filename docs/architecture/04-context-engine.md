# 04 — Context Engine en detalle (Fase F)

## Scanner

Recorre el árbol de archivos respetando `.gitignore` y un `.devpilotignore` adicional. Para cada archivo detecta lenguaje por extensión. A nivel de proyecto detecta, por heurísticas sobre archivos de configuración (no IA):

| Señal | Cómo se detecta |
|---|---|
| Package manager | presencia de `pnpm-lock.yaml` / `package-lock.json` / `yarn.lock` / `bun.lockb` |
| Framework | dependencias en `package.json` + archivos de config (`next.config.*`, `nest-cli.json`, etc.) |
| ORM / base de datos | `prisma/schema.prisma`, `drizzle.config.*`, variables `DATABASE_URL` en `.env.example` |
| Docker | `Dockerfile`, `docker-compose*.yml` |
| Git | existencia de `.git/` |

El resultado es el **Project Snapshot** (tipo `ProjectSnapshot`, ver 02), versionado y regenerable en cualquier momento — nunca se asume válido para siempre.

## Indexer

Construye la tabla `files` (hash + metadata). Para TypeScript/JavaScript (único alcance real en v1, ver 01), extrae imports con un lexer ligero (no un AST completo) y llena `file_edges`. La extracción de `symbols` (funciones/clases/exports reales vía AST) se activa en incremento 2 detrás de una bandera, para no pagar ese costo de parsing en el primer corte.

Reindexado incremental: si `project_state.last_indexed_commit` coincide con el commit actual, no se reescanea nada. Si cambió, `git diff --name-status <last>..HEAD` da la lista exacta de archivos a reindexar. Esto es lo que hace viable usar DevPilot en repos grandes sin re-escanear todo en cada comando — pero, de nuevo, es incremento 2 (ver 07); v1 puede reindexar todo el árbol cada vez sin drama en proyectos de tamaño normal.

## Project Knowledge

Documentos Markdown en `.devpilot/knowledge/`, indexados en `knowledge_docs`. Tres orígenes posibles:

- `manual` — el usuario los edita directamente.
- `inferred` — DevPilot los genera a partir de heurísticas del Scanner (ej. "este proyecto usa Next.js + Prisma + PostgreSQL").
- `deep-analysis` — propuestos por Claude Code vía `analyze --deep` (incremento 3).

Importante: un análisis profundo **nunca sobreescribe silenciosamente** un knowledge doc existente. Propone un diff; el usuario aprueba (es una operación `WRITE`, pasa por el Tool Engine igual que cualquier otra escritura).

## Project State

Lo "efímero pero necesario": último commit indexado, último commit analizado en profundidad, timestamp del último scan. Siempre regenerable, nunca es fuente de verdad del negocio — a diferencia de Knowledge y Decisions, que si se pierden, se pierde conocimiento real.

## Session Memory

Una sesión = una invocación conceptual de trabajo (puede abarcar varios comandos CLI). Se guarda un resumen corto en SQLite (`sessions`) y el detalle turno-a-turno en un `.jsonl` en disco (barato de escribir append-only, no requiere schema rígido). Es memoria de corto plazo: relevante mientras se trabaja en la tarea, candidata a "promoverse" a una Decision Record si algo importante se decidió.

## Decision Records

Formato tipo ADR liviano: título, contexto, decisión, consecuencias, estado. Se crean explícitamente (`devpilot decide "..."`) o DevPilot puede sugerir crear una al cerrar una sesión donde detecta lenguaje de decisión (heurística simple por palabras clave — no obligatorio ni bloqueante). Estas sí son memoria de largo plazo: sobreviven a cualquier sesión futura y se incluyen en el Context Pack cuando son relevantes a la tarea actual.

## Context Planner — niveles progresivos

```
Nivel 1  Búsqueda textual        → keywords de la tarea vs. contenido indexado (ripgrep)
Nivel 2  Grafo de imports         → expande 1-2 saltos desde los archivos del Nivel 1
Nivel 3  Símbolos / AST           → refina: ¿el archivo EXPORTA algo que coincide, o solo lo menciona?  [incremento 2]
Nivel 4  Git / cambios recientes  → boost a archivos tocados recientemente o en commits con mensajes afines [incremento 2]
Nivel 5  Semántico opcional       → la IA re-rankea un candidate set YA acotado (nunca el repo completo) [opcional, apagado por defecto]
```

Cada nivel solo *refina* el conjunto de candidatos del nivel anterior; nunca vuelve a analizar el proyecto entero. El Nivel 5 es explícitamente opt-in porque es el único que cuesta tokens/dinero — todo lo demás es determinístico y gratis.

## Relevance Scoring

Score 0-100 por archivo, suma ponderada y **explicable**:

```
score = w1·textMatch + w2·importDistance + w3·pathNameMatch + w4·gitRecency + w5·symbolMatch
```

Cada score se acompaña de sus `RelevanceReason[]` (ver 02) — el usuario puede ver *por qué* `Pedido.ts` obtuvo 98% y `Usuario.ts` obtuvo 8%, y corregir manualmente agregando/quitando archivos del pack si el algoritmo se equivocó. Los pesos (`w1..w5`) viven en `.devpilot/config.json`, no hardcodeados — se espera iterarlos con uso real.

No se promete precisión perfecta: es un scorer heurístico v1, deliberadamente simple, con un mecanismo de override manual siempre disponible.

## Token Estimation

Aproximación rápida (no se requiere el tokenizer exacto de cada proveedor — proveedores distintos tokenizan distinto, y v1 no necesita esa precisión): estimación tipo `caracteres / 4` o una librería ligera de aproximación BPE. Clasificación configurable:

```
🟢 recomendable   < 4,000 tokens estimados
🟡 alto           4,000–12,000
🔴 innecesariamente grande  > 12,000
```

Umbrales en `config.json`, ajustables por proyecto/proveedor.

## Context Compaction

Estrategias para cuando el pack se pasa de verde/amarillo, en orden de aplicación:

1. Para archivos de score bajo-medio, incluir solo firmas/exports en vez del archivo completo (requiere símbolos — incremento 2; en v1 esto se resuelve simplemente truncando o excluyendo el archivo, con aviso al usuario).
2. Deduplicar conocimiento ya incluido en un pack previo de la misma sesión.
3. Cortar por umbral de relevancia (top-N) en vez de incluir todo lo que superó el Nivel 2.

## Context Pack — construcción final

`ContextPackBuilder` combina: Project Knowledge relevante + Project State resumido + Session Memory relevante + Decision Records relevantes + archivos seleccionados + la tarea del usuario + **Decisiones del negocio: confirmadas vs. abiertas** (ver abajo, nuevo tras el Paso 0) + **instrucciones de formato de respuesta** (el contrato de tres capas descrito en 06, indispensable para que `devpilot import` funcione después). Esto produce el objeto `ContextPack` (tipo completo en 02), que se serializa a Markdown para copiar/pegar y a JSON para persistencia — siempre guardado en `.devpilot/context/`, nunca solo mostrado en pantalla, para poder auditar después "qué sabía la IA cuando propuso este cambio".

Nota: en el Incremento 1 (ver 07), Project Knowledge, Session Memory y Decision Records todavía no existen como tal — el pack se arma solo con Project State + archivos seleccionados + la tarea + Decisiones confirmadas/abiertas (que en este incremento el usuario escribe a mano al redactar la tarea, ver abajo). Las tablas de memoria persistente se activan en el Incremento 2.

## Decisiones del negocio: confirmadas vs. abiertas (añadido tras el Paso 0)

El Paso 0 (01) mostró que cuando el Context Pack no dice explícitamente qué ya está decidido, la IA tiende a inventar — y a veces esas invenciones son numéricamente arbitrarias (umbrales de volumen/peso) o riesgosas (un fallback que subestima un costo). La corrección de diseño es barata: el `ContextPackBuilder` incluye siempre una sección con dos listas.

```markdown
## Decisiones del negocio

### Confirmadas
- Nunca bloquear la compra por falta de cobertura de envío.
- El pedido congela el precio/tarifa al crearse, nunca se recalcula después.

### Abiertas (la IA puede proponer, no debe asumir como definitivo)
- Método exacto para determinar el tamaño de paquete a partir del carrito.
- ¿El tamaño pertenece a Producto o a ProductoVariante?
```

- **Confirmadas** se llena, a partir del Incremento 2, desde `decisions` (Decision Records) relevantes a la tarea. En el Incremento 1, antes de que exista esa tabla, el usuario puede escribir un puñado de restricciones conocidas junto con la tarea (tal como se hizo a mano en el Paso 0) — no bloquea el flujo, solo reduce su efectividad si se omite.
- **Abiertas** son huecos que el propio Context Planner puede detectar heurísticamente (ej. la tarea menciona un concepto — "tamaño de paquete" — que no aparece definido en ningún archivo/símbolo relevante ni en Project Knowledge) y complementar con lo que el usuario quiera aclarar a mano.
- Ambas listas se guardan en `context_pack_decisions` (ver 03) para poder auditar después qué sabía la IA de antemano, y para que una "abierta" que el usuario resuelva al revisar una propuesta pueda promoverse a una Decision Record real (cerrando el ciclo con Project Memory, Incremento 2).

Esta sección no reemplaza al `ChangeValidator` (06) — lo complementa. Decirle a la IA de antemano qué está decidido reduce cuánto necesita inventar; el Validator sigue existiendo para atrapar lo que decida inventar de todos modos.

## Medición: convertir "ahorramos contexto" en un número (Fase A, punto de Juan)

Cada Context Pack generado queda asociado a un `task_benchmarks` (esquema en 03) que registra: tokens de contexto enviados, archivos incluidos, archivos realmente usados (los que terminaron con al menos un cambio aplicado — se infiere cruzando `context_packs` con `file_change_proposals`), archivos innecesarios, tamaño de la respuesta, cambios importados vs. aplicados, y el resultado final de la tarea. Esto no es telemetría opcional para más adelante: se activa desde el Incremento 1, porque es la única forma de responder con datos reales — no con intuición — si el Context Planner heurístico (Niveles 1-2) es suficiente o si hace falta invertir en símbolos/AST, Git recency, o la capa semántica opcional.
