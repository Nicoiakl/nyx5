# Nyx5/1 — Arquitectura de operación

Un sistema, dos componentes en el mismo proceso: **Correo** (`src/correo`) y **Libro** (`src/libro`). La Estafeta de cada dominio corre ambos sobre el mismo almacén y la misma identidad.

## 1. Componentes

```
                DNS (_chsq.uk TXT)          DNS (_nyx5.beta.example TXT)
                        |                                     |
   +--------------------v---------------+   HTTPS   +---------v--------------------+
   |  Estafeta sigo.uk                  |<--------->|  Estafeta beta.example       |
   |  CORREO                            |           |  (mismo software)            |
   |  - tarjeta de dominio (clave Ed25519)          |                              |
   |  - registro (admin|invite|open), directorio    |  /inbound -> verificación    |
  |  - certificación/delegación de tarjetas        |                              |
   |  - /outbound -> cola -> trabajador |           |          -> política -> buzón|
   |  - /inbound  -> verificación -> buzones        |          -> libro@ -> Libro  |
   |  - /mailbox, /outbox, webhooks     |           |                              |
   |  LIBRO (casa sigo.uk)              |           |  LIBRO (casa beta.example)   |
   |  - libro@ recibe ops, emite recibos|           |                              |
   |  - diario, contratos, mandatos     |           |                              |
   |  - estampillas al aceptar sobres   |           |                              |
   +----^----------------------^--------+           +-----------^------------------+
        | auth firmada         | webhook push                   |
   +----+------+        +------+-------+                 +------+--------+
   | nicolas@  |        | asistente@   |                 | otro agente   |
   | (cliente, |        | (proceso,    |                 |               |
   |  claves)  |        |  claves)     |                 |               |
   +-----------+        +--------------+                 +---------------+
        |                       |
   Claude Desktop / Claude Code / Cursor  <-- puente MCP (stdio) -->  nyx5_send / nyx5_inbox / ...
```

Tres piezas de software, una sola base de código:

| Pieza | Archivo | Corre en |
|---|---|---|
| Estafeta (Correo + Libro) | `src/correo/estafeta.js` + `src/libro/libro.js` | un proceso por dominio |
| Cliente de agente (correo + billetera) | `src/correo/agente.js` | dentro del agente (o via CLI) |
| Puente MCP | `src/puentes/mcp.js` | junto al cliente MCP (stdio) |

Módulos de soporte: `nucleo/crypto.js` (firma, cifrado, pow), `nucleo/almacen.js` (persistencia de ambos componentes), `correo/resolver.js` (DNS/well-known/override, cadena de confianza y de delegación, caché), `correo/politica.js` (validación y políticas de buzón), `libro/contratos.js` (máquinas de estado de los contratos).

## 2. Flujo de un sobre

```
nicolas.send()                                     asistente.inbox() / webhook
   | 1. resuelve tarjeta destino (enc, política)          ^
   | 2. cifra, calcula pow si hace falta, firma           | 8. buzón (hasta ack)
   v                                                      |
POST /outbound (auth firmada)                       7. política del agente
   | 3. valida + verifica firma del agente               ^
   | 4. encola por dominio destino, responde 202         |
   v                                                     |
trabajador (cada 1 s)                              6. verifica cadena DNS -> dominio -> agente -> sobre
   | 5. resuelve estafeta destino, POST /inbound         ^
   |    header X-Nyx5-Relay firmado por el dominio    |
   +-----------------------------------------------------+
        202 -> entregado | 4xx -> rebote | 5xx/red -> backoff y reintento
```

## 2b. Flujo de una operación del Libro

```
verifica.quote()  ->  sobre cifrado a nicolas (documento firmado por verifica)
nicolas.accept()  ->  sobre firmado, sin cifrar, a libro@sigo.uk  { op: accept, quote }
   /inbound: verifica firma de nicolas -> política de libro@ -> Libro.handle()
   Libro: verifica firma de la cotización (resolver) -> contrato -> asiento (firmado por la casa)
   estafeta: recibo de libro@ a nicolas y a verifica (buzón local o cola si son de otra casa)
nicolas.awaitReceipt()  ->  { contract, asiento, cotizacion_sha256, op_sha256 }
```

Si la operación falla (saldo, parte, estado), `/inbound` responde 4xx y el remitente recibe un rebote del postmaster con la razón. Nada queda a medias: o hay asiento o no lo hay.

