// Ataque 3: 1,1 MB rechazado; 120 sobres/min de ~1 MB (cuerpo 700 KB): crecimiento de nyx5_mailbox.
import { levantar, ms } from './casa.mjs';
import { atenderIdeas } from '../../src/correo/ideas.js';
const { a, store, nicholas, drenar, IDEAS } = await levantar();
const bytes = () => store.db.prepare("SELECT COUNT(*) c, SUM(LENGTH(doc)) b FROM nyx5_mailbox WHERE local='ideas'").first();
try { await nicholas.send({ to: IDEAS, body: 'x'.repeat(1_100_000) }); console.log('1,1 MB: ACEPTADO (MAL)'); } catch (e) { console.log('1,1 MB:', e.message.slice(0, 90)); }
console.log('buzón antes:', await bytes());
const N = Number(process.argv[2] || 120);
let t0 = performance.now();
for (let i = 0; i < N; i++) await nicholas.send({ to: IDEAS, body: 'y'.repeat(700_000) });
console.log(`${N} sobres de 900 KB encolados en ${ms(t0)}`);
t0 = performance.now(); await drenar(); console.log(`drenados en ${ms(t0)}`);
const b = await bytes(); console.log('buzón después:', b, `= ${(b.b / 1e6).toFixed(1)} MB en un minuto; extrapolado 24 h a esta tasa: ${(b.b * 1440 / 1e9).toFixed(1)} GB`);
console.log('cola pendiente (frenados por tasa):', (await store.listQueue()).length);
t0 = performance.now(); const r = await atenderIdeas(a); console.log(`tick con ${b.c} sobres de 900 KB: ${ms(t0)}, registradas ${r}`);
