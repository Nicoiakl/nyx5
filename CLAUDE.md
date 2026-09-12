# Nyx5 — guía para Claude Code

Este repositorio es **un solo sistema** con dos componentes que comparten identidad, transporte y
almacenamiento. No son dos productos compatibles: son las dos mitades de la misma pieza.

| Componente | Nombre | Qué es | Análogo humano |
|---|---|---|---|
| Correo | `src/correo/` | direcciones `agente@dominio`, tarjetas, sobres firmados y cifrados, buzón store-and-forward, estafeta | el email |
| Libro | `src/libro/` | ledger de doble entrada de cada casa, cotizaciones, contratos (spot, escrow, fianza, medido), mandatos en cadena, estampillas | el banco |

Lo que los vuelve una sola pieza:
- **Una identidad.** El Libro no tiene login: toda operación es un sobre firmado a `libro@<casa>`. La cadena de confianza del Correo (DNS → dominio → agente → sobre) es la autenticación del Libro.
- **Un transporte.** Cotizaciones, aceptaciones y recibos son sobres. El recibo firmado por la casa llega al buzón como cualquier carta.
- **Un servidor.** La `Estafeta` aloja ambos: `src/correo/estafeta.js` instancia `Libro` y le entrega los sobres dirigidos a `libro@`.
- **Un almacén.** `src/nucleo/almacen.js` guarda buzones, cola, tarjetas y también diario, contratos y mandatos.

## Mapa

```
src/nucleo/crypto.js     Ed25519, X25519+AES-GCM, JSON canónico, sha256, proof-of-work
src/nucleo/almacen.js    FileStore: correo (agents, mailbox, queue, outbox, seen) + libro (diario, contratos, mandatos, ops)
src/correo/resolver.js   dirección -> tarjeta verificada (DNS TXT / well-known / override), pins, caché, rotación, cadena de delegación
src/correo/politica.js   validación de sobres; políticas de buzón: open | allowlist | pow | stamp; rate limit
src/correo/estafeta.js   servidor HTTP de un dominio: tarjetas, registro (admin|invite|open, prueba de posesión, reservados, invitaciones, directorio), /outbound (cola+reintentos), /inbound (verificación+política), buzones, webhooks, rutas /libro/*
src/correo/agente.js     cliente: register (admin|invite|open), rotateKeys, directory, send, inbox, open, ack, reply, receipt, delegate, quote, accept, deliver, release, refund, bond, forfeit, mandate, charge, revoke, balance, contract
src/libro/libro.js       kernel: post() y las primitivas (topup, transfer, hold, release, refund), verifyQuote, handle(), stamp()
src/libro/contratos.js   máquinas de estado sobre el kernel: ops {accept, deliver, release, refund, bond, forfeit, mandate, charge, revoke, pay, balance, statement, contract}; CONTRATOS {spot, escrow, metered, bond}
src/libro/errores.js     LibroError(code, message)
src/puentes/herramientas.js las 20 herramientas MCP, UN módulo para los dos puentes (MENSAJERIA = las 12 del remoto)
src/puentes/mcp.js       puente MCP por stdio (la llave del agente en el disco del usuario)
src/puentes/mcp-remoto.js puente MCP por Streamable HTTP en /mcp (subagente delegado; llave en la bóveda)
src/puentes/oauth.js     servidor OAuth 2.1 del conector: RFC 9728/8414/7591, PKCE S256, rotación de refresco
src/nucleo/boveda.js     llaves de subagentes cifradas con NYX5_VAULT_KEY (AES-256-GCM, AAD = dueño)
src/version.js           la versión que declara el servidor (el edge no lee package.json)
src/nucleo/almacen-d1.js D1Store: la misma interfaz sobre Cloudflare D1; atomicidad por batch + constraints
src/nucleo/d1-local.js   emulador de la API D1 sobre node:sqlite (tests y desarrollo local)
src/plataformas/node.js  adaptador node:http (start() lo usa)
src/plataformas/worker.js adaptador Cloudflare Workers (fetch + scheduled); config por env
migrations/000{2..6}*.sql   esquema D1, candado, pins, eventos, y 0006: nyx5_kv (OAuth + bóveda) e índice de historial
bin/nyx5.js           CLI
demo/                    e2e, offline, spam (correo) · contratos (libro) · piloto-d4 (economía de una flota + costo por entrega)
src/correo/unirse.js     join (alta en un paso) y mandate (tope del humano) como funciones testeables
src/libro/verifica.js    evaluador de referencia: http_status | sha256 | exit_0; veredicto y "indeciso"
src/libro/tareas.js      trabajo sembrado: catálogo, cupos por agente/día, y que la cotización coincida
src/puentes/x402.js      adaptador x402 v2: PAYMENT-REQUIRED / PAYMENT-SIGNATURE / PAYMENT-RESPONSE, /x402/supported
docs/interop/            mapeos contra otros protocolos (ap2.md, x402.md) con la regla de los cuatro veredictos
test/                    correo · libro · registro · invariantes+D1 · indice · concurrencia · altos ·
                         diferidos · aval · email · mcp · unirse · verifica · tareas · instrumentacion ·
                         puertos (guard de colisión) · x402 · interop · custodia · puente-remoto · asistente · app-recibos -> `npm test` (225)
test/_migraciones.js     todas las migraciones en orden (agregar una .sql no exige tocar cada suite)
docs/SPEC.md             el estándar     docs/ARQUITECTURA.md    operación y producción
```

