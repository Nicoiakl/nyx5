// Ataque 5: la adopción y el Libro.
//   a) qué NO se puede adoptar: un delegado, una dirección con custodia ajena, una adopción viva,
//      un nombre de sistema, una inexistente, y sin prueba de posesión.
//   b) DELETE deja la dirección VIVA y sin custodia de asistente, y su dueña sigue firmando.
//   c) re-adoptar no resucita crédito viejo ni reinicia el gasto del mes.
//   d) un agente adoptado NO toca el Libro por NINGUNA vía, incluida pedirle a nyx5_enviar que le
//      mande una op a libro@ (de esta casa y de otra).
import { levantar, usa, texto, altaQa, DOM } from './casa.mjs';
import { atenderAsistentes, creditoDe } from '../../src/correo/asistente.js';
import { ejecutar, NOMBRES } from '../../src/correo/acciones.js';

const { a, store, rx, agente, duena, amiga, rosetta, drenar, pedidos, proximas, generateKeys } = await levantar();
const claudeDuena = await duena.delegate('claude', { scope: { messages_only: true } });
const alta = await rx('POST', '/admin/ideas', { owner: duena.address, allow: [duena.address], keys: generateKeys() });
console.log(`alta de ideas@: ${alta.status}`);

console.log('\na) qué NO se adopta');
const intentos = {
  'un delegado': { adopt: true, local: claudeDuena.local, keys: claudeDuena.keys, config: {} },
  'ideas@ (custodia ajena)': { adopt: true, local: 'ideas', keys: generateKeys(), config: {} },
  'una adopción viva (rosetta@)': { adopt: true, local: 'rosetta', keys: rosetta.keys, config: {} },
  'un nombre de sistema': { adopt: true, local: 'libro', keys: generateKeys(), config: {} },
  'una inexistente': { adopt: true, local: 'fantasma', keys: generateKeys(), config: {} },
  'llaves ajenas': { adopt: true, local: 'amiga', keys: rosetta.keys, config: {} },
  'sin la privada que cuadra': { adopt: true, local: 'amiga', keys: { ...amiga.keys, sigPriv: generateKeys().sigPriv }, config: {} },
};
for (const [nombre, body] of Object.entries(intentos)) {
  const r = await rx('POST', '/admin/assistants', body);
  console.log(`   ${nombre}: ${r.status} ${String(r.body.reason || '').slice(0, 90)}`);
}

console.log('\nd) el Libro, por todas las vías');
const ctx = { est: a, agente: await a.agenteDeBoveda('rosetta'), cfg: await store.kvGet('asistente', 'rosetta'), rec: await store.getAgent('rosetta'), propia: rosetta.address, domain: DOM, nowMs: Date.now(), disponibles: [...NOMBRES], estado: { envios: 0, recordatorios: 0 }, cupo: async () => ({ ok: true, tope: 100 }) };
for (const op of ['nyx5_pagar', 'nyx5_accept', 'nyx5_hire', 'nyx5_deliver', 'nyx5_release', 'nyx5_libro', 'nyx5_balance']) {
  const r = await ejecutar(ctx, op, { to: amiga.address, amount: 1 });
  console.log(`   ${op}: ${r.is_error ? 'no existe/rechazada' : 'EJECUTÓ'} — ${String(r.content).slice(0, 70)}`);
}
// La vía de verdad: pedirle a nyx5_enviar que le mande una op a libro@ — de esta casa y de otra.
await a.agregarContactos('rosetta', [`libro@${DOM}`, 'libro@otra.test']);
a.resolver.invalidate(`agent:${rosetta.address}`);
const ctx2 = { ...ctx, rec: await store.getAgent('rosetta'), estado: { envios: 0, recordatorios: 0 }, cupo: async () => ({ ok: true, tope: 100 }) };
for (const dir of [`libro@${DOM}`, 'libro@otra.test', `postmaster@${DOM}`, `verifica@${DOM}`, `tareas@${DOM}`]) {
  const r = await ejecutar(ctx2, 'nyx5_enviar', { to: dir, body: JSON.stringify({ op: 'pay', to: amiga.address, amount: 999 }) });
  console.log(`   nyx5_enviar a ${dir} (EN SU LISTA): ${r.is_error ? 'rechazada' : 'SALIÓ — el Libro es alcanzable'} — ${String(r.content).slice(0, 80)}`);
}
const saldoAntes = (await a.libro.account(rosetta.address)).balance;
await drenar();
console.log(`   saldo de rosetta@ después de todo: ${saldoAntes} -> ${(await a.libro.account(rosetta.address)).balance}`);

console.log('\nb/c) quitar el cerebro y volver a adoptar');
const qa = await altaQa(rx, { owner: duena.address, precio: 400, tools: false });
await a.libro.topup(amiga.address, 1000, 'carga');
await amiga.pay(DOM, { to: qa.address, amount: 400, concept: 'credito' });
await drenar(); await new Promise((r) => setTimeout(r, 30));
proximas.push(texto('contesto y cobro'));
await amiga.send({ to: qa.address, body: 'una pedida pagada' });
await drenar(); await atenderAsistentes(a); await drenar();
console.log(`   crédito de amiga@ tras una respuesta: ${JSON.stringify(await creditoDe(a, 'qa', amiga.address))}`);
const mes = new Date().toISOString().slice(0, 7);
console.log(`   gasto del mes de qa@: ${JSON.stringify(await store.kvGet('asistente-gasto', `qa:${mes}`))}`);
const del = await rx('DELETE', '/admin/assistants/qa');
console.log(`   DELETE: ${del.status} ${JSON.stringify(del.body)}`);
const vive = await store.getAgent('qa');
console.log(`   la dirección sigue viva: ${!!vive && !vive.revoked} · custodia: ${JSON.stringify(vive?.custody)} · llave en la bóveda: ${!!(await a.llavesDeBoveda('qa'))}`);
const re = await rx('POST', '/admin/assistants', { system: true, local: 'qa', keys: qa.keys, config: { budget_usd: 50, persona: 'Eres qa.', owner: duena.address, price_tokens: 400 } });
console.log(`   re-alta: ${re.status}`);
console.log(`   crédito de amiga@ tras re-adoptar: ${JSON.stringify(await creditoDe(a, 'qa', amiga.address))}`);
console.log(`   gasto del mes tras re-adoptar: ${JSON.stringify(await store.kvGet('asistente-gasto', `qa:${mes}`))}`);
// ¿Se puede volver a poner el cerebro en una dirección de sistema después del DELETE? La re-alta
// da 409 porque el nombre ya está registrado. La vía que queda es la adopción.
const readopt = await rx('POST', '/admin/assistants', { adopt: true, local: 'qa', keys: qa.keys, config: { budget_usd: 50, persona: 'Eres qa.', owner: duena.address, price_tokens: 400 } });
console.log(`   re-ADOPCIÓN de qa@ tras el DELETE: ${readopt.status} ${String(readopt.body.reason || readopt.body.address || '').slice(0, 90)}`);