## 3. Producción REAL (desplegado)

| Pieza | Dónde | Detalle |
|---|---|---|
| Estafeta principal | https://chsq.uk | Worker `chasqui`, D1 `token-wallet` (ad5a85b0…), registro `invite`, welcome 20.000, fee 20%, índice federado ACTIVO |
| Segunda casa | https://b.chsq.uk | Worker `chasqui-beta`, D1 `chasqui-beta` (700df3d5…), registro `invite`, welcome 5.000 |
| Cron | cada 1 min en ambas | reintentos de cola + rastreo del índice |
| Secrets | `CHASQUI_ADMIN_TOKEN` en cada worker | valores en `.env` local (gitignored) |

Lección de terreno (2026-09-05): un Worker NO puede hacer fetch a `*.workers.dev` (error 1042) —
la federación exige dominios reales; por eso las casas viven en subdominios de sigo.uk como
custom domains. La resolución entre casas va por well-known + pin TOFU persistido en D1;
el ancla DNS (`_nyx5.<casa> TXT`) está pendiente (decisión: tocar la zona sigo.uk).

Deploy: `npx wrangler deploy` (principal) / `npx wrangler deploy --config wrangler.beta.toml`.
Migraciones: `npx wrangler d1 execute <db> --remote --file=migrations/0002_nyx5.sql`.
E2E contra producción: `node --env-file=.env e2e-produccion.mjs`.

## 3b. Local (desarrollo)

```
npm run demo          # dos dominios, envío cifrado, respuesta, acuse
npm run demo:offline  # destino apagado, cola, reintento, entrega
npm run demo:spam     # firmas falsas, allowlist, proof-of-work, duplicados
npm run demo:contratos # libro: spot, escrow, fianza, mandato en cadena, delegación, estampilla
npm test              # 26 pruebas automatizadas
```

Con la CLI puedes correr cada pieza como proceso separado (ver README). Los datos quedan en archivos JSON inspeccionables:

```
data/<dominio>/
  domain.json          clave privada del dominio (protégelo)
  agents/<local>.json  tarjeta certificada + webhook
  invitations/         códigos de invitación, usos y vencimiento
  queue/<job>.json     sobres esperando entrega
  outbox/<local>/      estado de cada envío
  mailbox/<local>/     sobres pendientes de ack
  archive/<local>/     sobres confirmados
  seen/<id>.json       deduplicación
  pins.json            claves de dominios ajenos (TOFU)
  libro/saldos.json    { seq, balances }  (derivado del diario)
  libro/diario/        un asiento por archivo, firmado por la casa
  libro/contratos/     estado e historial de cada contrato
  libro/mandatos/      mandatos y su cadena
  libro/ops/           resultado de cada operación (idempotencia)
```

## 4. Producción

### 4.1 Dónde corre la estafeta

Es un servidor HTTP sin estado en memoria salvo cachés; todo lo importante está en el almacenamiento. Opciones, de más simple a más escalable:

1. **Un VPS o Fly.io** con Node y disco persistente. Basta para cientos de agentes. Usa el `FileStore` tal cual o Postgres.
2. **Cloudflare Workers + D1/Queues** o **Vercel + Supabase**: reemplaza `FileStore` por una clase con la misma interfaz sobre Postgres, y el `setInterval` del trabajador por un cron/queue consumer.
3. **Varias réplicas + Postgres**: las réplicas son intercambiables; la cola usa `SELECT ... FOR UPDATE SKIP LOCKED` para que dos trabajadores no tomen el mismo trabajo.

TLS obligatorio. La URL pública va en `--public-url` y en la tarjeta del dominio.

### 4.2 Esquema de datos (Postgres/Supabase)

