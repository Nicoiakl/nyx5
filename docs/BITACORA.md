# Bitácora

Lo que se hizo, con fecha, y lo que queda abierto. Lo autorizó Nicholas el 8-sep-2026: *"puedes
llevar tu propio to-do-list con fechas marchando los completados"*.

Regla de esta lista: una línea entra sólo si alguien puede comprobarla. "Avanzado" no es un
estado. O está hecho y verificado contra el terreno, o está abierto y dice qué falta.

## Abierto — de Nicholas

Nada de esto lo puede hacer la sesión: exige sus credenciales, su firma o su criterio.

| | Qué | Desde |
|---|---|---|
| ☐ | **Cuenta prepago para el agente** (Mercado Pago empresa de Blue Tuna SpA, $30.000, logueada una vez en Chrome) para repetir la compra chilena con plata del agente | 14-sep |
| ☐ | **Liberar el escrow** `ae65c82b` (500 tokens a compras@) cuando llegue el pedido de Mercado Libre; recordatorio en su buzón el 15-sep | 14-sep |
| ☐ | **Enchufar los ejecutores de la fábrica de Rosetta**: (1) decidir a qué repositorio apunta cada rol (hoy la fábrica no tiene uno solo; `RosettaQuantum/quantum-run` es el candidato), (2) un PAT con *Contents: read and write* sobre ese repo — va a la casa por `POST /admin/executors`, nunca por el chat, (3) el workflow `examples/ci/nyx5-ejecutor.yml` y el secret `NYX5_KEY` en ese repo. La casa ya está desplegada y espera | 27-oct |
| ☐ | **Marca INAPI** clase 42, en pausa hasta la vuelta (`marca/SOLICITUD-MARCA-NYX5.md`) | 13-sep |
| ☐ | **AP2**: ¿se queda mapeado o se le construye la segunda llave ECDSA? Recomendación: dejarlo mapeado | 9-sep |
| ☐ | **x402**: ¿la comisión de la casa puede seguir saliendo de lo que recibe el receptor? Si x402 responde que no, el binding exige cambiar cómo se asienta la comisión. Preguntado en su issue #3435 | 9-sep |

## Abierto — de la sesión

| | Qué | Desde |
|---|---|---|
| ☐ | **Al retomar tras el mes de Nicholas (Mac apagado desde el 15-sep)**: leer el buzón de nicholas@ e `GET /ideas` (lo que dejó desde el celular); aprobación de la maqueta v3 y luego la app real (NX-408/409, MINIMAL); decisiones de su Claude del celular pendientes: granularidad de verifica@ en lote, rol del token-wallet, qa@ con memoria por cliente | 14-sep |
| ☐ | **La carrera en la lectura del historial del asistente** (`test/asistente.test.js:91`). Con dos preguntas seguidas, el turno de la SEGUNDA llevaba el historial viejo pero NO la primera, recién contestada: el agente contesta dos cosas cercanas sin acordarse de la primera. Apareció en el CI de Node 20 el 29-oct. **El 29-oct por la tarde el CI quedó VERDE en Node 20 y 24** — pero no toqué la lectura del historial, así que es UNA muestra y probablemente los tiempos cayeron del otro lado, no un arreglo (`estable-no-es-correcto`). Queda abierto hasta entender la lectura o tener varias muestras | 29-oct |
| ☐ | Los ~20 hallazgos medios/bajos de la revisión adversarial | 5-sep |
| ☐ | Ancla DNS TXT `_nyx5.b.nyx5.com` **de la casa beta**. La de `nyx5.com` **ya está** y su `sig` coincide con la llave de la tarjeta: comprobado el 3-nov por DNS-over-HTTPS, que es el instrumento correcto porque el resolver de este Mac no sale a UDP/53. La beta responde NODATA y cae al well-known, que es el camino legítimo | 5-sep |
| ☐ | Reclamar el listado de glama.ai con OAuth de GitHub | 8-sep |
| ☐ | **Token de automatización de npm** (npmjs.com → Access Tokens → Granular, sólo `@nyx5/nyx5`, permiso de publicación) pegado como secret `NPM_TOKEN` del repo. Sin él la publicación sigue pidiendo su 2FA, que es exactamente la causa de que la puerta sirviera septiembre durante 7 semanas (NX-807) | 3-nov |

## Hecho

### 3-nov-2026 — la puerta de entrada servía septiembre (NX-807, NX-808)

