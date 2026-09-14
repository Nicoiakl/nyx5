// Ataque 6: dos ticks concurrentes (dos instancias) y un sobre reentregado (mismo id).
import { levantar } from './casa.mjs';
import { atenderIdeas, listarIdeas } from '../../src/correo/ideas.js';
import { signBytes } from '../../src/nucleo/crypto.js';
const { a, b, store, nicholas, drenar, IDEAS } = await levantar({ dos: true });
for (let i = 0; i < 12; i++) await nicholas.send({ to: IDEAS, body: `idea ${i}` });
await drenar();
const enviados = (await store.listOutbox('nicholas')).map((o) => o.envelope);
// Reentrega por /inbound del mismo sobre (lo que hace una estafeta emisora que reintenta), ANTES del tick.
const relay = (env) => `nyx51 domain=${a.domain}; kid=${a.keys.sig}; sig=${signBytes(`relay:${env.id}:${a.domain}`, a.keys)}`;
const re1 = await a.inbound(enviados[0], relay(enviados[0]));
console.log('reentrega antes del tick:', JSON.stringify(re1));
console.log('pendientes:', (await store.listMail('ideas')).length, '(12 = la reentrega no duplicó el buzón)');
const [ra, rb] = await Promise.all([atenderIdeas(a), atenderIdeas(b)]);
console.log(`dos relojes: ${ra} + ${rb} = ${ra + rb}`);
// Reentrega DESPUÉS del tick (ya confirmado y acked).
const re2 = await b.inbound(enviados[1], relay(enviados[1]));
console.log('reentrega después del tick:', JSON.stringify(re2));
await Promise.all([atenderIdeas(a), atenderIdeas(b)]);
const lista = await listarIdeas(a);
const ids = lista.map((x) => x.id);
console.log('registro:', ids.join(','), '| _n =', await store.kvGet('ideas', '_n'));
console.log('sobres únicos:', new Set(lista.map((x) => x.id_sobre)).size, '| huecos:', ids.some((id, i) => id !== `IDEA-${String(i + 1).padStart(3, '0')}`));
await drenar();
const conf = (await store.listMail('nicholas')).filter((m) => m.envelope.from === IDEAS);
console.log('confirmaciones en nicholas@:', conf.length, '| in_reply_to únicos:', new Set(conf.map((m) => m.envelope.in_reply_to)).size);
// Un sobre con el mismo id pero contenido distinto (un replay mutado): ¿lo acepta la puerta?
const mutado = { ...enviados[2], content: { media: 'text/plain', body: 'otro' } };
console.log('mismo id, cuerpo distinto (firma no cuadra):', JSON.stringify(await a.inbound(mutado, relay(mutado))).slice(0, 120));