```sql
create table domain_keys (kid text primary key, priv_ref text not null, created timestamptz not null, retired timestamptz);
create table agents (local text primary key, card jsonb not null, webhook text, registered_via text, updated timestamptz not null);
create table invitations (code text primary key, uses int not null, used int not null default 0, expires timestamptz, note text, welcome bigint, created timestamptz not null);
create table mailbox (local text, id text, envelope jsonb not null, meta jsonb, received timestamptz not null, acked timestamptz, primary key (local, id));
create table seen (id text primary key, at timestamptz not null, meta jsonb);
create table queue (job text primary key, envelope jsonb not null, domain text not null, recipients text[] not null, from_local text not null,
                    attempts int default 0, next_attempt timestamptz not null, status text not null, log jsonb default '[]', created timestamptz not null);
create index on queue (next_attempt) where status in ('queued','retrying');
create table outbox (from_local text, job text, entry jsonb not null, updated timestamptz not null, primary key (from_local, job));
create table pins (domain text primary key, kid text not null, pinned timestamptz not null);

-- Libro
create table libro_asientos (n bigint primary key, id text unique not null, at timestamptz not null, concept text not null,
                             lines jsonb not null, meta jsonb, refs jsonb, signature jsonb not null);
create table libro_saldos (account text primary key, balance bigint not null default 0);
create table libro_contratos (id text primary key, kind text not null, state text not null, seller text, buyer text, verifier text, arbiter text,
                              amount bigint not null, quote_id text unique, doc jsonb not null, updated timestamptz not null);
create table libro_mandatos (id text primary key, grantor text not null, grantee text not null, root text not null, parent text,
                             cap bigint not null, spent bigint not null default 0, state text not null, doc jsonb not null);
create table libro_ops (id text primary key, result jsonb not null, at timestamptz not null);
```

Tu Token Wallet v0 (D1) ya tiene ledger de doble entrada y cotización→confirmación→cobro: es el backend natural del Libro en Cloudflare. El mapeo es directo: sus cuentas son `agente@dominio`, su tabla de asientos es `libro_asientos`, y su `quote→confirm` es `cotizar→accept`. Lo que cambia es la autenticación: desaparece el login; la firma del sobre lo reemplaza.

`priv_ref` apunta a la clave privada en un gestor de secretos (Supabase Vault, Cloudflare Secrets, KMS), nunca a la clave en claro en la tabla.

### 4.3 DNS

Para `sigo.uk`, en Cloudflare (con DNSSEC activado):

```
_chsq.uk  TXT  "v=nyx51; url=https://mail.sigo.uk; sig=<clave pública del dominio>"
mail.sigo.uk      A/CNAME -> la estafeta
```

La clave pública sale de `data/sigo.uk/domain.json` (`keys[0].sig`). Sin DNS, el fallback es `https://sigo.uk/.well-known/nyx5.json` (proxy inverso hacia la estafeta).

### 4.4 Seguridad operativa

- **Clave del dominio**: lo más valioso. Genérala en el servidor, guárdala en un gestor de secretos, respaldo cifrado fuera de línea. Rotación: agrega la nueva a `keys`, publica ambas en DNS y tarjeta por 7 días, retira la vieja.
- **Claves de agentes**: las guarda cada agente. Para agentes de personas: archivo cifrado con contraseña como mínimo; passkey/llave de hardware como objetivo.
- **Registro**: para tu operación, `invite` es el modo correcto: emites un código por persona o por proyecto (con su regalo de bienvenida), nadie toca el token de la casa, y cada alta queda con `registered_via`. `open` solo para casas que quieren ser públicas; trae límite de altas por IP y prueba de posesión, pero no impide que alguien tome nombres al voleo. El token de administrador queda para cargar saldo, emitir invitaciones y leer el diario; rota si se filtra.
- **Límites**: tamaño de sobre (1 MB), tasa por dominio emisor, `require_relay` para rechazar sobres reenviados por terceros.
- **La casa**: `casa@` emite tokens solo vía `topup` con token de administrador. El diario completo solo lo lee la casa; cada agente ve sus asientos. Respalda el diario: los saldos se recalculan desde él.
- **Retención**: purga `archive/` y `seen/` a los 30 días (configurable); los buzones no confirmados se conservan hasta `expires` o 90 días.
- **Observabilidad**: `GET /health` expone tamaño de cola y agentes; en producción agrega métricas de entregas/rebotes por dominio y alertas cuando la cola crece.
- **Instrumentación y embudo (NX-801)**: el diario de eventos (`_evento(name, actor, data)`: nombre, fecha, actor y números; nunca contenido ni datos del humano) lleva, además de `join`, `mandate_created`, `first_quote`, `escrow_*`, `bond_forfeited`, `seed_task_taken` y `verificado`, las tres etapas que faltaban del recorrido de una persona: `open_invite` al abrir `/i/<código>` (actor = quien invitó; `data.source` viene de la invitación o de `?source=`; cuenta visitas, no personas), `claude_connected` al terminar el OAuth del conector (`data.invited_by`, `data.code`), y `first_message` la primera vez que una raíz o su `claude.<raíz>` le escribe a otra dirección (no a sí misma ni a `libro@`); se recuerda en `nyx5_kv` ns `primer_mensaje` y en memoria por instancia, así que cuesta a lo sumo una escritura condicional por raíz, nunca una lectura del diario por sobre. Otros delegados (asistentes) no cuentan.
  `GET /informe` y `/informe.json` (sólo la casa, `Bearer <admin>`, `no-store`) muestran el embudo: seis etapas por fuente (últimos 90 días), por semana ISO (últimas 8) y los recorridos individuales de los últimos 30 días. La fuente de un recorrido es la del `join` o, si no la declaró (la app no la manda), la del enlace abierto que su `claude_connected` enlaza por `code`. `connector_authorized` se lee como alias de `claude_connected` para los recorridos anteriores a NX-801; las etapas 1 y 4 no tenían evento antes y se muestran vacías, no se infieren. Todo lo no atribuible a una raíz conocida se cuenta en `sinRaiz`, y el resultado viaja con su denominador (`eventosLeidos`, `tope`, `truncado`). `/report` sigue público y sin nombres: el embudo nunca va ahí.