Nicholas preguntó cómo se hace masivo esto y si valían dos correos que le ofrecían posicionamiento
(mcprush, get agensi). Fui a ver el terreno antes de opinar, y el terreno dijo otra cosa.

**Adopción externa: cero.** 33 agentes se registraron solos en producción (`via=open`) y los 33
son nuestros: `prueba-*`, `claude-*` (la CLI autonombra por runtime), `x402*`, `dual-*`,
`vigia@`, `nico@`. 32 fueron en septiembre. Desde el 15-sep hubo **uno**, el 29-oct
(`instinct-74ad6780@`, nombre que no sale de `detectarRuntime`, así que puede ser de fuera) y
no mandó ni un mensaje. De los 8 `first_message` de la historia, ninguno es de un agente llegado
solo salvo `nico@`, que es él.

**El hallazgo que me corrigió la hipótesis.** Iba a escribir «el embudo se fuga en la activación».
No se sostiene: no hubo tráfico que fugar. Lo que hay es que **nunca se publicó nada** — ni un
post, ni un listado enviado más allá de Smithery. Y la puerta, cuando por fin alguien la toque,
sirve esto:

**npm servía `@nyx5/nyx5` 0.7.0 del 14-sep, 61 commits atrás.** Un desconocido que instalara hoy
no tenía `attach`, `attachment`, `ejecutor`, `nyx5_attach`, `nyx5_attachment`, `nyx5_hire`,
`nyx5_payment_confirm`, `nyx5_payment_request`, `nyx5_qa_gate` ni `nyx5_qa_spec`. O sea: el
dolor con el que se presenta Nyx5 —pasarse archivos entre agentes— no lo podía resolver nadie de
fuera, ni por el camino fácil ni por el difícil.

**La causa estaba escrita en esta misma bitácora el 14-sep**: *«`npm publish` exige el código 2FA
de Nicholas»*. La publicación quedó colgada de que él estuviera frente al teclado, él se fue un
mes, y nada gritó. **Y el número de versión no podía gritar: npm y el repo decían los dos 0.7.0**,
así que cualquier chequeo que comparara versiones daba verde con la puerta podrida — el mismo
defecto de «la guardia comprueba el objeto, no el número».

Hecho (commit `794e03d`, en main):

- `scripts/puerta-npm.mjs` compara la **superficie** que ve el desconocido —comandos de la CLI y
  herramientas MCP, leídos del código, no de una lista a mano— contra el tarball publicado.
  **Grito**: contra 0.7.0 nombra los 3 comandos y las 7 herramientas que faltan.
  **Silencio**: con el paquete publicado puesto como repo, sale 0. Las dos pruebas contra objetos
  reales, ninguna contra un literal que yo inventé.
- `.github/workflows/puerta.yml`: al entrar algo a main y cada lunes. **No en los PR**, a
  propósito: un PR no puede cerrar ese rojo y un rojo que nadie puede cerrar se vuelve ruido.
- `.github/workflows/release.yml`: publica **la casa, no el Mac** — token de automatización (sin
  2FA), al empujar una etiqueta, sólo si la suite pasa, con procedencia, y abortando si la etiqueta
  no coincide con `package.json`.
- Versión 0.8.0. La subí y **la guardia que ya existía me pegó en la mano**:
  `test/documentacion.test.js:40` exige que `src/version.js` diga lo mismo, porque el edge no
  puede leer `package.json`. Faltaba ese archivo. Eso es el sistema funcionando.

**Dos sustos que no eran.** (1) `join` contra producción murió con `DNS unavailable ... ETIMEOUT`
y parecía que la puerta estaba cerrada para todos; es este Mac, que no sale a UDP/53 — ni a
1.1.1.1. Por DoH el ancla TXT de `nyx5.com` **existe** y su `sig` coincide con la tarjeta, así
que corregí la fila de arriba que la daba por pendiente desde el 5-sep. (2) Creí que el ancla no
estaba porque la bitácora lo decía. **Una fila abierta no es una medición**: envejece igual que un
reporte.

**Lo que el conector fácil no puede hacer (NX-808).** El conector remoto no manda archivos **a
propósito**: la casa guarda esa llave delegada, así que el adjunto le pasaría en claro por delante
y caería el invariante 8 (está comentado en `herramientas.js:275`). Correcto, y hoy **no se dice**:
el agente remoto simplemente no ve las herramientas. Queda como decisión suya porque es texto que
lee un usuario, y porque arrastra una segunda pregunta que es sólo de él: si se dice en público que
una llave delegada la puede leer la casa.

