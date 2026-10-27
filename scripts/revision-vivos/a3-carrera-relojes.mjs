// Ataque 3: dos relojes (dos isolates) sobre el mismo almacén. Cuatro contadores a la vez:
//   1. el tope de 5 envíos por turno, que vive en la memoria del turno;
//   2. el GASTO mensual en dólares, que es el ÚNICO freno de plata y se lee-suma-escribe;
//   3. el cupo de despertares propios (kvIncrement, atómico);
//   4. el crédito de un cliente de qa@ (candado por cliente).
// Se golpea el MÉTODO con dos `atenderAsistentes` concurrentes: una prueba sobre node:http
// serializa lo que el edge corre en paralelo (trampa declarada).
import { levantar, usa, texto, altaQa, DOM } from './casa.mjs';
import { atenderAsistentes, creditoDe, gastoDe } from '../../src/correo/asistente.js';
import { CUPO_ENVIOS_DIA } from '../../src/correo/acciones.js';

const { a, b, store, rx, duena, amiga, rosetta, drenar, pedidos, proximas } = await levantar({ dos: true, api: { demora: 60 } });
const mes = new Date().toISOString().slice(0, 7);
const dia = new Date().toISOString().slice(0, 10);

// ---------- 1. el tope de envíos por turno contra el volumen por minuto ----------
const SOBRES = 4;
for (let i = 0; i < SOBRES; i++) await duena.send({ to: rosetta.address, body: `tanda ${i}` });
await drenar();
// Cada turno pide los 5 envíos que el tope permite.
for (let i = 0; i < SOBRES * 2; i++) {
  proximas.push(usa(Array.from({ length: 5 }, (_, n) => ({ name: 'nyx5_enviar', input: { to: amiga.address, body: `spam ${i}-${n}` } }))));
  proximas.push(texto('mandado'));
}
const n0 = pedidos.length;
await Promise.all([atenderAsistentes(a), atenderAsistentes(b)]);
await drenar(a); await drenar(b);
let recibidos = 0;
for (const x of await amiga.inbox()) {
  try { if (/^spam /.test((await amiga.open(x.envelope)).content?.body ?? '')) recibidos++; } catch { /* no es para ella */ }
}
console.log(`1) envíos: ${SOBRES} sobres pendientes, dos relojes a la vez -> ${recibidos} mensajes salieron a amiga@ en un minuto`);
console.log(`   (el tope dice 5 POR TURNO; el turno por sobre evita repetir un sobre, no acotar el volumen)`);
console.log(`   llamadas a la API: ${pedidos.length - n0}`);
// Y el cupo del DÍA, que es el que acota de verdad: se deja a uno del tope y el siguiente turno no
// manda nada, con los dos relojes a la vez.
const dia0 = new Date().toISOString().slice(0, 10);
await store.kvPut('asistente-envios', `rosetta:${dia0}`, CUPO_ENVIOS_DIA - 1);
proximas.length = 0;
for (let i = 0; i < 4; i++) {
  proximas.push(usa(Array.from({ length: 5 }, (_, n) => ({ name: 'nyx5_enviar', input: { to: amiga.address, body: `tope ${i}-${n}` } }))));
  proximas.push(texto('ya no puedo'));
}
for (let i = 0; i < 2; i++) await duena.send({ to: rosetta.address, body: `al tope ${i}` });
await drenar();
await Promise.all([atenderAsistentes(a, { maxPorTick: 2 }), atenderAsistentes(b, { maxPorTick: 2 })]);
await drenar(a); await drenar(b);
let alTope = 0;
for (const x of await amiga.inbox()) {
  try { if (/^tope /.test((await amiga.open(x.envelope)).content?.body ?? '')) alTope++; } catch { /* no es para ella */ }
}
console.log(`   con el cupo del día en ${CUPO_ENVIOS_DIA - 1}/${CUPO_ENVIOS_DIA}: salió ${alTope} mensaje(s) más (tiene que ser 1)`);
console.log(`   contador del día: ${await store.kvGet('asistente-envios', `rosetta:${dia0}`)}`);
await store.kvPut('asistente-envios', `rosetta:${dia0}`, 0);

// ---------- 2. el gasto: el único freno de plata ----------
await store.kvPut('asistente-gasto', `rosetta:${mes}`, { usd: 0, llamadas: 0, avisado: false });
proximas.length = 0;
const antes = (await gastoDe(store, 'rosetta', mes)).usd;
for (let i = 0; i < 2; i++) await duena.send({ to: rosetta.address, body: `gasto ${i}` });
await drenar();
const n1 = pedidos.length;
await Promise.all([atenderAsistentes(a, { maxPorTick: 2 }), atenderAsistentes(b, { maxPorTick: 2 })]);
const g = await gastoDe(store, 'rosetta', mes);
const llamadas = pedidos.length - n1;
console.log(`\n2) gasto: ${llamadas} llamadas a la API en paralelo -> anotadas ${g.llamadas}, usd ${g.usd.toFixed(6)} (antes ${antes})`);
console.log(`   ${g.llamadas < llamadas ? `PERDIDAS ${llamadas - g.llamadas} llamadas: el tope mensual cuenta de menos` : 'todas contadas'}`);

// ---------- 3. el cupo de despertares ----------
await store.kvPut('asistente-despertar', `rosetta:${dia}`, 0);
for (let i = 0; i < 4; i++) await rosetta.recordar({ cuando: new Date(Date.now() - 1000).toISOString(), body: `despierta ${i}` });
await drenar();
await Promise.all([atenderAsistentes(a, { maxPorTick: 2 }), atenderAsistentes(b, { maxPorTick: 2 })]);
console.log(`\n3) despertares contados: ${await store.kvGet('asistente-despertar', `rosetta:${dia}`)} de 4 recordatorios (kvIncrement es atómico)`);

// ---------- 4. el crédito de un cliente de qa@ ----------
const qa = await altaQa(rx, { owner: duena.address, precio: 400, tools: false });
await a.libro.topup(amiga.address, 1000, 'carga de prueba');
await amiga.pay(DOM, { to: qa.address, amount: 400, concept: 'credito qa' });
await drenar();
await new Promise((r) => setTimeout(r, 50));
console.log(`\n4) crédito de amiga@ ante qa@: ${JSON.stringify(await creditoDe(a, 'qa', amiga.address))}`);
for (let i = 0; i < 2; i++) await amiga.send({ to: qa.address, body: `pedida ${i}` });
await drenar();
const n2 = pedidos.length;
const r4 = await Promise.all([atenderAsistentes(a, { maxPorTick: 2 }), atenderAsistentes(b, { maxPorTick: 2 })]);
console.log(`   dos relojes con UN crédito de 400: ${pedidos.length - n2} llamadas a la API, atendidos ${JSON.stringify(r4)}`);
console.log(`   crédito después: ${JSON.stringify(await creditoDe(a, 'qa', amiga.address))}`);
