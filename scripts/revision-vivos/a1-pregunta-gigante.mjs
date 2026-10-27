// Ataque 1: una pregunta enorme y el historial que la vuelve a mandar.
// Mide los BYTES que salen a la API en cuatro preguntas seguidas de 100 KB desde una dirección DE
// LA LISTA. Antes del tope, cada petición arrastra todas las anteriores (crecimiento cuadrático) y
// nada frena eso salvo el tope mensual en dólares; después, cada petición queda acotada.
import { levantar, kb } from './casa.mjs';
import { atenderAsistentes } from '../../src/correo/asistente.js';

const { a, store, duena, rosetta, drenar, pedidos } = await levantar();
const N = 4, LARGO = 100_000;
const enviados = [];
for (let i = 0; i < N; i++) enviados.push(await duena.send({ to: rosetta.address, body: `P${i} ` + 'x'.repeat(LARGO) }));
await drenar();
console.log(`${N} preguntas de ${kb(LARGO)} en el buzón: ${(await store.listMail('rosetta')).length} pendientes`);
// De a una (maxPorTick: 1) para que el historial de cada turno sea el de la anterior contestada.
for (let i = 0; i < N; i++) { await atenderAsistentes(a, { maxPorTick: 1 }); await drenar(); }
console.log('\npetición -> bytes del cuerpo que se le manda a la API');
let total = 0;
for (const [i, p] of pedidos.entries()) {
  const chars = JSON.stringify(p.body.messages).length;
  total += p.bytes;
  console.log(`  ${i + 1}: ${kb(p.bytes)} (messages ${kb(chars)}, ${p.body.messages.length} mensajes)`);
}
console.log(`\ntotal a la API: ${kb(total)} para ${pedidos.length} respuestas`);
// A precio de entrada de claude-sonnet-5 (2 US$/MTok) y ~4 caracteres por token.
const tok = total / 4;
console.log(`≈ ${Math.round(tok).toLocaleString('es')} tokens de entrada ≈ US$${(tok * 2 / 1e6).toFixed(3)} a precio de sonnet-5`);
const respondidas = (await duena.inbox()).filter((x) => enviados.some((e) => e.id === x.envelope.in_reply_to)).length;
console.log(`contestadas: ${respondidas}/${N} · pendientes que quedaron: ${(await store.listMail('rosetta')).length}`);
console.log(`\nLA MEDIDA QUE IMPORTA — petición más grande: ${pedidos.length ? kb(Math.max(...pedidos.map((p) => p.bytes))) : 'ninguna: con el tope puesto, una pregunta de 100 KB no llega a la API'}`);

// ---------- con el tope puesto: qué pasa y qué cuesta ----------
import { LIMITES_ENTRADA } from '../../src/correo/asistente.js';
const { pregunta: TOPE, turnos: TURNOS } = LIMITES_ENTRADA;
console.log(`\ntope: ${TOPE} caracteres por mensaje · ${TURNOS} cartas de historial`);
const n0 = pedidos.length;
const corta = await duena.send({ to: rosetta.address, body: 'c'.repeat(TOPE - 1_000) });
await drenar(); await atenderAsistentes(a, { maxPorTick: 1 }); await drenar();
console.log(`una de ${TOPE - 1_000}: ${pedidos.length - n0} llamadas a la API (tiene que ser 1)`);
const n1 = pedidos.length;
const larga = await duena.send({ to: rosetta.address, body: 'L'.repeat(TOPE + 1_000) });
await drenar(); await atenderAsistentes(a, { maxPorTick: 1 }); await drenar();
console.log(`una de ${TOPE + 1_000}: ${pedidos.length - n1} llamadas a la API (tiene que ser 0)`);
const r = (await duena.inbox()).find((x) => x.envelope.in_reply_to === larga.id);
console.log(`  contestó: ${JSON.stringify((await duena.open(r.envelope)).content.body)}`);
console.log(`  pendientes: ${(await store.listMail('rosetta')).length} (no queda eterna)`);

// El turno MÁS CARO posible: el historial lleno de cartas en el tope y una pregunta en el tope.
for (let i = 0; i < TURNOS + 4; i++) {
  const n = pedidos.length;
  await duena.send({ to: rosetta.address, body: `H${i} ` + 'h'.repeat(TOPE - 10) });
  await drenar(); await atenderAsistentes(a, { maxPorTick: 1 }); await drenar();
  if (pedidos.length > n) process.stdout.write(`${kb(pedidos.at(-1).bytes)} `);
}
const conTope = pedidos.slice(n1).map((p) => p.bytes);
const mayorConTope = conTope.length ? Math.max(...conTope) : 0;
console.log(`\nturno más caro medido: ${kb(mayorConTope)} · cota de diseño: ${kb((TURNOS + 1) * TOPE)} + persona y conocimiento`);
console.log(`≈ US$${((mayorConTope / 4) * 5 / 1e6).toFixed(3)} de entrada por turno a precio de opus-5 (US$5/MTok)`);
