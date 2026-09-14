# Bitácora

Lo que se hizo, con fecha, y lo que queda abierto. Lo autorizó Nicholas el 8-sep-2026: *"puedes
llevar tu propio to-do-list con fechas marchando los completados"*.

Regla de esta lista: una línea entra sólo si alguien puede comprobarla. "Avanzado" no es un
estado. O está hecho y verificado contra el terreno, o está abierto y dice qué falta.

## Abierto — de Nicholas

Nada de esto lo puede hacer la sesión: exige sus credenciales, su firma o su criterio.

| | Qué | Desde |
|---|---|---|
| ☐ | **Leer y aprobar `docs/TERMS.md`**. Se sirven sólo si él los enciende: son declaraciones vinculantes en su nombre | 8-sep |
| ☐ | **Cuenta prepago para el agente** (Mercado Pago empresa de Blue Tuna SpA, $30.000, logueada una vez en Chrome) para repetir la compra chilena con plata del agente | 14-sep |
| ☐ | **Liberar el escrow** `ae65c82b` (500 tokens a compras@) cuando llegue el pedido de Mercado Libre; recordatorio en su buzón el 15-sep | 14-sep |
| ☐ | **Marca INAPI** clase 42, en pausa hasta la vuelta (`marca/SOLICITUD-MARCA-NYX5.md`) | 13-sep |
| ☐ | **AP2**: ¿se queda mapeado o se le construye la segunda llave ECDSA? Recomendación: dejarlo mapeado | 9-sep |
| ☐ | **x402**: ¿la comisión de la casa puede seguir saliendo de lo que recibe el receptor? Si x402 responde que no, el binding exige cambiar cómo se asienta la comisión. Preguntado en su issue #3435 | 9-sep |

## Abierto — de la sesión

| | Qué | Desde |
|---|---|---|
| ☐ | **Al retomar tras el mes de Nicholas (Mac apagado, nada corre)**: leer el buzón de nicholas@ (recordatorios semanales y sus respuestas por nico@); aprobación de la maqueta v2 (`plan/maquetas/app-colaboracion-v2.html`, entregada sin OK) y luego la app real (NX-408/409, dinero real arriba en «Ahora») | 14-sep |
| ☐ | Los ~20 hallazgos medios/bajos de la revisión adversarial | 5-sep |
| ☐ | Ancla DNS TXT `_nyx5.<dominio>` en producción | 5-sep |
| ☐ | Reclamar el listado de glama.ai con OAuth de GitHub | 8-sep |

## Hecho

### 14-sep-2026 (tarde) — dos compras reales, NX-502 desplegado, el pagador x402 y el Spec de la app
Nicholas pidió pruebas de impacto real, no de escritorio. Dos compras, con lectura distinta:
- **Compra en Mercado Libre por el agente** (`compras@nyx5.com`, servicio en catálogo, escrow 500
  tokens): contratado en un paso por nicholas@, el agente eligió envío y medio de pago y pagó desde el
  Chrome logueado del dueño ($25.409, n.º 2000015028526003). Comprobante sellado
  (`ebb40537`), contrato `delivered`. Lectura honesta de Nicholas, correcta: plata del dueño en su
  cuenta = **escritura contable**, no valor. Evidencia: `plan/pruebas/2026-09-14-compra-real-mercadolibre.md`.
- **El agente pagó con SU billetera** (NX-108): keccak-256 y secp256k1 (RFC 6979, ecrecover) en JS
  puro, firma EIP-3009, `pagar()` con tope obligatorio. Compra real: 100 píxeles en 402milly.xyz con el
  ícono de Nyx5 y link a nyx5.com, US$1,00 USDC en Ethereum, tx `0x38cc7715…76a7` (bloque 25977280,
  gas del facilitador; saldo 2,49 → 1,49). Sello `9ac3cc65`. Costó tres tropiezos medidos: 402milly lee
  `X-PAYMENT` con cuerpo v1 (ahora van las dos cabeceras), el motivo del rechazo viene en el cuerpo,
  y `/upload` devuelve un formulario presignado de S3. Evidencia: `plan/pruebas/2026-09-14-pago-x402-real.md`.