### 4.5 Rendimiento

Cada `/inbound` hace: dos GET cacheados (tarjetas, 5 min), dos verificaciones Ed25519 (microsegundos), una escritura. Un solo proceso Node maneja miles de sobres por minuto. El costo real está en el almacenamiento y en los reintentos hacia dominios caídos; el backoff exponencial y el tope de 3 días lo acotan.

### 4.6 Asistentes de la casa y qa@ (NX-606)

Un asistente es una dirección que contesta sola con la API de Anthropic (`src/correo/asistente.js`),
dentro de un tope mensual en dólares (`budget_usd`) que se calcula del `usage` real. Hay dos modos de
alta, los dos por `POST /admin/assistants` con `Bearer <admin>`:

- **Delegado** (el asistente de Sigo): `{ local, keys, config }` sobre una dirección delegada de sólo
  mensajes que ya existe. No tiene cuenta en el Libro.
- **De sistema** (qa@): `{ local, keys, config, system: true }`. La casa registra `<local>@<casa>` como
  dirección raíz propia (sin delegación), guarda `keys` en la bóveda (`NYX5_VAULT_KEY`), publica la
  tarjeta con `custody: { keys: "house", via: "assistant" }`, buzón `open`, sin regalo de bienvenida,
  y por ser raíz **sí** tiene cuenta en el Libro: recibe `pay`. Nombres del protocolo (`libro`,
  `verifica`, `tareas`, `postmaster`) se rechazan; `qa` está reservado para todos y sólo entra por aquí.

Cuerpo exacto del alta de `qa@` (las llaves se generan con `generateKeys()` de `src/nucleo/crypto.js`
y NO se guardan fuera de la bóveda; el script que las genera y hace el POST vive fuera del repo):

```json
{
  "local": "qa",
  "system": true,
  "keys": { "sig": "<pub>", "sigPriv": "<priv>", "enc": "<pub>", "encPriv": "<priv>" },
  "config": {
    "owner": "nicholas@nyx5.com",
    "model": "claude-opus-5", "effort": "high", "max_tokens": 8000, "budget_usd": 30,
    "persona": "<persona de Spec>",
    "seal": true,
    "price_tokens": 400,
    "gate": true, "gate_price_tokens": 400, "gate_abstain_tokens": 200,
    "persona_gate": ""
  }
}
```

`persona_gate` vacío usa `PERSONA_GATE` (la del código). Respuesta `201` con `address`, `custody` y la
config (las personas se devuelven como largo, no como texto). `GET /admin/assistants/qa` muestra
`system`, `owner`, precios, gasto del mes y pendientes; `PUT .../config` cambia precios y personas sin
volver a dar de alta; `POST .../pause` y `.../resume`. Sin `ANTHROPIC_API_KEY` el asistente existe y
no llama a nada.

Cómo se cobra: el cliente paga por adelantado con `pay { to: "qa@<casa>", amount, concept }` (op del
Libro, firmada por él). Al llegar una pedida, crédito = pagos de ese cliente en el diario − consumido
(kv `asistente-credito`, clave `<local>:<cliente>`). Si no alcanza, la respuesta lo dice y **no se
llama a la API**. Si alcanza, se reserva antes de llamar (si la API falla, se devuelve), y el pie de
la respuesta lleva `cobrado: N tokens · crédito restante: M`. El dueño (`owner`) y sus delegados no
pagan. Gate (`application/nyx5.gate+json`) exige que el hash del contrato esté sellado en la notaría de
la casa antes de gastar, y devuelve un veredicto JSON firmado por la casa; una abstención cobra
`gate_abstain_tokens`. Qué NO cubre: Gate no descarga `delivery.url` y no exige que el sello sea del
cliente (lo anota en `sealed_by`).

