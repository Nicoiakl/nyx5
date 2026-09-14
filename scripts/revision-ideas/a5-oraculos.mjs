// Ataque 5: GET /ideas sin firma, con firma ajena, foránea, delegado; /admin/ideas sin Bearer; apagado = 404 igual a ruta desconocida.
import { levantar, DOM } from './casa.mjs';
import { Estafeta } from '../../src/correo/estafeta.js';
import { D1Store } from '../../src/nucleo/almacen-d1.js';
import { openLocalD1 } from '../../src/nucleo/d1-local.js';
import { MIGRACIONES } from '../../test/_migraciones.js';
import { Agent } from '../../src/correo/agente.js';
const { a, rx, agente, nicholas, nico, claudeNico } = await levantar();
const como = (ag, path, method = 'GET') => rx(method, path, undefined, ag._auth(method, path));
const otro = await agente('otro');
const filas = [];
const f = async (nombre, p) => { const r = await p; filas.push([nombre, r.status, JSON.stringify(r.body).slice(0, 90)]); };
await f('GET /ideas sin firma', rx('GET', '/ideas', undefined, null));
await f('GET /ideas Bearer malo', rx('GET', '/ideas', undefined, 'Bearer nope'));
await f('GET /ideas token basura', rx('GET', '/ideas', undefined, 'Nyx5 basura.basura'));
await f('GET /ideas otro@ (ajeno)', como(otro, '/ideas'));
await f('GET /ideas nico@ (en lista)', como(nico, '/ideas'));
await f('GET /ideas claude.nico@ (delegado)', como(claudeNico, '/ideas'));
await f('GET /ideas dueño', como(nicholas, '/ideas'));
// Comparación con otras rutas del dueño: /outbox/<l> y /eventos con firma ajena y sin firma.
await f('GET /outbox/nicholas sin firma', rx('GET', '/outbox/nicholas', undefined, null));
await f('GET /outbox/nicholas otro@', como(otro, '/outbox/nicholas'));
await f('GET /eventos otro@', como(otro, '/eventos'));
await f('POST /admin/ideas sin Bearer', rx('POST', '/admin/ideas', { owner: nicholas.address }, null));
await f('POST /admin/ideas firma dueño', como(nicholas, '/admin/ideas', 'POST'));
// Firma FORÁNEA (otra casa) sobre /ideas: token con host de esta casa pero agente ajeno.
const foraneo = Agent.create('x@otra.test', `https://${DOM}`, { fetchImpl: a.fetchPropio });
await f('GET /ideas firma foránea', rx('GET', '/ideas', undefined, foraneo._auth('GET', '/ideas')));
for (const r of filas) console.log(r.join(' | '));
// Apagado: 404 byte a byte igual a una ruta desconocida.
const db = openLocalD1(); db._raw.exec(MIGRACIONES);
const off = new Estafeta({ domain: 'off.test', store: new D1Store(db), adminToken: 't', publicUrl: 'https://off.test', workerIntervalMs: 999_999, log: () => {}, remoto: { enabled: true, vaultKey: Buffer.alloc(32, 1).toString('base64') } });
await off.init();
const q = (method, path, auth) => off.handleRequest({ method, path, query: new URLSearchParams(), headers: auth ? { authorization: auth } : {}, body: method === 'POST' ? {} : undefined, ip: 'x' });
const pares = [[await q('GET', '/ideas', 'Bearer t'), await q('GET', '/ideaz', 'Bearer t')], [await q('POST', '/admin/ideas', 'Bearer t'), await q('POST', '/admin/ideaz', 'Bearer t')], [await q('GET', '/ideas'), await q('GET', '/no-existe')]];
for (const [x, y] of pares) console.log('apagado:', JSON.stringify(x), JSON.stringify(x) === JSON.stringify(y) ? '== ruta desconocida' : `!= ${JSON.stringify(y)}`);