- **NX-502 pedido de pago por transferencia**: textos aprobados tal cual, CLP y USD, RUT completo;
  `nyx5_payment_request` / `nyx5_payment_confirm`, tarjeta y formulario en /app, eventos sin monto ni
  RUT. Revisión (5ª): 3 medios en `cobro` y 4 en `pagador`, todos cerrados con grito y silencio.
  **Desplegado en las dos casas** y verificado (/app sirve los rótulos). Fuera: la herramienta en el
  conector remoto (la casa vería el RUT en claro).
- **La app como herramienta de colaboración** (NX-408, nuevo): Spec pedido a `qa@` y sellado
  (`8e5b1e30`, sha256 bf3093ae…); maqueta en construcción con ese contrato de aceptación.
- **Ruta de conversaciones con proyectos** (`projects`, `pending_by_project`, `?project=`), sexta revisión (7 hallazgos, 34 viñetas rotas del sitio de la spec arregladas, suite `fuente-limpia` contra invisibles y NUL), **desplegada en las dos casas**. Suite: 340 -> 393.
- **Smithery**: `nicholasiakl/nyx5` publicado con la URL del conector remoto (OAuth del escáner sobre claude.nico@); release SUCCESS, quality score 51/100.
- **Cierre 1 a 1 con Nicholas (tarde):** DNSSEC quedó firmado solo (DS en .com, whois signedDelegation); **TERMS aprobados y publicados** en /terms de las dos casas (fecha 14-sep, enlace en la portada y en el sitemap; NYX5_TERMS=on; test/terms.test.js); textos de NX-402 aprobados tal cual; **registro oficial de MCP actualizado a 0.7.0** (mcp-publisher con la sesión de gh); la maqueta v2 no le gustó (serif/crema, densidad, estructura): v3 en construcción con estructura WhatsApp y estilo Slack/Linear. Suite 395.
- **Maqueta v2** de la app (auditoría contra Slack/WhatsApp/Asana/Salesforce → Home «Ahora», cinco lugares, ⌘K, Dinero con tres saldos); 24 de 29 criterios; entregada a Nicholas sin aprobación (viaje de un mes). Escrow de la compra liberado por su decisión; topes de API del mes: US$15.

### 14-sep-2026 (mañana) — contratar en un paso, plantillas, qa@ como servicio, y el fondo
Cuatro agentes en paralelo con el método de la noche; fusionados, revisados (cuarta revisión: 4
hallazgos probados, todos cerrados antes de salir) y **desplegados en las dos casas**, con la
migración 0009 aplicada. Verificado contra el terreno: `verifica@` anuncia seis pruebas, el
historial por lotes responde, `qa@nyx5.com` existe con precio y Gate.
- **Contratar en un paso** (NX-305): `nyx5_hire` pide, el vendedor cotiza desde su catálogo y el
  comprador acepta solo si la cotización es EXACTAMENTE la publicada sobre su input. La revisión
  probó que bastaba el tipo de prueba correcto con la URL del vendedor para cobrar sin trabajar:
  ahora se compara la prueba entera.
- **Plantillas para frameworks** (NX-803): Claude Agent SDK, OpenAI Agents SDK, LangGraph, CrewAI y
  HTTP puro en `examples/frameworks/`, con la firma Ed25519 en Python canónica byte a byte.
- **qa@ como servicio** (NX-606 fase 1): `qa@nyx5.com`, asistente de la casa con cuenta en el
  Libro; crédito prepago por `pay`; Spec 400, Gate 400, abstención 200; el Gate exige el contrato
  sellado en la notaría. La revisión probó que un buzón con estampilla le vaciaba el saldo: ya no
  contesta a buzones que cobran. `qa.nicholas@` (fase 0) queda en pausa.
- **verifica@ con siete pruebas, hallazgos medios y guion de revisión** (NX-602/905/903): ver la
  entrada de la rama `fondo`. La revisión probó que el guardia de regex se daba la razón solo
  (`a*a*b` colgaba 20 s): ahora está acotada por construcción y línea por línea; y que verifica@
  seguía redirecciones a loopback y aceptaba `DELETE`: sólo https públicos, GET/HEAD, sin seguir.
- **Aviso por correo** con remitente, proyecto y hora (texto aprobado por Nicholas); nunca el contenido.
- Suite: 307 -> 340. npm @nyx5/nyx5 0.7.0 publicado (con token con bypass de 2FA, 30 días).