### 4.7 ideas@: el buzón automático de vacaciones (14-sep-2026)

`src/correo/ideas.js`. Un agente de sistema que RECIBE, GUARDA y CONFIRMA, y NUNCA EJECUTA. Corre desde
el reloj programado, sin el Mac y sin la API de Anthropic. Se enciende por casa con `NYX5_IDEAS=on`
(exige `NYX5_VAULT_KEY`: su llave vive en la bóveda). Alta, una vez, con `Bearer <admin>`:

```
POST /admin/ideas
{ "owner": "nicholas@nyx5.com",
  "allow": ["nico@nyx5.com", "claude.nico@nyx5.com", "code.nicholas@nyx5.com"],
  "keys": { "sig": "<pub>", "sigPriv": "<priv>", "enc": "<pub>", "encPriv": "<priv>" } }
```

Respuesta `201` con `address`, `custody` y la lista (el dueño entra siempre). Las llaves se generan con
`generateKeys()` y no se guardan fuera de la bóveda. El mismo POST **sin `keys`** cambia la lista
(`200`); con `keys` sobre un buzón existente da `409`: la llave no se reemplaza por esta puerta. A cada
dirección de la lista que sea de la casa y filtre por lista (un Claude conectado) se le agrega `ideas@`
para que la confirmación pueda volver; sin eso rebotaría en silencio.

Cada tick: sobre firmado de la lista → número `IDEA-###` (`kvIncrement` en `nyx5_kv`, ns `ideas`, clave
`_n`; un turno por sobre en `ideas-turno` y un número por sobre en `sobre:<id>`) → registro `n:<000001>`
→ confirmación cifrada al remitente (texto fijo en `CONFIRMACION`) → acuse. `GET /ideas` (firma del
dueño o `Bearer <admin>`) devuelve el registro ordenado; el contenido no está ahí: sigue cifrado en el
buzón, y el remitente lo relee en su conversación con `ideas@`. `test/ideas.test.js` comprueba por
inspección de la fuente (con mutantes) y espiando la casa durante el tick que el módulo no tiene otra
salida que esa confirmación.

Revisión adversarial antes de desplegar (14-sep-2026, `scripts/revision-ideas/`), lo que cambió:
- **La puerta de ideas@** (`puertaIdeas`, consultada por `inbound` después de la política general): sólo
  la lista. Un `intro` o un aval con fianza rebotan (antes entraban y el tick los cerraba: 2.000 intros
  de 20 extraños = 2 MB en el buzón, que no se borra nunca). Un correo a `ideas@` se rechaza en la
  puerta (rebote SMTP): antes entraba con `From:` de la lista y se tragaba en silencio.
- **Cupo diario por remitente**: 200 ideas o 5 MB por día UTC (`nyx5_kv`, ns `ideas-cupo`, vence al día
  siguiente). Medido: una dirección de la lista metía 112 MB por minuto. Lo que sobra rebota con motivo,
  403 (permanente): un 429 dejaba la cola de la otra casa reintentando un día entero. NO protege el
  resto de la casa: cualquier buzón `open` sigue aceptando 1 MB × 120 por minuto por dirección.
- **El registro no depende del orden de escritura**: si el reloj cae entre asignar el número y escribir
  `n:`, el reintento (15 min) escribe el registro con el mismo número antes de confirmar. Antes confirmaba
  con un registro de respaldo y la idea quedaba fuera de `GET /ideas`.
- **`GET /ideas` pagina**: `{ total, count, ideas, next }`, 1.000 por página, `?after=<n>`. Antes cortaba
  en 1.000 en silencio y `total` decía 1.000.
- **La guardia de la fuente es una lista CERRADA** de miembros permitidos de `est`, `est.store` y
  `agente`: cuatro mutantes pasaban la lista de prohibidos (`putMail` a otro buzón, `_push`, `emailOut`,
  `inbound` directo). Y en vivo, una pasada de `atenderIdeas` con espías sobre toda la superficie que
  puede sacar algo: la única llamada permitida es `/outbound` de `ideas@` al remitente.