**Los dos correos: no.** «mcprush» no aparece en la web ni buscándolo por su nombre — un directorio
que no se encuentra a sí mismo no manda a nadie. Agensi (agensi.io, Países Bajos, 2026) es un
mercado de *skills* que le cobra US$9/mes al agente: no es un canal, está en nuestra vereda.
Listados gratis sí (NX-804, P2); plata por posicionamiento no, y nuestra propia medición del 8-sep
ya decía que la demanda no vive en los directorios.

Suite: 506, 504 pasan. El único rojo es el de DNS de este Mac (`visibilidad.test.js`, 49 s contra
su límite), el mismo de siempre.

### 2-nov-2026 (tarde) — NX-413 DESPLEGADO en las dos casas, y verificado contra el terreno

Nicholas aprobó el despliegue completo, incluido el texto público nuevo de `/spec` (§5b). Buckets
`nyx5-blobs` y `nyx5-blobs-b` creados, binding `BLOBS` en los dos toml, `chsq` en la versión
`a6217c4e-fe45-42f3-a840-7d86dc4796bf` y `chsq-b` en `3271ddde-c879-42eb-acf8-1ec6e26deb4b`.

**Lo que se comprobó, y cómo** — nada de esto sale de la salida de wrangler:

- Las dos tarjetas del dominio anuncian los cupos: `max_bytes` 10 MB, 10 por sobre, 25 MB por
  sobre, 30 días, `A256GCM`. Antes no anunciaban nada, porque no había dónde guardar.
- `GET /blob/<inventado>` sin firma contesta **401**, no 503: el almacén existe y la autenticación
  se evalúa antes que la existencia.
- La sección §5b está servida en `https://nyx5.com/spec`.
- **El síntoma de Nicholas, en producción**: un archivo de 144 bytes con una cadena testigo mandado
  por `nyx5 attach --send` a través de nyx5.com, bajado con `nyx5 attachment`, `diff` limpio.
- **El invariante 8, contra el D1 real** (tabla `nyx5_mailbox`, no la `chasqui_mailbox` vieja): el
  sobre guardado NO tiene la llave, NO tiene el nombre del archivo, NO tiene el contenido. Lleva
  afuera exactamente `{"blob": …, "bytes": …}` y el cuerpo cifrado.
- **El objeto en el bucket real**: 172 bytes para 144 de claro (12 de IV + 16 de tag), ruido, sin
  la cadena testigo. Leído con `wrangler r2 object get`.
- **La prueba verificada por mutación** (no sólo corrida): con `encryptBlob` devolviendo el claro,
  la prueba del invariante 8 GRITA. Pasa por la razón correcta.
- `npm test`: 506 pruebas, 505 pasan. El único rojo sigue siendo `visibilidad.test.js`, que falla
  por el DNS de esta máquina con dominios `.test` (25 s y ETIMEOUT) y ya fallaba antes de la rama.

**Un susto propio que vale anotar.** La salida de `nyx5 inbox` mostraba el array de adjuntos con el
nombre, el tipo y **la llave**, y pareció una fuga grave. No lo era: el CLI descifra el sobre con la
llave del dueño y muestra el sobre ABIERTO. Lo que la casa guarda se le pregunta a la casa, no al
cliente que ya descifró — y al preguntarle primero miré la tabla equivocada (`chasqui_mailbox`, de
septiembre, con 2 sobres) y por un momento pareció que el buzón de producción se había vaciado. Dos
veces en diez minutos, la misma lección: **el terreno de esta pregunta es el D1 de la casa, y hay
dos generaciones de tablas en la misma base.**

**Y una medida de paso, que es el argumento de NX-414**: el buzón de `nicholas@` devolvió **50
sobres con el cuerpo completo** en una sola lectura. Leer la bandeja para encontrar UN sobre costó
arrastrar los otros 49.

### 2-nov-2026 — adjuntos cifrados: el sobre lleva archivos de verdad (NX-413, rama `adjuntos`)
Nace de un sintoma de Nicholas: «me ha pasado varias veces que un agente de cowork le manda un
mensaje a un agente de code y el agente de code me acusa que recibio el mensaje, solo que no
recibio los archivos». La causa medida: `attachments` estaba publicado en la spec desde la fase 0,
`politica.js` lo validaba, `agente.js` lo metia en el sobre, y **ninguna casa alojaba un byte** —
cero usos en las herramientas MCP, cero en la CLI, cero en todo `test/`, y ningun binding R2. Un
agente que decia «te adjunto los archivos» mandaba rutas de SU maquina. No era una funcion nueva:
era cerrar una promesa que llevaba meses publicada.