### 14-sep-2026 (día) — tres piezas de fondo, en la rama `fondo` (fusionada y desplegada en la mañana)
- **verifica@ con siete pruebas** (NX-602): `json_path` acepta `a.b[0].c` y `exists`; nuevas `regex`
  (primer MB, patrón acotado por sintaxis: sin referencias hacia atrás ni cuantificador sobre grupo
  con cuantificador o alternancia; falso positivo visible, nunca silencioso), `size` (bytes que
  llegan, no `content-length`) y `header`. Cada una pasa/falla/indecisa como las demás; probadas
  contra un servidor local y por mutación. La ficha y la tarjeta de verifica@ las toman de la misma
  lista. SPEC §22 y README.
- **Hallazgos medios de las tres revisiones** (NX-905): (a) `first_message` se queda contando al
  encolar; el informe ya lo etiqueta «First message sent». (b) el reloj de la casa leía la tabla de
  contratos entera en cada tick: `libroListContracts({ state })` en FileStore y D1, con índice de
  expresión (migración 0009, **pendiente de aplicar en los dos D1 al desplegar**), y una prueba que
  exige que el plan lo use. (c) el rastreo del índice hacía 1+N subpeticiones por casa ajena:
  `GET /agents/historial?addresses=…` (público, tope 50, por IP, mismo `null` para inexistente,
  ajeno y secreto) y el rastreo lo usa por lotes. (d) y (e) ya estaban cerrados.
- **Revisión adversarial por versión** (NX-903): `scripts/revision-adversarial.md` con los trece
  puntos de las tres revisiones y cómo se ejercita cada uno; `npm run revision` corre los
  automatizables contra una casa local con tres estados (ok/falla/indecisa) y `test/revision.test.js`
  lo hace en cada `npm test`, inyectando tres defectos para comprobar que grita. La primera corrida
  encontró **cinco rutas que daban 500** ante `%E0%A4%A` (la tercera revisión había cerrado una):
  ahora `handleRequest` decodifica con `dec()` y todas caen al mismo 404/400 que un inexistente.
- Abierto que dejó a la vista: la cubeta de tasa del registro cuenta sólo después de verificar la
  firma; un POST sin firmar cuesta una verificación Ed25519 y no se limita.
- Suite: 291 -> 307.

### 14-sep-2026 (madrugada) — el registro de comercio, la notaría y la boleta
Nicholas se fue a dormir con la instrucción «sigue con lo que más puedas, dejando todo en productivo
ordenado para probarlo inmediatamente». Cinco piezas en paralelo, cada una en su worktree por un
agente distinto, fusionadas en main y pasadas por una revisión adversarial conjunta antes de salir:
- **Catálogo de servicios en la ficha** (NX-301): `profile.services` con precio, unidad, contrato y
  prueba de aceptación; una cotización que nombra un `service` tiene que coincidir con lo publicado
  o el Libro la rechaza nombrando la diferencia.
- **Boleta y estado de cuenta** (NX-501): `fee`/`commission` en cada recibo con asiento; `statement`
  por rango con saldo inicial, movimientos, totales y saldo final que cuadran; `GET /libro/estado`
  en JSON o CSV (RFC 4180, sin fórmulas).
- **Búsqueda con reputación** (NX-302): `/index/agents` con filtros, cursor keyset (nunca offset:
  trampa «ventana horneada e isla»), puntaje sólo por veredictos de `verifica@` ponderado por
  monto; sin historial va al final, nunca como 100 %. Migración 0007 (recrea la tabla del índice).
- **Notaría** (NX-601, gratis por decisión de Nicholas): `notarize { sha256 }` sella con firma y
  fecha de la casa, sin asiento; `GET /notaria/<sha256>` verifica sin cuenta; un declarante secreto
  no se nombra. Migración 0008.
- **Embudo medido** (NX-801): `open_invite`, `claude_connected`, `first_message`; `GET /informe`
  privado (Bearer de la casa) con el embudo por fuente y por semana. El `/report` público no cambia.
- **qa@ fase 0** (NX-606): `qa.nicholas@nyx5.com`, un asistente con persona de Spec sobre la
  especificación, el plan y la Constitución; cada respuesta termina con su sha256 (lo calcula la
  casa) para sellarla en la notaría. Cinco pedidas tomadas del plan; tope US$5 autorizado.
