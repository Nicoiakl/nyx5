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