## Comandos

```
npm test                 # 225 pruebas, todas deben pasar antes de cualquier commit
node demo/edge-local.mjs # el código del edge sobre NODE (CSP, parseo, HEAD). NO es workerd: ver trampas
npx wrangler dev --port 8790 --local   # el Worker en workerd REAL (.dev.vars + d1 execute --local)
npm run demo             # correo: tarea cifrada, respuesta, acuse
npm run demo:offline     # correo: destino apagado, cola, reintento
npm run demo:spam        # correo: firmas falsas, allowlist, pow, duplicados
npm run demo:contratos   # libro: spot, escrow, fianza, mandato en cadena, delegación, estampilla
npm run demo:piloto      # D4: una flota con presupuesto, escrow + verificación medida, costo por entrega
node bin/nyx5.js join        # alta en un paso (lo que corre un agente que llega)
node bin/nyx5.js tareas      # catálogo de trabajo sembrado de una casa
node bin/nyx5.js      # ayuda de la CLI
```

Node 20+. **Cero dependencias**: no agregues paquetes npm sin una razón que no pueda resolverse con `node:` builtins.

## La Constitución manda sobre el rumbo

Las decisiones de PROPÓSITO, alcance y modelo de negocio viven en `CONSTITUCION-NYX5.md`, un
documento local **fuera de este repositorio** (es público; ahí hay decisiones de negocio). Está en
el directorio padre del clon de Nicholas y respaldado en su Drive; la memoria del proyecto lo
indexa como `nyx5-constitucion`.

Este archivo dice CÓMO se construye. La Constitución dice QUÉ se construye y qué no. Antes de
proponer un cambio de rumbo — cobrar, abrir el registro, custodiar algo, agregar una red — se lee.
Sus invariantes no se cambian sin decisión explícita de Nicholas, anotada con fecha y razón.

## Invariantes (no se rompen; si una tarea los toca, para y pregunta)

1. Sin firma verificable no hay entrega. `inbound` rechaza antes de mirar contenido.
2. El Libro solo se opera por sobres firmados a `libro@` o por lecturas autenticadas con la misma firma. Nunca por un endpoint sin firma.
3. Todo asiento cuadra (suma de deltas = 0), va firmado por la casa, y nadie salvo `casa@` queda en negativo.
4. Idempotencia por `id` de sobre: reentregar nunca duplica buzón ni asiento.
5. Los recibos llevan hash del sobre que los causó (`sha256` / `op_sha256` / `cotizacion_sha256`).
6. Un delegado nunca tiene más ámbito que su padre (tarjetas) ni más tope que el mandato del que cuelga (Libro).
7. Los campos desconocidos se conservan y se firman, pero se ignoran. Versión explícita `nyx5: "1"`.
8. El contenido cifrado no lo lee la estafeta. Las cotizaciones viajan cifradas; solo se muestran al Libro al aceptar.
9. Nadie registra una clave que no controla (prueba de posesión), nadie pisa un nombre ajeno, y los nombres de sistema están reservados.

## Cómo extender

- **Nuevo contrato**: agrega la op a `contratos.js` (`ops.<nombre>`) y, si se cotiza, `CONTRATOS.<kind>` con `onAccept`. No toques `libro.js`. Agrega un test en `test/libro.test.js`.
- **Nueva política de buzón**: `politica.js` (`applyInboxPolicy`) y, si necesita Libro, el bloque `p.stamp` en `estafeta.inbound` es el modelo.
- **Otro almacenamiento**: implementa la misma interfaz async que `FileStore` (todos los métodos, incluidos `libro*`, `markSeenIfNew`, `claimDueJobs`, `useNonce`, `libroCommit`, `inboundCommit` y los `index*`) y pásala como `store` a `Estafeta`. Referencia: `src/nucleo/almacen-d1.js` + `migrations/0002_nyx5.sql`.
- **Nueva extensión** (URI `urn:nyx5:ext:*`): decláralo en la tarjeta (`extensions` / `capabilities`), transporta datos en `extensions[uri]` del sobre.

## Convenciones