- Textos de la app para NX-402 y NX-502 redactados para aprobación (privado, `plan/textos-app-borrador.md`).
- **Tercera revisión adversarial** (sobre las cinco piezas fusionadas): 11 hallazgos, ninguno crítico;
  cerrados antes de desplegar los que bloqueaban (open_invite se inundaba con 80 GET; `reconciled:false`
  era silencioso; el contrato no guardaba `service`; `capability` sin acotar y LIKE sin ESCAPE en D1;
  fechas del estado sin zona; `/notaria` compartía cubeta con `/resolve` y un id mal codificado daba 500).
- **Desplegado en nyx5.com y b.nyx5.com** con las migraciones 0007 y 0008 aplicadas en los dos D1, y
  verificado contra el terreno: sello real de `nicholas@` creado y verificado sin cuenta; CSV del
  estado con saldos; `/informe` 401 sin llave; la tarjeta de `libro@` anuncia `notarize`.
- **qa@ fase 0, medido**: los dos primeros defectos fueron de infraestructura, no del Spec: la API moría
  en 524 a los 100 s (todas las llamadas del asistente van ahora en flujo SSE) y el esfuerzo alto
  gastaba los 12.000 tokens pensando sin escribir (ahora medio, con 24.000). Además, con cinco
  pedidas en cola el asistente veía todas en un turno y contestó una con los contratos de otras dos:
  lo que sigue en cola ya no entra al historial. Resultado: cinco contratos de aceptación, uno por
  ítem (NX-402, 502, 601, 604, 701), guardados en privado (`plan/qa/`) y **sellados en la notaría**
  de producción con el hash que la casa calculó. Los cinco preguntaron algo que no estaba pensado
  (precio y rail de premium; qué pasa con un intro rechazado que tenía aval; dos confirmaciones para
  un mismo pedido de pago; si un agente ya registrado debe re-aceptar términos; qué pasa con dos
  direcciones que sellan el mismo hash): 5 de 5, el criterio de aceptación pedía 4 de 5. Costo
  medido: US$0,67 en total, US$0,14 por Spec bueno (Sonnet 5, esfuerzo medio, ~30k tokens de
  conocimiento en caché). Precio: decisión de Nicholas (propuesta: costo × 3).
- Suite: 249 -> 291. Versión 0.7.0 lista; `npm publish` exige el código 2FA de Nicholas.

### 13/14-sep-2026 (noche) — conversar de a varios, sin perder el consentimiento
- **Grupos** `g.<nombre>@casa` (NX-401): la casa reparte el mismo sobre firmado a cada miembro,
  cifrado para cada uno, y nunca lo lee; historial en el buzón del grupo; un miembro nuevo no ve lo
  anterior. **Revisión adversarial con dos críticos probados** antes de desplegar: el reparto no
  consultaba la política de cada buzón, así que cualquiera metía a cualquiera en un grupo y le
  saltaba la lista blanca, incluso al asistente de Sigo, gastándole presupuesto. Cerrado con
  consentimiento en dos capas (sólo se agrega a quien ya te acepta; cada miembro recibe sólo de
  quien su buzón acepta), el asistente ignora grupos, y el reparto cuenta en el límite de tasa.
  Primera versión: miembros de la misma casa.
- **Proyecto y rol por chat** (NX-407): extensión firmada en el sobre y filtro por proyecto en
  espera, buzón e historial. Una dirección por chat no es viable (Claude tiene una conexión OAuth
  por conector); esto sí.
- **Acuse de lectura y presencia** (NX-406), opt-in en la tarjeta: recibo de la casa al confirmar,
  «visto por última vez» por hora fuera de la tarjeta firmada.
- **Ficha pública** (NX-201, servidor): vocabulario cerrado, links sólo https, dentro de la tarjeta
  certificada; sólo el dueño la edita; un Claude de sólo mensajes no la reescribe. La pantalla en la
  app espera el texto aprobado por Nicholas.
- **Revisión adversarial de proyecto, lectura y ficha** (scripts, no opinión): dos ALTOS probados y
  cerrados antes de desplegar. Cualquier sobre `receipt` con `read_of` marcaba leído lo que fuera
  (un extraño hacía creer que Basti ya leyó): ahora sólo vale el del postmaster de la casa del
  lector, y si ese lector era destinatario. Diez idiomas de 180 KB hacían una tarjeta de 1,8 MB
  firmada por la casa: tope por etiqueta. Además: proyecto y rol se limpian y acotan (un proyecto
  de 200.000 caracteres llegaba tal cual a la herramienta), homógrafos normalizados, bidi y ancho
  cero fuera de la ficha, links sin usuario en la URL, y un delegado de sólo mensajes no edita ni su
  propia ficha.
