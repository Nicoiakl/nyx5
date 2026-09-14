// Ataque 1: 500 sobres de una dirección de la lista + 2.000 intros de 20 extraños.
import { levantar, ms } from './casa.mjs';
import { atenderIdeas, listarIdeas } from '../../src/correo/ideas.js';
const { a, store, agente, nicholas, drenar, IDEAS } = await levantar();
const N_LISTA = Number(process.argv[2] || 500), N_EXTRANOS = 20, INTROS = Number(process.argv[3] || 100);
const extranos = []; for (let i = 0; i < N_EXTRANOS; i++) extranos.push(await agente(`extrano${i}`));
let t0 = performance.now();
// Primero la inundación de intros, DESPUÉS la idea legítima (peor caso: la idea va detrás de todo).
let rechazadosTasa = 0;
for (let i = 0; i < INTROS; i++) for (const x of extranos) await x.send({ to: IDEAS, type: 'intro', body: `hola ${i}` });
console.log(`encolados ${N_EXTRANOS * INTROS} intros en ${ms(t0)}`);
t0 = performance.now(); await drenar(); console.log(`drenados a inbound en ${ms(t0)}`);
const pendientes0 = (await store.listMail('ideas')).length;
const idea = await nicholas.send({ to: IDEAS, body: 'idea legítima detrás de la inundación' });
for (let i = 0; i < N_LISTA - 1; i++) await nicholas.send({ to: IDEAS, body: `idea ${i}` });
t0 = performance.now(); await drenar(); console.log(`drenados en ${ms(t0)}`);
const pend = await store.listMail('ideas');
console.log(`buzón de ideas@ pendiente: ${pend.length} (intros aceptados: ${pendientes0}; los otros ${N_EXTRANOS * INTROS - pendientes0} los frenó la tasa/política)`);
const bytesBuzon = () => store.db.prepare("SELECT COUNT(*) c, SUM(LENGTH(doc)) b FROM nyx5_mailbox WHERE local='ideas'").first();
console.log('nyx5_mailbox ideas@:', await bytesBuzon());
// Ticks del reloj: medir duración, _n, pendientes, outbox de ideas@, y en qué tick sale la idea legítima.
let tick = 0, turnoIdea = null;
while ((await store.listMail('ideas')).length && tick < 60) {
  tick++;
  const t = performance.now();
  const r = await atenderIdeas(a);
  const dur = ms(t);
  const n = await store.kvGet('ideas', '_n');
  const pendientes = (await store.listMail('ideas')).length;
  const outbox = (await store.listOutbox('ideas')).length;
  if (turnoIdea === null && (await listarIdeas(a)).some((x) => x.id_sobre === idea.id)) turnoIdea = tick;
  if (tick <= 5 || tick % 5 === 0) console.log(`tick ${tick}: ${dur}, registradas ${r}, _n=${n}, pendientes=${pendientes}, outbox ideas@=${outbox}`);
}
console.log(`la idea legítima se registró en el tick ${turnoIdea} (1 = no perdió su turno)`);
console.log(`ticks totales para vaciar: ${tick}; _n final=${await store.kvGet('ideas', '_n')}; ideas en el registro=${(await listarIdeas(a, { limit: 100000 })).length}`);
console.log('kv ideas filas:', await store.db.prepare("SELECT ns, COUNT(*) c FROM nyx5_kv GROUP BY ns").all().then((r) => r.results));