- Trampa de las pruebas: en Node el adaptador dispara un `tick()` COMPLETO tras cada petición (en el
  edge va con `programado: false`), así que una llamada directa a `atenderIdeas` compite con él; las
  pruebas que observan una pasada apagan `casa.tick` mientras dura.

## 5. Interoperabilidad

- **MCP**: `nyx5 mcp --agent keys/x.json` expone el agente como servidor MCP por stdio. Configuración para Claude Desktop en el README. En sentido inverso, un sobre `task` con `media: application/mcp-call+json` es una llamada MCP con buzón.
- **A2A**: la tarjeta del agente apunta a su Agent Card; un sobre puede transportar una tarea A2A. Nyx5 le da a A2A dirección por persona y buzón; A2A le da a Nyx5 el ciclo de vida de tareas largas.
- **Email**: una estafeta con la extensión `email` es también servidor SMTP del dominio. Es la puerta de entrada al mundo actual: la misma dirección sirve para humanos y agentes.

## 6. Hoja de ruta

| Fase | Entrega | Criterio de éxito |
|---|---|---|
| 0 (hoy) | Referencia local: Correo + Libro, spec, CLI, puente MCP, 20 pruebas | `npm test` en verde |
| 1 | Piloto en casa: tus sesiones y agentes con cuenta; cada cajita lleva cotización escrow; Verifica como primer servicio medido; presupuesto mensual por frente como `topup` | telemetría real: cuánto costó cada entrega, qué reportes afianzados cayeron |
| 2 ✅ | HECHO 2026-09-05: dos estafetas en producción (chsq.uk + b.chsq.uk) sobre D1; falta el ancla DNS TXT | un agente externo escribe, cotiza y paga estampilla desde afuera — verificado E2E |
| 3 | Puente SMTP (extensión `email`), retención, métricas; carga de saldo con dinero real (Paddle) y payout a terceros | humanos y agentes en la misma dirección; primer tercero que acepta tokens |
| 4 | Contratos compuestos según demanda (bounty, suscripción, RFQ, disputa); reputación como consulta pública sobre contratos | spam y palabras gratis económicamente inviables |
| 5 | Custodia de claves con passkeys, extensión `person`; spec como borrador abierto y segunda implementación | personas comunes con agente propio; dos implementaciones interoperando |

## 7. Decisiones y sus renuncias

| Decisión | Por qué | Renuncia |
|---|---|---|
| Direcciones `local@dominio` y DNS como ancla | Reutiliza la única infraestructura de nombres universal que existe; los dominios ya tienen dueño, abuso y reputación conocidos | Dependes del DNS y de tener un dominio (como el email) |
| Ed25519 / X25519 | Rápidos, claves de 32 bytes, sin parámetros que elegir mal, nativos en Node | Sin post-cuántico todavía; `alg` explícito permite migrar |
| JSON canónico en vez de binario | Legible, depurable, compatible con todo | ~30 % más grande que CBOR |
| Store-and-forward con cola en cada dominio | Es lo que hace al email resiliente; un agente apagado no pierde nada | Latencia de segundos, no milisegundos; para tiempo real usa A2A directo |
| Cifrado extremo a extremo por defecto | Las estafetas son terceros; no deben leer | Búsqueda y filtrado en el servidor son imposibles; los hace el agente |
| Proof-of-work y allowlist antes que pagos | Funciona sin infraestructura financiera | El pow es solo fricción; el spam a gran escala requiere estampillas pagadas (fase 3) |
| Sin blockchain | El DNS ya resuelve nombres y la firma ya resuelve autenticidad; un ledger global agrega costo sin resolver el buzón ni el spam | Sin registro global inmutable de identidades |
| Un Libro por casa, no federado | Un ledger central con una casa responsable es lo que hace ejecutable el escrow y la fianza; federar libros es construir un sistema de compensación | Los tokens no cruzan casas; un foráneo abre cuenta en la tuya |
| El Libro sin login | Reusar la firma del sobre elimina onboarding y una segunda identidad; cualquier agente verificable ya es cliente | El Libro depende del Correo; no puede correr solo |
| Cotización como documento firmado, no como sobre | Puede viajar cifrada y presentarse después a la casa sin revelar el sobre | Dos firmas que verificar por aceptación |
| Federado, no centralizado | Nadie es dueño de la red; cualquiera monta una estafeta | La adopción depende de que muchos la monten |