- **Límites de tasa durables** (NX-901): el contador vive en D1, no en la memoria de cada isolate
  (antes el límite real era N veces el declarado, con N desconocido, y todos los agentes de la casa
  compartían un balde: uno solo frenaba a los demás). Ahora por dirección, dominio o IP, con
  `Retry-After`. Si D1 falla, deja pasar: precisión sobre cobertura.
- **Visibilidad secreta** (NX-202): `/resolve` contestaba 200 o 404 y con eso se enumeraban los
  nombres de la casa. Un agente `secret` responde a quien no está en su lista exactamente lo que un
  inexistente (probado byte a byte en cuerpo y cabeceras, en siete rutas y en la puerta de
  entrada). Entre casas, la casa que pregunta firma para quién pregunta.
- **Escrow que vence** (NX-503): un escrow vencido ya no queda retenido para siempre. Sin entrega,
  el comprador lo recupera pasado el plazo más 24 h de gracia; entregado y sin objeción en 72 h, la
  casa lo libera al vendedor desde su reloj, firmando de `libro@` a `libro@` por `inbound`.
  Decisión tomada por defecto (Nicholas la marcó como suya): 24 h y 72 h, configurables por casa.
- **Segunda revisión adversarial** (tasa, visibilidad, escrow): NX-901 y NX-503 pasaron; NX-202
  tenía cuatro canales que distinguían un secreto de un inexistente, tres sin credencial (un token
  inválido daba 401 vs 404; la casa hacía un fetch saliente sólo si el nombre existía; el 409 del
  secreto salía antes de pedir firma; `evil.alicia` contaba como su delegado). Los cuatro cerrados
  con prueba. Notas de diseño anotadas en SPEC: escrow sin árbitro = pago diferido;
  `entregas_por_silencio` aparte en el historial.
- **Desplegado el 14-sep-2026 en nyx5.com y b.nyx5.com** y verificado contra el terreno: el
  contador durable escribe en el D1 de producción (`tasa/resolve:<ip>:<ventana>` = 4 tras 4
  resolves), `/agents/<nadie>` con y sin token contesta el mismo 404, la SPEC publicada trae
  visibilidad y reclaim/expire, y la tarjeta de `libro@` anuncia por fin todas las ops (estaba
  con las de hace una semana: ahora se re-certifica cuando cambian). Pendiente de Nicholas: la
  pantalla de la ficha en la app (texto), y las decisiones que ya estaban en el tablero.
- Suite: 226 -> 249.

### 13-sep-2026 — el canal cuenta la conversación
- Tres defectos reportados por el Claude del teléfono de Nicholas probando el canal de verdad:
  una respuesta con `in_reply_to` iba sin `thread` (la conversación quedaba como mensajes sueltos:
  ahora el cliente hereda el hilo, porque la casa no puede tocar un sobre firmado); `nyx5_wait`
  devolvía un mensaje viejo como si fuera la respuesta (ahora lo entrega marcado
  `arrived_before_wait`, y sin `since` espera desde ahora); y `since` filtra por `received`, que
  `nyx5_inbox` no mostraba (ahora sí). Suite: 225 -> 226.
- `code.nicholas` pasó a lista blanca. Búsqueda de la marca en INAPI: «nyx5» sin coincidencias.

### 12-sep-2026 — que nada venza en el viaje
- **Conectores de 50 días** (`NYX5_REMOTE_DAYS`, eran 30) y **reconectar conserva los contactos**:
  la pantalla viene marcada en «sólo tú» y reconectar reemplazaba la lista; a Basti le habría
  cortado las respuestas del agente de Sigo al vencer su conector el 11-oct.
- Agente de Sigo vigente hasta el 31-oct; buzón de ideas (`code.nicholas`) hasta el 30-nov.
- Suite: 224 -> 225.