- Sustantivos del dominio en español (sobre, estafeta, tarjeta, libro, asiento, casa, mandato, fianza, estampilla); métodos y campos JSON en inglés cuando ya son convención (`send`, `accept`, `release`).
- Errores del Libro: `throw new LibroError(code, msg)` con códigos HTTP-like (402 saldo, 403 parte/ámbito, 404, 409 estado, 410 vencido). La estafeta los convierte en rechazo y el remitente recibe un rebote del postmaster con la razón.
- Un cambio de comportamiento sin test es un cambio a medias.

## Estado y siguiente paso

Fase 2 DESPLEGADA (2026-09-05): dos casas en producción sobre Cloudflare Workers + D1 —
https://chsq.uk (índice federado activo, registro por invitación, welcome 20.000, fee 20%)
y https://b.chsq.uk. E2E federado verificado. Ver docs/ARQUITECTURA.md §3.
Los 3 críticos y los 7 altos de la revisión adversarial están ARREGLADOS (ver git log).

**V1 desplegada (2026-09-06)**: sobres diferidos. `deliver_after` (ISO-8601) hace que un sobre
espere en la cola hasta esa fecha; `expires ≤ deliver_after` se rechaza al enviar; un sobre que
vence esperando en la cola rebota al remitente. Habilita `agente.recordar()` (auto-envío cifrado
= memoria entre sesiones, tool MCP `nyx5_remind`) y los avisos de plazo del Libro (un contrato
con `deadline` programa un aviso a las partes). Ver `test/diferidos.test.js` y SPEC §5/§7.

**D4 hecho (2026-09-06)**: `demo/piloto-d4.mjs` — una flota (coordinador + worker + verificador) con
presupuesto cargado por topup, trabajo delegado como escrow, verificación como servicio metered, y un
reporte de costo por entrega leído del diario (con cuadre de doble entrada). El costo por entrega no es
estimación: es lo que el asiento dice que salió de la cuenta del frente.

**Casa oficial en nyx5.com (2026-09-07)**: MIGRADA. `NYX5_DOMAIN=nyx5.com`, D1 limpio "nyx5"
(d51f69cf…); el D1 viejo "chsq" queda abandonado a propósito (partir limpio, como sigo.uk). Los agentes
son @nyx5.com; `nicholas@nyx5.com` registrado y el conector MCP (`~/.chasqui/nicholas.json` (el directorio conserva el nombre viejo)) apunta ahí
(respaldo `.chsq-uk.bak`; requiere reiniciar la app de Claude para tomarlo). chsq.uk queda como alias del
mismo Worker. El protocolo sigue siendo Nyx5/1 (id firmado en cada sobre). Repo público:
**github.com/Nicoiakl/nyx5**, CI verde (Node 20 y 24; el emulador D1 usa node:sqlite, que no está en
Node 20 → esas suites saltan, ver `sqliteAvailable`). `docs/SPEC.en.md`: traducción al inglés (borrador §5).

**D2 hecho (2026-09-06)**: presencia pública. LICENSE Apache-2.0, package.json publicable
(`npm pack` verificado, whitelist sin secretos), CONTRIBUTING/SECURITY, `examples/hola-mundo.mjs`,
CI (Node 20/22), y el sitio de la spec generado desde `docs/SPEC.md` por `scripts/build-spec-site.mjs`
(§6: el documento no pasa por ninguna mano) y servido en **https://chsq.uk/spec** + `/llms.txt`
(meta + JSON-LD para indexación LLM). Falta lo que requiere credenciales de Nicholas: `npm publish`
(publicado como **@nyx5/nyx5**; el nombre suelto `nyx5` lo bloquea npm por parecerse a nx/nyc) y el repo GitHub público.

**Brief de distribución COMPLETO** (`docs/DISTRIBUCION.md`): D1, V1, D4, D2, D5, D6, D7, D3 hechos y
desplegados (npm test = 80, CI verde). D3 (puente de correo) queda inerte hasta que Nicholas active
Email Routing (entrada) y ponga RESEND_KEY/EMAIL_SENDER (salida). Pendientes fuera del brief: migrar la
identidad de las casas a nyx5.com, `npm publish`, re-traducir SPEC.en.md, ancla DNS TXT, ~20 medios/bajos.

**Sprint join/mandate/verifica DESPLEGADO en el repo (2026-09-08)** — §6 del `docs/SPEC-MAESTRO.md`,
los 8 puntos, 112 pruebas:
- `nyx5 join`: un comando y el agente tiene dirección, buzón, saldo y bloque MCP. Sin humano.
- `nyx5 mandate`: el humano fija tope una vez; se confirma con el recibo del Libro, no por optimismo.
- **Reputación = el libro**: `GET /agents/<local>/historial`, PÚBLICO. Solo cuenta lo que movió
  tokens; cero de cero devuelve `null`, nunca 100 %.
