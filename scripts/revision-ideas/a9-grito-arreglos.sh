#!/bin/bash
# Cada arreglo se revierte (mutante) y la prueba que lo cuida tiene que fallar. Si pasa, la prueba no cuida nada.
cd "$(dirname "$0")/../.."
# Pase lo que pase (Ctrl-C, SIGPIPE de un `| head`), los archivos vuelven a su estado: un mutante vivo
# en el árbol es peor que la prueba que lo buscaba (pasó el 14-sep-2026: R2 quedó vivo tras un head -1).
for f in src/correo/ideas.js src/correo/estafeta.js src/nucleo/almacen.js src/nucleo/almacen-d1.js; do cp $f /tmp/$(basename $f).orig; done
trap restaurar EXIT
restaurar() { for f in src/correo/ideas.js src/correo/estafeta.js src/nucleo/almacen.js src/nucleo/almacen-d1.js; do cp /tmp/$(basename $f).orig $f; done; }
mutar() { # $1 nombre, $2 archivo, $3 python
  python3 - "$2" "$3" <<'PY'
import sys
p=sys.argv[1]; s=open(p).read(); antes=s
exec(sys.argv[2])
assert s!=antes, 'no muto'
open(p,'w').write(s)
PY
  if node --test test/ideas.test.js >/tmp/mut.log 2>&1; then echo "SOBREVIVE (la prueba NO grita): $1"; else echo "grita: $1 -> $(grep -E '^✖ ' /tmp/mut.log | grep -v 'failing tests' | sed 's/(.*//' | tr '\n' ';' | cut -c1-230)"; fi
  restaurar
}
mutar "R1 sin puerta de ideas@ en inbound" src/correo/estafeta.js "s=s.replace('const veto = await puertaIdeas(this, env, rec, this.ideas.cupo ? { cupo: this.ideas.cupo } : {});', 'const veto = null;')"
mutar "R2 la puerta no mira la lista" src/correo/ideas.js "s=s.replace(\"if (!enLista(lista, env.from)) return { code: 403, reason: 'the ideas mailbox records only signed envelopes from its list: not recorded' };\", '')"
mutar "R3 la puerta no cuenta bytes" src/correo/ideas.js "s=s.replace('if (n > cupo.ideas || total > cupo.bytes)', 'if (n > cupo.ideas)')"
mutar "R4 la puerta no cuenta ideas" src/correo/ideas.js "s=s.replace('if (n > cupo.ideas || total > cupo.bytes)', 'if (total > cupo.bytes)')"
mutar "R5 el cupo no es por día (clave sin fecha)" src/correo/ideas.js "s=s.replace('const clave = \`\${minus(env.from)}:\${dia}\`;', 'const clave = \`\${minus(env.from)}:x\`;')"
mutar "R6 el cupo no es por remitente" src/correo/ideas.js "s=s.replace('const clave = \`\${minus(env.from)}:\${dia}\`;', 'const clave = \`todos:\${dia}\`;')"
mutar "R7 correo a ideas@ entra otra vez" src/correo/estafeta.js "s=s.replace(\"if (this.ideas.enabled && local === IDEAS_LOCAL && rec.custody?.via === IDEAS_VIA) return { ok: false, code: 403, reason: 'the ideas mailbox records only signed envelopes; email is not recorded' };\", '')"
mutar "R8 registro: vuelve el orden viejo (confirma con registro de respaldo)" src/correo/ideas.js "s=s.replace('let registro = await est.store.kvGet(NS, claveDe(n));\n      if (!registro) {', 'let registro = await est.store.kvGet(NS, claveDe(n));\n      if (!registro && !(await est.store.kvGet(NS, \`sobre:\${e.id}\`))?.reintento) {'); s=s.replace('await est.store.kvPut(NS, \`sobre:\${e.id}\`, { n });', 'await est.store.kvPut(NS, \`sobre:\${e.id}\`, { n, reintento: true });'); s=s.replace('await agente.send({ to: e.from, body: CONFIRMACION(registro.id, registro.at)', 'registro = registro || { id: idDeIdea(n), at: new Date().toISOString() }; await agente.send({ to: e.from, body: CONFIRMACION(registro.id, registro.at)')"
mutar "R9 paginado: total = lo que cupo" src/correo/ideas.js "s=s.replace(\"const total = Number(await est.store.kvGet(NS, '_n')) || 0;\", 'const total = ideas.length;')"
mutar "R10 paginado: after ignorado en D1" src/nucleo/almacen-d1.js "s=s.replace(\"after == null ? '' : String(after)\", \"''\")"
mutar "R11 paginado: after ignorado en FileStore" src/nucleo/almacen.js "s=s.replace('(after != null && !(key > after))', 'false')"
mutar "R12 kvIncrement ignora by (D1)" src/nucleo/almacen-d1.js "s=s.replace('const paso = String(Math.trunc(Number(by) || 0));', \"const paso = '1';\")"
mutar "R13 kvIncrement ignora by (FileStore)" src/nucleo/almacen.js "s=s.replace('(Number(this.kvGet(ns, key, nowMs)) || 0) + by', '(Number(this.kvGet(ns, key, nowMs)) || 0) + 1')"
mutar "R14 lista de permitidos: se cuela putMail" src/correo/ideas.js "s=s.replace('registradas++;', 'registradas++; await est.store.putMail(\"nico\", { ...e, id: e.id + \"-copia\" }, { from_verified: true });')"
mutar "R15 ideas.enabled apagado no tapa la puerta (404 igual)" src/correo/estafeta.js "s=s.replace(\"if (this.ideas.enabled && rx.method === 'GET' && path === '/ideas') {\", \"if (rx.method === 'GET' && path === '/ideas') {\")"