- **El archivo va cifrado y la casa no lo puede leer.** AES-256-GCM, una llave aleatoria por
  adjunto, objeto autocontenido `iv(12) || ct || tag(16)`, AAD `nyx5:blob:<blobId>:<from>`. La
  llave viaja en `attachments[].key` DENTRO del bloque cifrado del sobre.
- **La prueba del invariante 8 se escribio ANTES del codigo** (commit `c1ee42d`, que falla con
  `ERR_MODULE_NOT_FOUND` a proposito): una cadena testigo va dentro del archivo y no aparece en el
  objeto crudo del almacen, ni en sus metadatos, ni en el sobre del buzon, ni en ningun archivo de
  ninguna de las dos casas. Pasa, y el nombre del archivo tampoco aparece en ninguno de esos sitios.
- **El array de afuera lleva solo `blob` y `bytes`** en un sobre cifrado, con vocabulario CERRADO:
  una clave de mas se rechaza por nombre. `balance-despido-javier.pdf` dice casi todo sin abrirlo,
  asi que el nombre es contenido. Se aparta del invariante 7 a proposito, como `ALCANCE_MANDATO`.
- **La url no viaja: se deriva** de la casa del remitente. Una url firmada en el sobre seria una
  url que alguien puede cambiar por otra.
- Cupos: 10 MB por adjunto, 10 adjuntos y 25 MB por sobre, 100 MB por remitente y dia UTC, 1 GB por
  casa. Retencion de 30 dias, o 7 desde que todos los destinatarios lo bajaron, con limpieza por
  reloj y aplicada tambien al LEER (si el reloj se cae, un vencido no se baja igual).
- `nyx5_attach` / `nyx5_attachment` y `nyx5 attach` / `nyx5 attachment`. Fuera del conector remoto,
  por el mismo motivo que el pedido de pago: alli la llave vive en la boveda y el archivo pasaria
  por la casa en claro.
- **Verificacion por mutacion: doce mutantes, doce gritos.** Tres no gritaban en el primer barrido y
  ninguno estaba mal — lo debil era la prueba: el vocabulario cerrado no se probaba porque el
  cliente de la casa nunca manda un campo prohibido afuera (ahora el test re-firma un sobre real y
  lo entrega por `/outbound`); el tope de 10 MB de la casa no se probaba porque el cliente rechaza
  antes (ahora se golpea la ruta); y la retencion al leer no se probaba porque el test borraba el
  objeto antes de pedirlo.
- **Tres defectos encontrados de paso**, dos de ellos ajenos a este item:
  1. `FileStore` implementa el almacen en SINCRONO y `D1Store` en async real, asi que un `.catch()`
     pegado al resultado de una llamada al almacen revienta en local y andaria en produccion. Es el
     espejo de la trampa de siempre, y la cabecera de `almacen.js` ya avisaba: se espera con await.
  2. `hasEnc` vale `undefined` (no `false`) para un sobre en claro, y un `undefined` ACTIVA el valor
     por defecto del parametro: los adjuntos de un sobre en claro se validaban con las reglas del
     cifrado y se rechazaban todos.
  3. El guion de mutacion restauraba los archivos con `git checkout --` y se comio un arreglo que
     todavia no estaba commiteado; el barrido quedo midiendo contra una base rota y lo delato el
     numero de fallos (2 donde debia haber 1). Se mide desde una base COMMITEADA.
- **No desplegado**: el bucket R2 y el binding los pone Nicholas (arriba, en lo abierto).


### 29-oct-2026 (noche) — el aviso por correo ya dice de qué se trata
Nicholas: «me llegan mails de Nyx5 pero no sé qué significan ni qué hacer con ellos». Medido en su
Gmail: **once avisos en treinta días**, todos con la misma forma `X wrote to you on Nyx5 (project
Y)`. La casa no podía decir más — el cuerpo va cifrado y no lo lee (invariante 8).
**Desplegado** (`chsq` 1e8c0171, `chsq-b` 5aed2e80) con su texto aprobado: el REMITENTE adjunta una
línea SIN cifrar (`urn:nyx5:ext:resumen`) y la casa la pone en el asunto. Llega hasta la herramienta
MCP `nyx5_send { summary }`, que es por donde escriben su Claude del celular y las rutinas.
**VERIFICADO CONTRA EL TERRENO, no contra el deploy**: sobre real `7cd4e69a` mandado a producción con
la llave de `nicholas@`, cuerpo cifrado y resumen en claro, y en su Gmail llegó el asunto
`nicholas@nyx5.com · prueba: Prueba del resumen en claro: si lees esta linea en el asunto, el aviso ya
dice de que se trata`. Sobre de prueba confirmado después, para no dejar basura.
Guardias: una línea con `\r\n` no abre una cabecera nueva (`limpio` colapsa los controles), tope 140,
invisibles y bidi fuera, vacío se rechaza al enviar, y **sin resumen el aviso queda byte a byte** como
el del 14-sep. Dos mutantes, dos gritos. npm test 476 -> 480. SPEC §23g, ARQUITECTURA §4.10.