- `verifica@<casa>`: 3 pruebas deterministas (`http_status`, `sha256`, `exit_0` — esta última solo
  fuera del edge). Libera o devuelve el escrow según el resultado; si la prueba NO PUDO correr,
  queda indeciso y nadie decide. `exit_0` exige `argv`, jamás una línea de shell.
- `tareas@<casa>`: trabajo sembrado. La casa es el primer comprador; el agente cotiza con los
  términos publicados TAL CUAL. Tope por agente/día, una a la vez, cada tarea se paga una vez.
- Vocabulario ACP (ERC-8183) en las vistas públicas (`acp.phase` / `acp.outcome`).
- Instrumentación: `join`, `mandate_created`, `first_quote`, `escrow_released`, `escrow_refunded`,
  `bond_forfeited`, `seed_task_taken`, `verificado`. `GET /eventos` (solo la casa).
- Variables `NYX5_*` con respaldo `CHASQUI_*`. El nombre del Worker (`chsq`) NO se toca: renombrarlo
  obliga a recrearlo y remapear dominios, secrets y Email Routing, con caída de nyx5.com.
**DESPLEGADO Y VERIFICADO EN PRODUCCIÓN (2026-09-08)**: nyx5.com corre el sprint completo. Migración
0005 aplicada en `nyx5` y `nyx5-b`. `tareas@nyx5.com` tiene 100.000 tok de presupuesto (asiento
8ad478c8). Catálogo sembrado: `hola` (200), `lema` (300), `faro` (500). Comprobado con el CLI contra
la casa real: join en 4 s con 20.000 de bienvenida; tarea tomada, entregada con el hash correcto y
COBRADA (20.000 → 20.160, o sea 200 menos el 20 % de la casa); y la misma afirmación con un hash
falso NO cobró (`refunded`, razón escrita en el contrato por `verifica@nyx5.com`). El historial
público del agente de prueba `claude-0101042e@nyx5.com` quedó en cumplimiento 0,5 (una cumplida,
una fallada): es real, no se borra.

**RESUELTO 9-sep**: el token de Cloudflare ya tiene `Workers Routes`. `wrangler deploy` ahora
reconcilia rutas sin error. Lo que NO cambia: se verifica contra la URL, no contra la salida de
wrangler (§1). Lo que el token sigue sin poder hacer es Registrar.

**DNSSEC: no es "está apagado", es "quedó colgado"** (medido 9-sep, y es el ejemplo del día de §1).
`dig DS nyx5.com` no devuelve nada y whois dice `unsigned`, así que desde el DNS parece apagado.
Pero el panel de Cloudflare dice `DNSSEC is pending while we automatically add the DS record` y el
único botón que ofrece es **Cancel Setup, en rojo**. Quien lea sólo el DNS va a decirle a Nicholas
que le dé a un botón de encender que ahí no existe, y el único que hay DESHACE lo que está en
curso. No tocarlo. Hay que mirar las dos superficies antes de pedirle un clic.

**DISTRIBUCIÓN EN MARCHA (2026-09-08)** — §7 del spec maestro:
- **npm @nyx5/nyx5 0.2.4** publicado y verificado: `npx @nyx5/nyx5 join` funciona desde cero contra
  nyx5.com. Antes npm servía 0.1.0 SIN join, mientras el README ya lo prometía.
- **Registro oficial de MCP**: `io.github.Nicoiakl/nyx5` ACTIVO. Requiere `mcpName` en package.json
  idéntico al `name` de server.json, descripción ≤100 caracteres, versiones concretas, y el
  namespace con las MAYÚSCULAS del usuario de GitHub (`Nicoiakl`, no `nicoiakl`). Publicar:
  `mcp-publisher login github --token=$(gh auth token)` y `mcp-publisher publish`.
- **Inglés primario**: /spec y / en inglés; /es y /es-home en español, con hreflang cruzado.
  README.md en inglés, README.es.md en español. `agents.md` para el agente que llega al repo.
- **glama.json** listo (reclamar el listado con GitHub OAuth en glama.ai).
- **Smithery**: su documentación actual ya NO menciona smithery.yaml y no hay ruta npm para stdio;
  entrar exige empaquetar `.mcpb`. Pendiente, y puede no valer la pena.
- **PulseMCP**: envíos PAUSADOS por ellos; se alimenta del registro oficial, así que ya estamos.
- **Atribución**: `join --source <canal>` va al evento, nunca a la tarjeta. `npm run reporte` lee
  el diario y escribe el informe de la flota (dice las verdades incómodas: hoy, 0 mandatos).
- **Pie del correo saliente**: implementado y APAGADO (`NYX5_EMAIL_FOOTER=on`) hasta que Nicholas
  apruebe el texto. Informa, nunca instruye: el test prohíbe comandos y urgencia.

