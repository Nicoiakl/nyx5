# Revisión adversarial — guion por versión (NX-903)

Lo que las tres revisiones de la noche del 13/14-sep-2026 probaron y encontraron, convertido en
una lista que se recorre entera antes de desplegar cada versión. Cada punto dice **cómo se prueba**
(con un comando o un script, no con una opinión) y **qué se encontró la primera vez**, para que quien
lo repita sepa qué forma tiene el defecto.

La parte que no exige juicio la corre `npm run revision` (`scripts/revision-adversarial.mjs`) contra
una Estafeta local; `test/revision.test.js` la corre en cada `npm test`. La parte que sí lo exige
está marcada con **[manual]** y se recorre a mano, con el script que se nombra en cada punto.

Regla de la lista: un punto entra sólo si se puede ejercitar. "Revisado" sin comando no es un estado.

## 1. Oráculos de existencia (un secreto se ve como inexistente)

Un agente `secret` tiene que contestar a quien no está en su lista **exactamente** lo que un nombre
que no existe: mismo estado, mismas cabeceras (salvo `date`), mismo cuerpo. Cuatro canales
distinguían un secreto de un inexistente en la segunda revisión:

- **401 vs 404**: un token inválido daba 401 si el nombre existía y 404 si no. `_quienPregunta` se
  evalúa siempre, antes de tocar el almacén, y un token inválido cuenta como nadie.
- **Latencia**: la casa hacía un `fetch` saliente a la otra casa sólo cuando el nombre existía.
  Se mide con dos nombres y un reloj; hoy el orden es el mismo exista o no.
- **409 temprano**: al registrar, el 409 "nombre tomado" salía **antes** de pedir la firma, así que
  bastaba un POST sin firmar para enumerar. Ahora el secreto exige la prueba de posesión primero.
- **`evil.alicia`**: el sufijo del nombre contaba como delegado de `alicia`. Se lee la tarjeta del
  que pregunta; el sufijo no basta.

Automatizado: `404-secreto` en el script (11 rutas, cuerpo y cabeceras byte a byte).
Prueba: `test/visibilidad.test.js` (siete rutas y la puerta de entrada) y `test/historial-lote.test.js`.
**[manual]** cualquier ruta nueva que confirme que una dirección existe pasa por `_visibleA` y
entra en `RUTAS_CON_NOMBRE` del script; si no está ahí, no se revisó.

## 2. Inundación de eventos

`open_invite` se registraba en cada GET a `/i/<código>`: 80 GET inundaban el embudo con una vista
previa de WhatsApp. Se deduplica por código, canal, IP y hora.
**[manual]** por cada evento nuevo del diario: ¿lo dispara una petición sin credencial? ¿cuántas
filas mete un bucle de 100 GET? (`for i in $(seq 100); do curl -s -o /dev/null URL; done` y contar en
`/eventos`).

## 3. Recibos falsificables

Cualquier sobre `receipt` con `read_of` marcaba leído lo que fuera: un extraño hacía creer que
Basti ya leyó. Ahora sólo vale el del postmaster de la casa del lector, y si ese lector era
destinatario. Prueba: `test/lectura.test.js`.
**[manual]** por cada campo nuevo que un sobre pueda "afirmar" sobre otro (`read_of`,
`in_reply_to`, `veredicto`): ¿quién puede emitirlo, y lo comprueba la casa o se lo cree?

## 4. Tarjetas gigantes

Diez idiomas de 180 KB hacían una tarjeta de 1,8 MB firmada por la casa; un proyecto de 200.000
caracteres llegaba tal cual a la herramienta MCP. Tope por etiqueta, proyecto y rol acotados.
Automatizado: `cuerpo-gigante` (2 MB a `/agents` y `/inbound`: 4xx o conexión cortada, nunca 5xx ni
aceptado). Pruebas: `test/perfil.test.js`.
**[manual]** por cada campo de texto nuevo en tarjeta, ficha o sobre: ¿tiene tope? ¿se firma después
de recortar o antes?

## 5. Homógrafos, bidi y ancho cero

Un nombre con caracteres invisibles o confundibles pasaba como distinto del legítimo. `limpio`
normaliza homógrafos y quita ancho cero y bidi de la ficha; los nombres de agente son ASCII.
**[manual]** con un script ad hoc: registrar `alicia` y luego el mismo nombre con U+200B dentro y
con la `a` cirílica (U+0430); los dos tienen que rechazarse o colapsar al mismo. Escribir los invisibles con
escapes `\u200B`, nunca el carácter literal (se corrompe al editar).
Que ningún literal quede en la fuente lo cuida `test/fuente-limpia.test.js`, no un `grep`: en esta máquina
`grep` es una función de shell que envuelve otro buscador y dio 0 con un NUL y dos U+200B literales presentes
(14-sep-2026). La herramienta que escribe archivos convierte un escape tipeado en el carácter literal: después
de escribir una prueba con invisibles, correr esa suite antes de commitear.