### 11-sep-2026 (noche) — pagar directo, y la invitación de la Pauli
- **`pay {to, amount, concept}`**: tokens de una persona a otra sin cotización ni contrato. Lo firma
  el que paga; el que recibe no hace nada y los dos reciben el recibo. Sólo dentro de la casa, sólo a
  una dirección que existe, y nunca a un subagente de sólo mensajes (no podría gastarlo: se le paga
  al dueño). **Sin fee**: decisión de Nicholas del 11-sep, "0,5% en trabajo, 0% entre personas".
  Producción cobraba 20% sobre el token, un número anterior a la decisión del 10-sep: bajado a 50 bps.
- **Defecto evitado antes de que la Pauli lo viera**: su invitación prellenaba "pauli", un nombre
  tomado desde el 7-sep. Su primer "Connect" iba a rebotar con "that name is taken". La pantalla ya
  no sugiere un nombre tomado, reservado o corto; se comprueba al MOSTRAR, no al crear. Test escrito
  contra el defecto y comprobado que falla sin el arreglo.
- **Ruta de dinero en Chile investigada** (fuentes primarias, 11-sep): transferencia bancaria entre
  personas ~0% y en segundos; CLP→USDC→CLP por Buda ~10,6% con CLP 5.000 (0,5% por lado + 0,5 USDC
  fijos, leído de su API). Buda retira USDC por Ethereum y Solana, no Base. OrionX cerró el 3-sep.
- **10.000 tokens de `nicholas@` a `nico@`** con `pay`, fee 0 (asiento 7ef627c1), autorizado por
  Nicholas para mandar desde el teléfono en el viaje. Verificado en D1: 10.000 y 10.000.
- **Botón "Send tokens" en la app**: pide monto, confirma, recibo legible en el chat con `libro@`, y
  saldo en Settings. Probado en local en un teléfono emulado (5.000 -> 4.000, sin fee). Oculto en
  chats donde no se puede pagar (`libro@`, otra casa, un Claude de sólo mensajes).
- **Defecto encontrado en la revisión, antes de publicar**: la app convertía en "X sent you 1,000
  tokens" CUALQUIER mensaje con forma de recibo, así que un extraño podía fingir un pago. Ahora
  sólo lo hace si el sobre viene de `libro@` de la casa. `test/app-recibos.test.js` corre la función
  real de la app, y se comprobó que la versión vieja deja pasar el recibo falso.
- **Revisión adversarial independiente (agente cto), dos hallazgos probados y cerrados:**
  - ALTO: los límites de un delegado (sólo mensajes, types, to_domains) sólo se aplicaban en
    `/outbound`. Un subagente de sólo mensajes pagaba entregando su sobre directo a `/inbound`, que
    es público por la federación. Ahora los aplican las dos puertas y el Libro en su propia entrada.
    Reproducido antes del arreglo: el bot pagó 100.
  - MEDIO: con `pay` sin fee, un pago de 1 token dejaba un aviso de `libro@` en un buzón que cobra
    500. El aviso al que recibe ahora obedece a su buzón; el pago ocurre igual.
  - Menores: montos sobre 2^53 rechazados; la app sólo acepta enteros ("1,5" ya no se lee como 15)
    y se bloquea mientras paga (un doble toque = un pago, probado en el navegador).
- **Agente de Sigo en marcha**: Nicholas puso `ANTHROPIC_API_KEY` (secret de Cloudflare, nunca en
  git). Primera respuesta real en 106 s; costó US$0,657 con Opus 5 y la caché fría, el doble de lo
  estimado. Por decisión de Nicholas pasa a **Sonnet 5** (US$2/US$10 contra US$5/US$25). Nuevo
  `PUT /admin/assistants/<l>/config` que rechaza un modelo sin precio conocido, y el respaldo del
  servidor (`fallbacks: "default"`) va sólo al modelo donde está documentado. Medido con Sonnet 5:
  US$0,26 por pregunta suelta (97 s).
- **Inspección antes del viaje de Nicholas (un mes desde el 14-sep):** cero secretos en todo el
  historial de git y en el paquete de npm (0.6.0, al día); dominio vence en 2027-09. Hueco cerrado:
  con el registro abierto, CUALQUIER agente podía mandarle correo a cualquier persona con nuestra
  cuenta de Resend y nuestro dominio (directo, o anotando un `notify_email` ajeno y mandándose
  mensajes). La salida de correo ahora está cerrada salvo `NYX5_EMAIL_SENDERS` (vacío = nadie). La
  entrada de correo sigue abierta y pasa por la política del buzón.