**Auditoría externa + verificación integral (8-sep, tarde)**: HEAD daba 404 en todo (rompía vistas
previas y monitores), cero cabeceras de seguridad y de caché, sin favicon/sitemap/og:image, http://
sin redirigir, www en NXDOMAIN, DNSSEC apagado. TODO arreglado y verificado contra el sitio. La
tarjeta del dominio se firmaba POR INSTANCIA del Worker (no por request, como decía el informe):
ahora se firma cuando cambia el contenido y se persiste. `/app` y `/tareas` pasaron a inglés.

**Ocho trampas de este proyecto** (nacieron de defectos reales, no las repitas):
- Las dos casas comparten `src/plataformas/worker.js`. Todo lo que sea de UNA casa se enciende por
  variable (`NYX5_SEED`), no por estar en el módulo: la beta empezó a publicar el catálogo de la
  principal sin presupuesto para pagarlo. Lo cuida `test/tareas.test.js`.
- `_systemSend` deja el sobre en el buzón SIN pasar por `inbound`. Sirve para avisos del
  postmaster, NO para operar el Libro: una op a `libro@` enviada así nunca se ejecuta. Si un
  agente de sistema tiene que operar el Libro, firma el sobre y entra por `inbound` (invariante 2).
- `npm test` corre los archivos EN PARALELO: dos suites con el mismo puerto se cuelgan sin decir
  por qué (se ve como "el buzón no recibe"). Lo cuida `test/puertos.test.js`.
- Un Worker NO puede pedirse su propia URL pública ni un `*.workers.dev` (522 / 1042). Todo lo
  propio se resuelve local: ver `resolver.self` y el `propia` de `_indexCrawlHouse`.
- Una prueba que corre sobre node:http puede pasar en verde con el defecto vivo, porque el
  servidor local serializa lo que en el edge corre en paralelo. Para carreras, golpea el método
  (dos instancias sobre el mismo store) o inyecta un fetch que reproduzca lo que hace el edge.

**Interoperabilidad AP2 + x402 (2026-09-09)** — §7, lo que pidió Nicholas antes de salir:
- `docs/interop/ap2.md`: mapeo campo a campo contra AP2 **v0.2** (no v0.1: Intent/Cart Mandate son
  LEGACY, sus páginas de spec fueron borradas; hoy son Checkout/Payment Mandate en SD-JWT VC).
  Hallazgo bloqueante: la spec de AP2 **prohíbe Ed25519 por nombre** para el Checkout JWT y exige
  ECDSA. Hablar AP2 exige una segunda llave P-256 por identidad. NO reclamamos conformidad.
- `docs/interop/x402.md` + `src/puentes/x402.js`: el transporte HTTP v2 IMPLEMENTADO y desplegado.
  `GET /x402/supported`, `GET /x402/inbox/<nombre>` (402 con el precio), y `POST /inbound` que
  responde 402 con PAYMENT-REQUIRED o 202 con PAYMENT-RESPONSE. Verificado contra nyx5.com: un
  buzón de 25 tok anuncia "25", rechaza sin estampilla, cobra con estampilla y el `transaction`
  publicado resuelve a un asiento real (25 fuera, 20 dentro, 5 de fee).
- Por qué la red es `nyx5:1` y no `nyx5:<casa>`: CAIP-2 no admite puntos en la reference. La casa
  viaja en `payTo`. Precio de esa decisión: dos casas se ven como la misma red en el cable.
- `test/interop.test.js` obliga a que cada fila de cada mapeo lleve uno de los cuatro veredictos
  (equivalent / partial / missing here / missing there) y a que cada documento diga qué NO reclama.
- La Agentic Payments Alliance NO es un estándar: sin spec, sin repo, nada que integrar.

**El alcance de un mandato falla CERRADO (9-sep-2026)** — nació de un defecto medido, no de una
idea: un mandato con `max_per_charge: 500` y una lista de destinatarios guardó las dos, las FIRMÓ,
y después dejó pasar un cobro único de 90.000. La restricción se veía al leer el mandato de vuelta
y no hacía nada.
- `ALCANCE_MANDATO` en `src/libro/contratos.js` es un vocabulario CERRADO: `concepts` y
  `max_per_charge`. Cualquier otra clave hace que el mandato se rechace al crearlo, nombrándola y
  diciendo qué sí se aplica. Un mandato ya guardado con una clave ajena NO cobra.
- Esto contradice el invariante 7 A PROPÓSITO. Ese invariante es para MENSAJES, donde ignorar lo
  desconocido es lo que deja extender sin romper. En autoridad de gasto, ignorar una restricción
  autoriza MÁS de lo que el mandante quiso. Si alguien "arregla" esta inconsistencia, reabre el
  defecto.
- `max_per_charge` se comprueba en CADA eslabón, así que el tope del padre acota al nieto.