## 6. CSV con fórmulas

Un concepto que empieza con `=`, `+`, `-` o `@` se ejecuta al abrir el estado de cuenta en una hoja
de cálculo. `csvDe` escapa (RFC 4180) y no deja fórmulas sueltas. Prueba: `test/estado.test.js`.
**[manual]** por cada exportación nueva (CSV, TSV): un concepto `=1+1` y otro `@SUM(A1)` tienen que
salir como texto al abrirlos.

## 7. Cursores fabricados

El índice paginaba por `offset` y una fila que se movía entre páginas se saltaba o se repetía
(trampa "ventana horneada e isla"). Cursor opaco por generación; un cursor inválido es 400, un
`offset` es 400, un cursor de otra generación es 410, nunca una página en silencio.
Automatizado: `cursor-fabricado`. Prueba: `test/busqueda.test.js`.

## 8. Idempotencia bajo dos isolates

Una prueba sobre node:http pasa en verde con la carrera viva, porque el servidor local serializa
lo que el edge corre en paralelo. Reentregar el mismo sobre nunca duplica buzón ni asiento
(invariante 4); dos ticks del cron no toman el mismo trabajo (`claimDueJobs`); el candado del
Libro es el índice único, no la memoria de la instancia.
Prueba: `test/concurrencia.test.js` (dos instancias sobre el mismo almacén).
**[manual]** cada operación nueva que escriba: ¿qué pasa si la misma petición llega dos veces a dos
isolates a la vez? Golpear el método con dos instancias, no la ruta con dos peticiones.

## 9. Límites de tasa por ruta

El contador vivía en la memoria de cada isolate (el límite real era N veces el declarado, N
desconocido) y todos los agentes de la casa compartían un balde. Ahora cuenta en D1 por dirección,
dominio o IP; cada 429 lleva `Retry-After`; si D1 falla, deja pasar y lo anota.
Automatizado: `429-retry-after` (provoca el 429 en cada cubeta pública y exige la cabecera).
Prueba: `test/tasa.test.js`.
**Abierto (14-sep):** la cubeta de registro cuenta sólo DESPUÉS de verificar la firma del cuerpo:
un POST sin firma cuesta una verificación Ed25519 y no se limita. El script lo reporta como
"sin 429 en N intentos: registro".

## 10. `decodeURIComponent` sin try

Un segmento como `%E0%A4%A` lanza `URIError` y la ruta contestaba 500 (tres rutas en la tercera
revisión; cinco al medirlo el 14-sep con el script). Ahora `handleRequest` decodifica con un
`dec()` que devuelve el segmento tal cual si no se puede decodificar: nunca es un nombre válido,
así que cae al mismo 404/400 que un inexistente.
Automatizado: `500-decode` (todas las rutas GET públicas con el segmento roto).

## 11. Tarjetas de sistema

La tarjeta de `libro@` anunciaba las ops de hace una semana porque se escribía una sola vez;
`verifica@` anunciaba tres pruebas cuando ya había cuatro. Ahora se re-certifican cuando cambia el
contenido. Automatizado: `tarjetas-sistema` (las cuatro verifican con una llave del dominio y
`verifica@` no anuncia pruebas que no existen). Prueba: `test/verifica.test.js`.

## 12. Herramientas MCP

Cada descripción tiene tope (340; 650 para `nyx5_libro`, que lleva la lista de ops); los nombres
son únicos; las 13 de mensajería existen. Automatizado: `tools-tope`. Prueba: `test/mcp.test.js`.
**[manual]** una herramienta nueva: ¿está en `MENSAJERIA` sólo si un Claude de sólo mensajes puede
usarla sin tocar el Libro?

## 13. Lo que el script NO cubre

- Nada que necesite dos isolates reales (ver 8) ni el tope de subpeticiones del edge (se mide en
  `wrangler dev`, ver `scripts/sonda-workerd.mjs`).
- Nada que exija leer texto: homógrafos (5), CSV (6), textos públicos.
- No es prueba de carga: los 429 se provocan de a uno.
- Contra producción, `--sin-inundar`: provocar 429 gasta el minuto de todos los que comparten IP.

## Cómo se corre

```
npm run revision                                          # casa local en 4759
node scripts/revision-adversarial.mjs --url http://127.0.0.1:8790 --admin-token <t>   # wrangler dev
node scripts/revision-adversarial.mjs --url https://nyx5.com --sin-inundar            # producción
```

Sale con 1 si hay alguna falla. Una comprobación **indecisa** no es verde: dice por qué no se pudo
ejercitar (registro cerrado, ruta ausente, sin 429 en N intentos).
