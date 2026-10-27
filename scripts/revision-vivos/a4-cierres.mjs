// Ataque 4: el sobre que se cierra SIN contestar. Los cuatro casos, uno por uno, y de cada uno las
// tres preguntas: ¿costó una llamada a la API? ¿quedó pendiente para siempre? ¿salió un rebote que
// le cueste plata al asistente? Más el quinto caso declarado: el correo SIN FIRMA se queda
// pendiente a propósito — se mide cuánto crece y si tapa una pregunta legítima que esté detrás.
import { levantar, texto } from './casa.mjs';
import { atenderAsistentes } from '../../src/correo/asistente.js';
import { ms } from './casa.mjs';

const { a, store, agente, duena, amiga, extrano, rosetta, drenar, pedidos, proximas } = await levantar();
const pend = () => store.listMail('rosetta').then((x) => x.length);
const saldo = async () => (await a.libro.account(rosetta.address)).balance;
await a.libro.topup(rosetta.address, 5000, 'carga de prueba');

const caso = async (nombre, preparar) => {
  const n = pedidos.length, s0 = await saldo();
  const t0 = performance.now();
  const quien = await preparar();
  await drenar();
  await atenderAsistentes(a);
  await drenar();
  const rebotes = quien ? (await quien.inbox()).filter((x) => x.envelope.from === rosetta.address).length : 0;
  console.log(`${nombre}\n   API: ${pedidos.length - n} llamadas · pendientes: ${await pend()} · rebotes al remitente: ${rebotes} · saldo: ${s0} -> ${await saldo()} · ${ms(t0)}`);
};

// 1. recibo de un agente de sistema (el aviso de un `pay`).
await caso('1) recibo de postmaster@/libro@', async () => {
  await a.libro.topup(duena.address, 1000, 'x');
  await duena.pay(a.domain, { to: rosetta.address, amount: 10, concept: 'propina' });
  return null;
});
// 2. un sobre que llegó por un GRUPO.
await caso('2) llegado por un grupo', async () => {
  const g = await duena.createGroup('sala', { members: [rosetta.address, amiga.address] });
  await duena.send({ to: g.address, body: 'hola sala' });
  return duena;
});
// 3. un remitente que la lista NO eligió: entra con un `intro` de 4 KB (§9).
await caso('3) extraño con un intro (la lista no lo eligió)', async () => {
  await extrano.send({ to: rosetta.address, type: 'intro', body: 'me presento' });
  return extrano;
});
// 4. un remitente cuyo buzón COBRA estampilla: el rebote se lo cobraría al asistente.
await caso('4) remitente con buzón que cobra estampilla', async () => {
  const cobra = await agente('cobra', { inbox: { policy: 'stamp', price: 25 } });
  await a.agregarContactos('rosetta', [cobra.address]);
  a.resolver.invalidate(`agent:${rosetta.address}`);
  await cobra.send({ to: rosetta.address, type: 'intro', body: 'cóbrame el rebote' });
  return cobra;
});
// 4b. silencio: a un remitente normal de la lista SÍ se le rebota.
await caso('4b) remitente normal de la lista (silencio: aquí sí hay rebote)', async () => {
  await amiga.send({ to: rosetta.address, type: 'intro', body: 'yo sí' });
  return amiga;
});

// 5. el correo SIN FIRMA: se queda pendiente a propósito. ¿Crece sin tope? ¿Tapa lo legítimo?
console.log('\n5) correo sin firma (se queda pendiente a propósito)');
const CORREOS = 2000, BYTES = 2000;
for (let i = 0; i < CORREOS; i++) await store.putMail('rosetta', { nyx5: '1', id: `email-${i}`, from: `desconocido${i}@fuera.test`, to: [rosetta.address], type: 'message', created: new Date().toISOString(), content: { media: 'text/plain', body: 'x'.repeat(BYTES) } }, { from_verified: false });
console.log(`   ${CORREOS} correos de ${BYTES} B metidos: pendientes ${await pend()} (${((CORREOS * BYTES) / 1024 / 1024).toFixed(1)} MB en un buzón que no se borra)`);
proximas.push(texto('contesto igual'));
const env = await duena.send({ to: rosetta.address, body: 'una pregunta legítima detrás de la inundación' });
await drenar();
const n = pedidos.length, t0 = performance.now();
await atenderAsistentes(a);
console.log(`   un tick con el buzón inundado: ${ms(t0)} · API: ${pedidos.length - n} llamadas`);
await drenar();
const r = (await duena.inbox()).filter((x) => x.envelope.in_reply_to === env.id).length;
console.log(`   la pregunta legítima se contestó: ${r === 1 ? 'sí' : `NO (${r})`} · pendientes que quedan: ${await pend()}`);
const t1 = performance.now();
await atenderAsistentes(a);
console.log(`   un tick más, ya sin nada que hacer: ${ms(t1)} (se recorre el buzón entero cada vez)`);

// 6. Lo que la inundación SÍ se lleva: el historial. `conversacion` mira las 1.000 cartas más
//    recientes del buzón y después filtra por contraparte: con el buzón inundado, la memoria de la
//    conversación real queda fuera de esa ventana.
proximas.push(texto('contesto sin memoria'));
const n2 = pedidos.length;
await duena.send({ to: rosetta.address, body: 'segunda pregunta: te acuerdas de la primera?' });
await drenar(); await atenderAsistentes(a); await drenar();
const visto = JSON.stringify(pedidos[n2]?.body?.messages || []);
console.log(`\n6) con el buzón inundado, la pregunta anterior de duena@ está en el contexto: ${visto.includes('una pregunta legítima') ? 'sí' : 'NO — la inundación le borró la memoria'}`);
console.log(`   mensajes en el prompt: ${(pedidos[n2]?.body?.messages || []).length}`);