**Contribuir a x402 exige commits FIRMADOS** (9-sep-2026). Su CI corre `check-verified-commits` y
avisa que cierra el PR tras una semana sin actividad. Un commit sin firma no lo miran.
- Nicholas ya tiene su llave `~/.ssh/id_ed25519_personal.pub` registrada en GitHub **como Signing
  Key**. En GitHub, llave de autenticación y llave de firma son entradas SEPARADAS: tener la
  primera no sirve para lo segundo, y el formulario viene por defecto en la que no es.
- En el clon desde donde se contribuya: `git config gpg.format ssh` y
  `git config user.signingkey ~/.ssh/id_ed25519_personal.pub`, y commitear con `-S`.
- No tenemos permisos para relanzar su CI. Para volver a disparar las comprobaciones hay que
  empujar una cabeza nueva (`git commit --amend --no-edit -S` y force-push a la rama del fork).
- Sus flujos de código quedan en `action_required` hasta que un mantenedor los apruebe, porque
  somos contribuidor externo. No es un fallo nuestro.

**Los commits de esta máquina van FIRMADOS por defecto (9-sep-2026).** Configuración global:
`gpg.format=ssh`, `user.signingkey=~/.ssh/id_ed25519_personal.pub`, `commit.gpgsign=true`,
`tag.gpgsign=true`, y `gpg.ssh.allowedSignersFile=~/.config/git/allowed_signers` para que este
git también pueda VERIFICAR y no sólo firmar.
- Antes no había `user.email` global: los commits de nyx5 salieron como
  `nicholasiakl@192.168.1.6`, un correo derivado de la IP de la máquina. Por eso no se enlazaban
  con su cuenta de GitHub, y firmados tampoco se habrían verificado. Ahora el global es
  `nicholasiakl@gmail.com`, que sí está en su cuenta.
- Un repo con `user.email` local propio (por ejemplo `sigo.uk`, con `claude@sigo.uk`) conserva el
  suyo: se firma igual, pero GitHub sólo lo marca verificado si ese correo está en la cuenta.
- Riesgo a tener presente: con `commit.gpgsign=true`, si la llave deja de estar disponible el
  commit FALLA en vez de salir sin firma. Es lo que queremos, pero conviene saberlo.

**La puerta del CORREO también aplica la política del buzón (9-sep-2026)** — era una brecha real,
medida y ya cerrada. `receiveEmail` iba de `getAgent` directo a `putMail` sin consultar la
política: un buzón con `stamp` de 500 y otro con lista blanca cerrada aceptaban los dos un correo
de cualquier desconocido, gratis. La estampilla, la lista y la prueba de trabajo defendían
`/inbound` mientras la puerta de al lado quedaba abierta, y el precio que la casa anuncia por x402
era evitable escribiendo un correo.
- `applyEmailPolicy` (en `politica.js`) falla CERRADO: una política que no se pueda expresar sobre
  correo no deja pasar, y una desconocida tampoco.
- Se compara contra el remitente REAL del correo, no contra `email@<casa>`, que es la pasarela y
  sería la misma para todos.
- El rechazo vuelve como rechazo SMTP (`message.setReject` en el adaptador del edge), así que el
  remitente recibe el rebote de su propio proveedor. La casa NO manda correo a una dirección que no
  verificó: eso sería backscatter.
- Comprobado en producción con un buzón real que cobra 25: el correo salió y no llegó nada.

**Invariante de diseño para dinero real: LA CASA NO CUSTODIA (9-sep-2026).** La casa anuncia el
precio, arbitra y anota en el Libro. Nunca recibe fondos de terceros en una dirección que
controle, ni de paso. El escrow con dinero real se hace con el contrato del esquema `auth-capture`
de x402, que retiene sin que nadie de Nyx5 posea nada.
- No es preferencia: es la frontera entre software y negocio financiero regulado, y es la misma en
  EE.UU., la UE y Chile. Verificado contra las fuentes primarias; el detalle está en la memoria
  del proyecto (`nyx5-la-linea-es-la-custodia`), fuera de este repo por ser público.
- Si una tarea pide que la casa reciba, retenga o reenvíe fondos de terceros, PARA y pregunta.
  Aunque sea "sólo para la comisión": basta con que el dinero toque una dirección nuestra.

**Cobrar dinero REAL no toca la regla de cero dependencias (9-sep-2026).** En el esquema `exact`
de x402 sobre EVM, el servidor de recurso no necesita keccak256, ni secp256k1, ni llaves, ni nodo:
sólo base64, JSON y `fetch` a dos rutas del facilitador (`/verify` y `/settle`). El pagador firma
una autorización EIP-3009 y el facilitador la difunde y paga el gas.
- La asimetría importa: **cobrar** es gratis de implementar; **pagar** exige keccak256, que Node NO
  trae (`sha3-256` no es keccak: cambia el relleno). Por eso `demo/x402-testnet.mjs` recibe el pago
  ya firmado en un archivo en vez de firmarlo.
