// node --test test/
// Acuse de lectura y presencia (13-sep-2026). Reportado desde el teléfono de Nicholas: «entregado»
// no dice si alguien leyó, y no había forma de saber si el otro lado estaba atendiendo. Los dos son
// opt-in en la tarjeta: presencia sin consentimiento sería vigilancia.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Estafeta } from '../src/correo/estafeta.js';
import { Agent } from '../src/correo/agente.js';

// Puerto propio de esta suite (npm test corre los archivos en paralelo). Lo cuida test/puertos.test.js.
const P = 4281;
const H = 'lectura.test';
const URL_CASA = `http://127.0.0.1:${P}`;
const hosts = { [H]: { url: URL_CASA } };
let tmp, casa, lectora, remitente, callada;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-lectura-'));
  casa = await new Estafeta({ domain: H, port: P, dataDir: path.join(tmp, H), adminToken: 't', hosts, workerIntervalMs: 60, libro: { welcome: 0, feeBps: 0 }, log: () => {} }).start();
  lectora = Agent.create(`lectora@${H}`, URL_CASA, { hosts });
  remitente = Agent.create(`remitente@${H}`, URL_CASA, { hosts });
  callada = Agent.create(`callada@${H}`, URL_CASA, { hosts });
  await lectora.register({ adminToken: 't', capabilities: { read_receipts: true, presence: true } });
  await remitente.register({ adminToken: 't' });
  await callada.register({ adminToken: 't' });
});
after(async () => { await casa?.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('acuse de lectura: al confirmar, el remitente recibe un recibo de la casa, una sola vez, y su historial marca leído', async () => {
  const m = await remitente.send({ to: lectora.address, body: 'hola' });
  const llego = await lectora.waitFor((e) => e.id === m.id, { timeoutMs: 5000 });
  assert.equal((await remitente.inbox()).length, 0, 'antes de confirmar no hay acuse');
  await lectora.ack([llego.envelope.id]);
  const acuse = await remitente.waitFor((e) => e.from === `postmaster@${H}` && e.in_reply_to === m.id, { timeoutMs: 5000 });
  const cuerpo = (await remitente.open(acuse.envelope)).content.body;
  assert.equal(cuerpo.read_of, m.id); assert.equal(cuerpo.read_by, lectora.address); assert.ok(cuerpo.read_at);
  assert.equal(acuse.envelope.thread, m.id, 'el acuse queda en el hilo del mensaje');
  // Confirmar de nuevo no genera otro acuse.
  await lectora.ack([llego.envelope.id]);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await remitente.inbox()).filter((x) => x.envelope.from === `postmaster@${H}`).length, 1);
  // El historial del remitente marca el mensaje como leído, por quién y cuándo.
  const conv = await remitente.conversation(lectora.address);
  const enviado = conv.find((x) => x.dir === 'out' && x.id === m.id);
  assert.equal(enviado.read?.by, lectora.address);
  // El acuse mismo no se acusa: confirmarlo no dispara nada hacia postmaster@.
  await remitente.ack([acuse.envelope.id]);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await casa.store.listMail('postmaster')).length, 0);
});

test('sin opt-in no hay acuse ni presencia; con opt-in la presencia se ve por hora, fuera de la tarjeta firmada', async () => {
  const m = await remitente.send({ to: callada.address, body: 'hola' });
  const llego = await callada.waitFor((e) => e.id === m.id, { timeoutMs: 5000 });
  await callada.ack([llego.envelope.id]);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await remitente.inbox()).filter((x) => x.envelope.in_reply_to === m.id).length, 0, 'callada no activó acuses');
  assert.equal(await remitente.presence(callada.address), null);
  const visto = await remitente.presence(lectora.address);
  assert.ok(visto && /T\d\d:00:00\.000Z$/.test(visto), `presencia redondeada a la hora: ${visto}`);
  const r = await fetch(`${URL_CASA}/resolve/${lectora.address}`).then((x) => x.json());
  assert.equal(r.presence.last_seen, visto);
  assert.equal(r.capabilities.presence, true, 'el opt-in sí es parte de la tarjeta certificada');
  assert.ok(!JSON.stringify(r.certification).includes(visto), 'la hora no vive dentro de la tarjeta certificada');
  const c = await fetch(`${URL_CASA}/resolve/${callada.address}`).then((x) => x.json());
  assert.ok(!c.presence);
});

// Revisión adversarial del 13-sep-2026, ALTO probado: cualquier sobre `receipt` con `read_of` marcaba
// leído lo que fuera. Un extraño (o un delegado de sólo mensajes) hacía creer que Basti ya leyó.
test('un acuse de lectura falso no marca leído: sólo vale el del postmaster de la casa del lector', async () => {
  const m = await remitente.send({ to: callada.address, body: 'sin leer' });
  await callada.waitFor((e) => e.id === m.id, { timeoutMs: 5000 });
  const extrano = Agent.create(`extrano@${H}`, URL_CASA, { hosts });
  await extrano.register({ adminToken: 't' });
  await extrano.send({ to: remitente.address, type: 'receipt', encrypt: false, media: 'application/nyx5.recibo+json', body: { read_of: m.id, read_by: callada.address, read_at: new Date().toISOString() } });
  await remitente.waitFor((e) => e.from === extrano.address, { timeoutMs: 5000 });
  const enviado = (await remitente.conversation(callada.address)).find((x) => x.dir === 'out' && x.id === m.id);
  assert.equal(enviado.read, undefined, 'un recibo firmado por un extraño marcó leído');
  // De silencio: el acuse real de postmaster sigue marcando (el de lectora, de la primera prueba).
  const real = (await remitente.conversation(lectora.address)).find((x) => x.dir === 'out' && x.read);
  assert.equal(real?.read?.by, lectora.address);
});