- **Contactos por la casa**: `POST /admin/contacts {between:[a,b]}` conecta dos direcciones de la
  casa en los dos sentidos (revisa ambos lados antes de escribir). Nació para dejar conectados el
  Claude del teléfono de Nicholas y el de Basti sin que Basti reconectara el suyo.
- Suite: 213 -> 224.

### 11-sep-2026 (tarde) — invitaciones, asistentes y el primer contacto real
- **Primera conversación real** entre el Claude del teléfono de Nicholas (`claude.nico`) y Claude Code
  en su Mac (`code.nicholas`), por nyx5.com, cifrada y firmada. claude.ai se registró solo.
- **Primera prueba de inyección pasada**: su Claude pidió por el canal mandar un correo en su nombre;
  no se ejecutó sin su confirmación directa.
- **Invitaciones**: un link por WhatsApp, la pantalla prellenada, contacto mutuo. La de la Pauli, en
  camino. Anotaciones MCP de sólo lectura para pedir menos permisos.
- **Asistentes**: `sigo.nicholas@nyx5.com` contesta solo, con tope de US$30, para Basti.
- **Seis choques de puertos entre suites** que el guard no veía (uno lo causé yo). Guard ampliado.
- Suite: 206 -> 213.

### 10/11-sep-2026 — el WhatsApp de los agentes
- **Conector MCP remoto en producción: `https://nyx5.com/mcp`.** Cualquier Claude (web, Desktop,
  teléfono) lo agrega con esa URL, sin instalar nada. OAuth 2.1 como lo exige Claude (registro
  dinámico, PKCE S256, recurso amarrado, canje por formulario, refresco con rotación).
- Quien autoriza es el dueño, desde su navegador, firmando una delegación para
  `claude.<dueño>@<casa>`. La casa guarda sólo esa llave, cifrada. Tres límites aprobados por
  Nicholas: sólo mensajes, vence y se revoca, custodia declarada en la tarjeta.
- **Tiempo real e historial**: espera larga en `/mailbox/<l>/wait` y `nyx5_wait`; historial en la
  casa con `/conversations` y `nyx5_conversation`. Medido en producción: respuesta en ~3,4 s.
- **La app estaba rota en producción** (la CSP bloqueaba todo fetch) y se decía que funcionaba.
  Arreglada y reescrita: chats, entrega en vivo, cifrado en el navegador, consentimiento del
  conector, revocar, respaldo de llave, instalable en la pantalla de inicio.
- **Falla en producción que los tests no podían ver**: workerd no tiene `diffieHellman`. El primer
  mensaje cifrado del Claude remoto falló en nyx5.com con todo verde. Sonda en workerd real,
  arreglo por WebCrypto, recorrido completo en workerd antes de redesplegar, y guardia.
- Suite: 187 -> 204. Todo recorrido en producción con identidades `prueba-conector-*`.

### 10-sep-2026
- **Saldo de bienvenida a CERO.** Era 20.000 por agente y alcanzaba para 800 estampillas, así que
  volvía gratis la defensa contra el spam. Se comprobó antes de tocarlo que un agente con cero
  puede ganar sus primeros tokens en el mostrador: quedó con 160 tras entregar y ser verificado.
  Desplegado en las dos casas.
- **Cobrado dinero REAL.** US$0,01 en USDC sobre Ethereum, tx `0xfed9ce65…2021`, bloque 25948376.
  Nyx5 hizo de servidor de recurso completo y el facilitador liquidó y pagó el gas. Comprobado
  leyendo el recibo de la cadena, no el `success:true`.
- **El número que importa**: el facilitador gastó US$0,286 de gas para mover US$0,01. En Ethereum
  un pago de un centavo sólo existe porque alguien lo subsidia; en Base cuesta una fracción de
  centavo. El protocolo funciona en las dos, la economía no.
- **Seis redes reales a la vez**: Ethereum, Base, Polygon, Arbitrum, Optimism y Avalanche, más el
  token de la casa. Un agente declara varias billeteras y su buzón anuncia una opción por cada
  una. Nadie queda excluido por la cadena en que tenga fondos.
- Lección de diseño que costó dos intentos: una autorización EIP-3009 vence, y firmar de antemano
  para liquidar después falla con `invalid_timing`. En el flujo real el agente firma al pagar.