### 29-oct-2026 (noche) — centinela del grupo, y el buzón compartido que yo mismo iba a tapar
Nicholas borró el PAT, así que el ejecutor en CI queda sin enchufar. Verificado que nada se rompió:
`gh` sigue con su llavero, `.env` sin ningún token de GitHub, cero ejecutores en producción.
Eligió la rutina en la nube. **Dos muros, los dos medidos antes de construir:**
- Una rutina con el conector NO ve el encargo en su buzón: quien manda a un grupo nunca recibe su
  propia copia (`if (dir === env.from) continue` en el reparto del grupo). Sí lo ve en el HISTORIAL
  del grupo (`nyx5_conversation with: g.rosetta@`), comprobado con los dos encargos reales.
- `Projects/Rosetta Quantum/` **no es un repositorio git** y ahí viven `calcular_qex.py`,
  `regen-cliente-santander.mjs` y los entregables. Una rutina en la nube no tiene nada que clonar,
  así que NO puede correr la medición. Construirla igual habría sido una promesa vacía.
**Hecho:** `trig_0193xQKHQQqyEsqHiJfyMgCE` «Centinela de encargos · g.rosetta@», cuatro veces al día,
sonnet-5-5, sólo el conector de Nyx5, `Workflow` prohibido. Lee el historial del grupo y avisa por
push UNA vez si un encargo lleva más de 6 h sin que nadie de otra dirección responda. No contesta, no
manda nada, y NUNCA confirma un sobre.
**Probado en producción a pedido de Nicholas** (corrida manual, 19:11 UTC, 16 s, 5 turnos, sonnet):
leyó su memoria (vacía, nada avisado), pidió el historial del grupo por el conector —el punto de
diseño que no estaba seguro— y le llegaron los dos encargos reales, pidió la hora UTC con `date` en
vez de suponerla, y **se calló**: el encargo de Santander llevaba 3 h 35 min y el umbral es 6 h.
O sea quedó probada la mitad del SILENCIO, que es la que más cuesta. La mitad del AVISO no: cruza las
6 h a las 21:36 UTC, así que la corrida de las 00:47 UTC (21:47 Chile) es la que avisa.
**Y una cosa que hay que saber antes de recibir ese push:** el trabajo de Santander SÍ avanza en el
Mac, pero nadie ha reportado nada al grupo, y el propio encargo pedía «entregables por este grupo».
El centinela va a decir «sin tomar» con razón sobre el grupo y engañando sobre la realidad: el aviso
es correcto y lo que empuja es que alguien reporte ahí.
**Y un defecto que yo introduje esta misma tarde, arreglado antes de que mordiera:** el PASO 2 que le
escribí a One Piece decía «regístralo y después confírmalo» para CADA sobre. El buzón de
`claude.nico@` lo comparten tres (su Claude del celular, su Claude web y la rutina) y ahí caen los
sobres de los grupos: One Piece habría confirmado la respuesta de un rol de Rosetta al encargo de
Santander y se la habría ESCONDIDO a su Claude. Ahora clasifica TUYO/AJENO y en lo ajeno no toca
`nyx5_ack`; lo anota como 'ajeno' y lo deja pendiente.
**Santander NO está parado**: `entregables/santander-2026-11/` se movió hoy a las 13:32 y a las 16:03
(T3 contestado con recómputo, CT de octubre bajado, script del borde en vivo). El trabajo va en su Mac.

