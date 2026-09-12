# Bitácora

Lo que se hizo, con fecha, y lo que queda abierto. Lo autorizó Nicholas el 8-sep-2026: *"puedes
llevar tu propio to-do-list con fechas marchando los completados"*.

Regla de esta lista: una línea entra sólo si alguien puede comprobarla. "Avanzado" no es un
estado. O está hecho y verificado contra el terreno, o está abierto y dice qué falta.

## Abierto — de Nicholas

Nada de esto lo puede hacer la sesión: exige sus credenciales, su firma o su criterio.

| | Qué | Desde |
|---|---|---|
| ⏳ | **DNSSEC** en nyx5.com. NO es un clic pendiente: el panel dice "pending while we automatically add the DS record" y el único botón que ofrece es Cancel Setup, en rojo. Pero el DS no está en el registro .com y whois sigue diciendo `unsigned`, o sea que lleva colgado. Nadie debe tocar ese botón. Si sigue así, hay que cancelar y volver a encender, o abrir un ticket | 9-sep |
| ☐ | **Leer y aprobar `docs/TERMS.md`**. Se sirven sólo si él los enciende: son declaraciones vinculantes en su nombre | 8-sep |
| ☐ | **Smithery**: `smithery auth login && smithery mcp publish dist/nyx5-*.mcpb -n <namespace>/nyx5` | 8-sep |
| ☐ | **AP2**: ¿se queda mapeado o se le construye la segunda llave ECDSA? Recomendación: dejarlo mapeado | 9-sep |
| ☐ | **Escrow con `reclaim`**: hoy un contrato que llega a su plazo sin que nadie decida sólo manda un aviso, y la plata sigue retenida. El rail al que mapeamos le da al comprador una salida unilateral. Es un hueco nuestro, arreglable en el Libro, independiente de todo lo del dinero real | 9-sep |
| ☐ | **x402**: ¿la comisión de la casa puede seguir saliendo de lo que recibe el receptor? Si x402 responde que no, el binding exige cambiar cómo se asienta la comisión. Preguntado en su issue #3435 | 9-sep |
| ☐ | **`ANTHROPIC_API_KEY`** para que `sigo.nicholas@` conteste solo (workspace con tope US$30): `npx wrangler secret put ANTHROPIC_API_KEY` | 11-sep |

## Abierto — de la sesión

| | Qué | Desde |
|---|---|---|
| ☐ | Los ~20 hallazgos medios/bajos de la revisión adversarial | 5-sep |
| ☐ | Ancla DNS TXT `_nyx5.<dominio>` en producción | 5-sep |
| ☐ | Reclamar el listado de glama.ai con OAuth de GitHub | 8-sep |

## Hecho

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