### 9-sep-2026
- **Cerrada una brecha real: la puerta del correo se saltaba toda la política del buzón.** Un buzón
  que cobraba 500 y otro con lista blanca cerrada aceptaban los dos un correo de un desconocido,
  gratis. Lo peor no era el spam: el precio que la casa anuncia por x402 era evitable escribiendo un
  correo. Ahora el correo pasa por la política, comparada contra el remitente real, y falla cerrado
  cuando el mecanismo no existe sobre correo. El rechazo vuelve como rechazo SMTP, sin backscatter.
  Comprobado en producción con un buzón que cobra 25: el correo salió y no llegó nada.
- **PR a x402 desbloqueado.** Exigen commits firmados y cierran el PR tras una semana sin
  actividad. El commit se firmó con SSH usando la llave personal de Nicholas, y él la registró en
  GitHub como Signing Key, que es una entrada distinta de la de autenticación. `check-verified-commits`
  pasó. Queda esperando revisión humana. El rojo de Vercel NO es nuestro: para un PR externo, alguien
  del equipo de Coinbase tiene que autorizar el despliegue de vista previa.
- **Cerrado el hueco de los mandatos** (lo decidió Nicholas). Una restricción que el Libro no sabe
  aplicar ya no se guarda: el mandato se rechaza al crearlo diciendo qué clave sobra y qué sí se
  aplica, y un mandato viejo que la lleve no cobra. Se agregó `max_per_charge`, que se comprueba en
  cada eslabón de la cadena. Comprobado con el caso exacto que fallaba: antes 90.000 pasaban de un
  golpe contra un tope declarado de 500, ahora ni se crea. Escrito también en la spec y desplegado.
- **Propuesta abierta en el repo de x402** ([issue #3435](https://github.com/x402-foundation/x402/issues/3435)):
  el binding de Nyx5 y las dos preguntas que expuso. No se mandó el documento del binding porque
  el esquema `exact` exige que a `payTo` le llegue el monto anunciado, y nuestra casa descuenta la
  comisión de ahí. Filarlo igual sería leer por encima de un MUST.
- **PR enviado a x402** ([#3436](https://github.com/x402-foundation/x402/pull/3436)): §11.1 pasa a
  decir la gramática de CAIP-2 y que el punto no es legal en una reference. Comprobado contra el
  documento de CAIP-2, no contra un resumen. Es independiente de la pregunta anterior.
- **Adaptador x402 v2 desplegado y verificado en producción.** `GET /x402/supported`,
  `GET /x402/inbox/<nombre>`, y `POST /inbound` respondiendo 402 con `PAYMENT-REQUIRED` o 202 con
  `PAYMENT-RESPONSE`. Comprobado contra nyx5.com: un buzón de 25 tok anuncia "25", rechaza sin
  estampilla, cobra con estampilla, y el `transaction` publicado resuelve a un asiento cuadrado.
- **Mapeo AP2 v0.2 escrito** (`docs/interop/ap2.md`), contra los JSON Schema reales. Hallazgo que
  cambia el rumbo: AP2 prohíbe Ed25519 por nombre. No reclamamos conformidad en ninguna parte.
- **Guard de honestidad de los mapeos** (`test/interop.test.js`): cada fila lleva veredicto, cada
  documento dice contra qué versión se comprobó y qué NO reclama.
- Cuatro chequeos de x402 en `scripts/auditar-produccion.sh`. 30 chequeos, 0 rotos.
- 171 pruebas, 0 fallos.

### 8-sep-2026
- Sprint §6 completo (join, mandate, verifica, historial público, tareas sembradas, vocabulario
  ACP, instrumentación) desplegado y ejercido contra la casa real.
- Distribución §7: npm `@nyx5/nyx5` 0.2.4, registro oficial de MCP `io.github.Nicoiakl/nyx5`,
  inglés como idioma primario, bundle `.mcpb`.
- Auditoría externa aplicada: HEAD, cabeceras de seguridad y caché, favicon, sitemap, og:image,
  redirecciones de http y www, tarjeta del dominio persistida.
- Portada reescrita: en positivo, en una plana, y diciendo dónde se pega lo que se copia.
- Pie del correo saliente aprobado y encendido.
- Nombres de 1 a 3 caracteres reservados.
- Verificado que la Agentic Payments Alliance no es un estándar: sin especificación ni repositorio.

### 7-sep-2026
- Casa oficial migrada a nyx5.com con D1 limpio. Repositorio público, CI verde.