### 29-oct-2026 (tarde) — un encargo por grupo no despertaba a nadie, y era una regla mía
Nicholas: su Claude web mandó el paquete Santander a `g.rosetta@` —plazo lunes 2-nov, reunión el
martes 3— y después encontró a Rosetta Q Main dormido. Preguntó por qué no lo despertó.
**El envío fue real**: sobre `22423aa8`, 15:36 UTC, de `claude.nico@` a `g.rosetta@`, proyecto
santander, rol cowork, entregado al primer intento (202). Su Claude no le mintió.
**Por qué no despertó, dos razones, y la segunda es mía:**
1. `rosetta@` es un BUZÓN. Rosetta Q Main es un chat en su Mac; la casa entrega y nunca arranca una
   sesión. Hoy despiertan tres cosas: cerebro en la casa (reloj), rutina en la nube (cron) y
   ejecutor cableado a CI (webhook, 27-oct, todavía sin enchufar). `rosetta@` no es ninguna.
2. **Y aunque lo fuera, un sobre de GRUPO no despertaba a nadie** — regla que escribí el 26-oct en
   los dos caminos: «un grupo es un camino que la lista del buzón no eligió». Cierta para quince
   miembros conversando, falsa para un encargo con plazo. El único canal que uno usa para repartir
   trabajo era el único que no podía despertar.
**Hecho, con su OK, desplegado (chsq 50524ba3, chsq-b fa9e04d6):** un encargo por grupo despierta si
el SOBRE declara la intención (tipo `task`, o proyecto Y rol) — no la palabra del texto. La charla
sigue sin despertar. `esEncargo`/`porGrupo` en `asistente.js`, y `ci.js` las IMPORTA: una prueba
cruza los dos caminos y otra prohíbe que el ejecutor reescriba la suya. La respuesta va a QUIEN
ENCARGÓ, nunca al grupo.
**Dos defectos de antes que sólo se vieron al abrir esa puerta:**
- El candado del turno era `asistente-turno:<id>`, sin la dirección. Un sobre con VARIOS
  destinatarios lo contestaba UNO: el primer reloj lo tomaba y los demás buzones lo veían ocupado
  para siempre. No era exclusivo de los grupos (pasaba con un directo a dos asistentes). Ahora
  `<local>:<id>`. Verificado por mutación: con la clave vieja, de dos cerebros contesta uno.
- **Una prueba mía que pasaba por una razón falsa**: en `test/ci.test.js`, los seis casos de «lo que
  NO despierta a un ejecutor» usaban la clave `env` y `despachable` lee `envelope`; le llegaba
  undefined y salía por «sin firma». Seis en verde sin ejercer ninguno. Reescrita, y ahora el
  fixture se comprueba ANTES de usarlo.
npm test 473 -> 476. SPEC §23f, ARQUITECTURA §4.9.
**Lo que esto NO resuelve, y hay que decirlo:** `g.rosetta@` no tiene ningún miembro que pueda
despertar. El protocolo ya deja pasar el encargo; falta que alguna dirección del grupo tenga cerebro
(no sirve para archivos) o **ejecutor en CI**, que es lo que espera el PAT de Nicholas. Santander, de
aquí al martes, se mueve con la sesión de Rosetta Q Main, no sola.

### 29-oct-2026 — el agente One Piece tenía Nyx5 enchufado y no lo usaba
Nicholas: «intenté que un agente de Claude use Nyx5 para One Piece y al parecer no lo logró». Tenía
razón. La rutina llamaba `nyx5_inbox` y `nyx5_whoami` bien cada 3 horas desde el 28-oct; lo que no
pasaba era nada, por tres causas medidas en el log de las corridas:
- **Cero tráfico de One Piece.** 15 sobres en el buzón de `claude.nico@`, todos del 11 al 15 de
  SEPTIEMBRE: qa (6), nyx5-qa (2), santander (1), sin proyecto (6). El propio agente lo dijo el
  28-oct: «no hay sobres nuevos de One Piece».
- **Nadie confirmaba el buzón**, así que cada corrida bajaba los mismos 50,5 KB — sobre el tope de
  un resultado de herramienta, así que además gastaba un turno de Bash+python para leer su propio
  buzón. 8 veces al día, para encontrar lo mismo.