- `extra.name`/`extra.version` son el dominio EIP-712 del CONTRATO del token y CAMBIAN entre redes:
  en Base Sepolia el USDC se llama `"USDC"`, en Base mainnet `"USD Coin"`. Mal puesto, la firma no
  valida y el error no dice por qué.
- El servidor de referencia de x402 NO deduplica. Dos peticiones con la misma firma ejecutan el
  trabajo dos veces y liquidan una. `claveDePago()` da la clave (el nonce) para usar el candado que
  ya tenemos (invariante 4).
- Ejercido contra el facilitador abierto `https://x402.org/facilitator` en Base Sepolia: recupera
  nuestra dirección desde la firma y simula la transferencia real. Falta sólo fondear la billetera.

**El dinero real es parte del flujo, no un experimento aparte (9-sep-2026).** Un agente declara
`wallet: { network, address }` al registrarse y un precio `inbox.price_usd`; entonces su buzón
anuncia DOS formas de pago en la misma respuesta 402: el token de la casa y USD Coin en una red
real. El que paga elige; un cliente x402 genérico descarta la red que no conoce sin fallar.
- **No convertimos tokens a dólares.** El precio en dólares lo pone el dueño del buzón o no hay
  opción en dólares. Inventar un tipo de cambio sería la cifra sin respaldo que este protocolo
  existe para encarecer.
- `TOKEN_USD` tiene los contratos y su dominio EIP-712 LEÍDO del contrato, no recordado.
  `validarBilletera` falla cerrado ante una red que no sabemos liquidar: anunciar un precio en una
  red que no podemos liquidar es prometer de gratis.
- La billetera es PÚBLICA y va en la tarjeta. La casa no la controla ni puede mover nada de ella,
  igual que no controla la llave del agente. El invariante de no custodiar queda intacto.

**Seis redes reales, y el que paga elige (10-sep-2026).** Un agente declara `wallets: [{network,
address}]` y su buzón anuncia UNA entrada por cada red que declaró y que sabemos liquidar, más el
token de la casa. `accepts` es una lista en el estándar justamente para esto: quien sólo puede
pagar en una cadena encuentra la suya sin que nadie quede excluido.
- `TOKEN_USD` cubre Ethereum, Base, Polygon, Arbitrum, Optimism, Avalanche y Base Sepolia. El
  `name`/`version` de CADA una está LEÍDO del contrato en su cadena, no copiado. Todas dieron
  `USD Coin` versión 2 salvo la de pruebas, que da `USDC`.
- Cada red lleva su facilitador comprobado en vivo. Anunciar una red sin facilitador que la
  liquide sería prometer de gratis.
- Dos billeteras para la misma red se RECHAZAN: dos precios para una red es ambigüedad, no opción.
- La prueba de la red desconocida ya falló DOS veces al agregar redes (Ethereum, luego Polygon).
  Está bien que duela: la lista de redes es una decisión, no un detalle.

**El saldo de bienvenida es CERO (10-sep-2026), y es a propósito.** Antes eran 20.000 por agente.
Medido el 9-sep: 24 agentes, ~400.000 tokens regalados contra ~1.000 ganados con trabajo
verificado. 400 a 1 de plata sin respaldo. Y peor: 20.000 alcanzaban para 800 estampillas, así que
el regalo volvía gratis la única defensa que tiene un buzón contra el spam.
- Se comprobó ANTES de quitarlo que nadie queda encerrado afuera: un agente con saldo cero cotiza
  al mostrador, entrega, lo verifican y cobra. El trabajo sembrado ES la puerta de entrada.
- El CLI dice "Balance: 0 tokens. Here you earn them, you are not given them." Cero no es un error,
  es la tesis.
- Los 24 agentes viejos conservan lo suyo: el diario no se reescribe.
- Un `invite` puede seguir llevando su propio `welcome` para casos puntuales.

**Conector MCP remoto DESPLEGADO Y VERIFICADO EN PRODUCCIÓN (10/11-sep-2026)** — lo que pidió Nicholas:
"el WhatsApp de los agentes". Cualquier Claude (claude.ai web, Desktop, móvil) agrega
`https://nyx5.com/mcp` como conector personalizado y queda hablando por Nyx5 sin instalar nada.
- Aprobado por Nicholas con TRES límites y cada uno tiene prueba en `test/puente-remoto.test.js`:
  sólo mensajes (`scope.messages_only`: ni Libro, ni estampillas, ni vender; lo niega la casa, no
  sólo el puente), vence a los 30 días y se revoca (sin resurrección por la gracia de `previous`),
  y la tarjeta declara `custody.keys = house`. La llave RAÍZ del dueño nunca pasa por la casa: la
  delegación la firma su navegador en `/oauth/authorize`.
- El subagente es `claude.<dueño>@<casa>`; su llave vive en `nyx5_kv` (ns `boveda`) cifrada con el
  secret `NYX5_VAULT_KEY` (copia en `.env` para poder recuperarla; perderla obliga a re-autorizar
  todos los conectores, no afecta identidades raíz). Por defecto sólo el dueño le escribe (allowlist).
- Tiempo real: `GET /mailbox/<l>/wait` (espera larga, sondea D1 cada 1 s) y `nyx5_wait`. Medido:
  0,5 s en workerd local, ~3,4 s en producción incluida la red del remitente. Historial:
  `GET /conversations/<l>` y `nyx5_conversation`; la bandeja guarda el sobre y el remitente entra
  al cifrado para poder leer lo que mandó. `GET /resolve/<dir>`: tarjeta verificada para la app.
- Recorrido completo corrido EN PRODUCCIÓN con identidades `prueba-conector-*`/`prueba-amiga-*`
  (source `prueba-conector`), subagentes revocados al final. Viven, no se borran.

**La app /app estuvo ROTA en producción hasta el 10-sep-2026**: la CSP decía `default-src 'none'`
sin `connect-src` y el navegador bloqueaba TODO fetch. Cargaba perfecta y fallaba al primer botón.
Otra conversación le dijo a Nicholas que "ya funcionaba persona a persona": no funcionaba. Lo cuida
`superficie.test.js` (si la app hace fetch, la CSP tiene que dejarla). Se verificó en un navegador
contra nyx5.com, no con curl (la CSP la aplica el navegador, curl no la ve).

**Dos trampas nuevas** (nacieron de defectos reales de este día):
- `demo/edge-local.mjs` corre el código del edge sobre NODE, no sobre workerd. Sirvió para la CSP y
  el parseo, y NO podía ver que workerd no tiene `node:crypto.diffieHellman`: el primer mensaje
  cifrado del Claude remoto falló en producción con todo verde en local. Antes de usar en el edge
  una primitiva nueva de `node:crypto`, correr `scripts/sonda-workerd.mjs` en `wrangler dev`, y
  antes de desplegar algo que el edge ejecute por primera vez, correr el recorrido en workerd real.
  El acuerdo X25519 va por `crypto.subtle` (existe en workerd, navegadores y Node 20+).
- El invariante 8 tiene una excepción DECLARADA: lo que llega a una dirección con
  `custody.keys = house` lo lee la casa, porque firma y descifra en su nombre. Está en la tarjeta,
  en la pantalla de consentimiento y en la Constitución. No extenderlo a identidades raíz.

**Invitaciones de contacto (11-sep-2026)** — para que la Pauli llegue con la menor fricción:
`POST /contact-invites` (llave raíz de quien invita, o `Bearer <admin>` con `inviter`) da `/i/<código>`
(la página que se manda por WhatsApp) y `/mcp/i/<código>` (la URL del conector). La invitación viaja
EN la URL: Claude la devuelve como `resource` al autorizar, así la pantalla sabe quién invitó sin
depender del almacenamiento del navegador. Pantalla de conectar única (crea la dirección si no hay),
contacto MUTUO (el Claude de quien invita acepta al nuevo; sin eso la primera respuesta rebotaba),
y el Claude conectado recibe sus contactos en `initialize`. Un solo uso, 7 días; la URL del conector
sigue sirviendo después. Recorrido `scratchpad/e2e-invitacion.mjs` pasado en workerd y en producción.

**Asistentes (11-sep-2026)** — `src/correo/asistente.js`: una dirección que contesta SOLA con la API
de Anthropic, para que Basti le pregunte al agente de Sigo mientras Nicholas viaja (desde el 14-sep,
un mes). Primer asistente: `sigo.nicholas@nyx5.com` (delegado de `nicholas@`, sólo mensajes,
custodia de la casa, tope US$30/mes, `claude-opus-5` con esfuerzo medio). Contesta sólo a su lista,
desde el reloj programado (el tick de una petición lleva `programado: false`: el edge sólo da 30 s
tras responder). `/admin/assistants` para alta, conocimiento, pausa y estado. La base de
conocimiento y su armador viven FUERA de este repo (`../asistente-sigo/`): son contenido privado de
Sigo, sin datos clínicos de Nicholas (decisión suya: "lo técnico y que eres paciente"). Sin el
secret `ANTHROPIC_API_KEY` el asistente queda instalado y no llama a nada.

**Trampa: los contadores de puertos (11-sep-2026).** Cuatro suites levantan casas con
`let puerto = N` + `puerto++`. El guard sólo veía constantes, y una suite nueva en 4231 chocaba con
el contador de aval (4230–4232): parecía una prueba "inestable". Ahora el guard reserva el bloque
del contador. Si agregas una suite, usa un puerto libre FUERA de 4300–4339 (bloques de contadores).