- **La salida no se ejercía nunca.** Su canal real era `PushNotification`, que es de una sola vía.
**Hecho:** los 15 sobres confirmados (`nyx5_ack` no borra: `ackMail` sólo estampa `acked` y
`nyx5_conversation` los sigue mostrando — comprobado en el código, no supuesto; buzón en 0, historial
intacto en 36 mensajes). Y el PASO 2 de la rutina reescrito con el OK de Nicholas: leer, registrar y
**confirmar**, y dejar el estado del día en `nicholas@nyx5.com` con proyecto 'onepiece' para que él
conteste desde el celular y el agente lo lea en la corrida siguiente. Eso NO va al push.
**Trampa nueva de la API de rutinas:** `RemoteTrigger update` **reemplaza `job_config` entero**. Con
sólo `events` da 400; con `environment_id` + `events` te borra `allowed_tools`, `disallowed_tools` y
`mcp_config` en silencio. Pasó: se restauraron los 31 `allowed_tools` y los 3 `disallowed_tools`
(entre ellos `Workflow`, que en una rutina desatendida gasta). `mcp_connections` es de primer nivel y
sobrevive. Quedó fuera a propósito el `custom_system_prompt` (74 KB de prompt de plataforma viejo,
ahora lo pone la plataforma) y `mcp_config` (el puente de dispositivos, que One Piece no usa).
**Pendiente de él:** la delegación `claude.nico@nyx5.com` vence el **3-nov**; cuando vence, todo
agente que hable por el conector remoto pierde Nyx5.

### 27-oct-2026 (tarde) — ejecutores: el aviso de la casa cableado al CI de los roles que trabajan sobre archivos
Desplegado en las dos casas (`chsq` a744f50a, `chsq-b` 28c41226) y verificado contra el terreno:
`/admin/executors` contesta 401 en nyx5.com y b.nyx5.com, y una ruta inexistente sigue dando 404.
Es la otra mitad de NX-412: lo de la mañana despertó a los agentes que **piensan**; esto despierta a
los que **ejecutan**. Medido con la fábrica de Rosetta: 7 de sus 8 roles trabajan sobre archivos.
- **Lo que hace:** cuando un encargo llega a una dirección con ejecutor, la casa dispara el CI del
  proyecto. El aviso **no lleva el contenido**: el cuerpo sigue cifrado en el buzón y lo abre el job
  con la llave del rol, que vive en un secret del repositorio y nunca pasó por la casa.
- **La casa avisa y no cierra el sobre.** Tres intentos con espera creciente y, al agotarse, el dueño
  recibe un sobre que nombra el encargo, el repo, la razón y cómo reintentarlo. Nada se calla.
- **El token de CI** va cifrado en la bóveda y es de **sólo escritura**: ninguna lectura lo devuelve.
  El destino se **deriva** del `repo` (lista cerrada de proveedores): con una URL libre la casa sería
  un diputado confundido que manda ese token a donde le digan.
- **Un sobre lo contesta UNO**: cerebro en la casa o ejecutor en CI, con 409 en los dos sentidos.
- **La revisión encontró tres**, los tres arreglados con prueba de grito: la configuración de CI se
  leía en CADA entrega a CUALQUIER dirección (una lectura de base por sobre y por destinatario);
  el cupo del día se cobraba antes de leer el token, así que un ejecutor sin token gastaba despachos
  que nunca salieron; y la redacción del token miraba sólo su forma, no su valor.
- **Un defecto que la suite no veía**, cazado mirando un archivo de verdad de la fábrica: `ejecutor`
  esperaba la llave PLANA y `nyx5 keygen` escribe `{address, estafeta, keys:{…}}`. Un secret armado
  con el archivo del disco habría fallado en el primer job con todo verde. Ahora acepta las dos
  formas y un mapa de varias, para que un repositorio sirva a los siete roles con un solo secret.
- **Recorrido en workerd REAL** (token de CI falso, cero gasto): el disparo SALE del borde y GitHub
  contesta `401 Bad credentials` — o sea que la petición llegó con su cabecera —, el token se abre de
  la bóveda en D1 real, el estado y el cupo quedan escritos, el buzón sigue pendiente, y un aviso con
  firma falsa se rechaza sin leer nada. Suite 444 -> 472. SPEC §23f, ARQUITECTURA §4.9.
- **Lo que NO está probado y lo digo:** que GitHub ACEPTE el cuerpo del disparo. Eso exige un token
  real, y el token es de Nicholas.

### 27-oct-2026 — agentes vivos: una dirección puede pensar y actuar sin el Mac de Nicholas
Desplegado en las dos casas. Cualquier dirección se **adopta** (su llave va a la bóveda, la tarjeta
declara `custody.keys = house`) y recibe cerebro con **cinco manos de lista cerrada**: enviar dentro
de su lista, buscar en el índice, leer historial, notarizar y recordarse. **Nada que mueva dinero**,
y eso vive en el código, no en la persona. Nace apagada; se enciende explícitamente.
- **Defecto vivo cerrado:** un sobre de tipo `task` se ignoraba en silencio para siempre. El Gate de
  `qa@` llevaba **42 días** sin respuesta. Al desplegar, lo contestó en el primer tick.
- **La revisión encontró un ALTO:** el contador de gasto se leía-sumaba-escribía, así que dos relojes
  hacían dos llamadas a la API y anotaban una. El único freno de plata contaba de menos. Ahora es
  atómico, en micro-dólares, y el mes en curso no se reinicia.
- Otros cuatro medios: 10 envíos por minuto con un tope que decía 5; el cupo de despertares se cobraba
  al mirar y no al atender; `ideas@` era alcanzable (el alta se agrega sola a toda lista); la guardia
  del Libro miraba sólo esta casa.
- Decisiones de Nicholas: 40.000 caracteres por mensaje y 6 turnos de historial (antes el costo crecía
  al cuadrado y la conversación se trababa para siempre en el turno 13); `ideas@` inalcanzable.
- **Medido en producción:** `nyx5-experto@` adoptado y encendido contestó desde el reloj, firmó con su
  propia llave y usó una mano. 3 llamadas, **US$0,0199**. `qa@`: 1 llamada, US$0,0407. Suite 409 -> 444.
- Y antes: la ruta `/og/` de Rosetta desplegada y verificada, con el 500 latente del sitemap cerrado.

### 15-sep-2026 (madrugada) — primer trabajo real entre agentes por Nyx5, y todos los chats con dirección
- **Los 20 chats del equipo tienen dirección** en nyx5.com (tabla chat → dirección → grupo en la memoria
  compartida `nyx5-direcciones-del-equipo`): 10 de Rosetta (públicos), 6 de Sigo, norte@, nyx5-experto@,
  patagonia@, contratos@; grupos g.rosetta@, g.sigo@, g.coordinacion@. Cuatro chats cerrados o personales sin dirección.
- **Santander pasó entero por Nyx5**: encargo de nicholas@ al grupo; Rosetta Q Main (rosetta@) verificó cifras,
  encontró 3 cortes de impresión que el LEEME negaba y 6 defectos de contenido, pidió la confirmación de Nicholas en
  su chat antes de actuar, y **selló los PDF finales** en la notaría (largo a43048538e60… sello 5f2dda91; corto
  b82da0b6152e… sello 03b95476, ambos por rosetta@, verificados contra /notaria). El comando de impresión quedó
  como script reproducible (`imprimir.sh`) porque Rosetta se negó a reconstruirlo a ojo.
- Lo que mostró: una dirección no despierta a su chat (NX-412), y el agente receptor aplica la regla de
  confirmación del dueño sin que nadie se lo recuerde.

### 14-sep-2026 (noche) — el buzón de vacaciones, las direcciones de Rosetta y el paquete Santander
Tres pedidos que llegaron por Nyx5 desde el Claude del celular de Nicholas (buzón code.nicholas@):
- **ideas@nyx5.com** (NX-411): recibe de la lista del dueño, guarda IDEA-nnn con fecha, confirma con
  texto fijo, y NUNCA ejecuta (la única salida del módulo es la confirmación; guardia por mutación,
  10/10 mutantes gritan). Séptima revisión: 6 medios cerrados (puerta propia contra intros, cupo diario
  200 ideas / 5 MB por remitente, rebote SMTP del correo, registro autocurable, paginado, guardia
  cerrada). Desplegado y dado de alta; **IDEA-001 confirmada en producción** en 48 s por el cron.
  Falta la prueba desde el celular con el Mac cerrado. Suite 395 -> 409.
- **Direcciones de Rosetta**: rosetta@ (Rosetta Q Main) y rosetta-security@ inscritos, públicos, con
  lista blanca, indexados; grupo g.rosetta@ (admin nicholas@); `.mcp.json` del proyecto Rosetta Quantum.
- **Paquete Santander**: la segunda edición del informe PQC NO existe como medición (sólo un prototipo
  simulado) y el informe individual de Santander tenía cifras equivocadas en el HTML (46 / «apagado»);
  se regeneró desde el JSON corregido (56 / borde con PQC) y se entregaron dos PDF para que Nicholas
  revise y mande él. Evidencia en `Projects/Rosetta Quantum/entregables/santander-2026-09-14/`.
- qa@ sí contestó sola la pedida del celular (21:20 → 21:22 UTC): el servicio corre sin el Mac.

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
