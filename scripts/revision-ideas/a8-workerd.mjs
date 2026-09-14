// Ataque/recorrido 8: en workerd REAL (npx wrangler dev --port 8790 --local --test-scheduled, con .dev.vars y las
// migraciones aplicadas al D1 local). Alta por /admin/ideas, un sobre, el cron por /__scheduled, la
// confirmación en el buzón del remitente, GET /ideas del dueño y de la casa, un intro de un extraño rebotado.
// Lee el token de admin de .dev.vars y no lo imprime.
import fs from 'node:fs';
import { generateKeys } from '../../src/nucleo/crypto.js';
import { Agent } from '../../src/correo/agente.js';
const vars = Object.fromEntries(fs.readFileSync('.dev.vars', 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^"|"$/g, '')]));
const URL_CASA = process.argv[2] || 'http://localhost:8790';
const DOM = vars.NYX5_DOMAIN; const ADMIN = vars.NYX5_ADMIN_TOKEN;
console.log(`casa ${DOM} en ${URL_CASA}; token de admin: ${ADMIN.length} caracteres`);
const hosts = { [DOM]: { url: URL_CASA } };
const admin = (method, path, body) => fetch(`${URL_CASA}${path}`, { method, headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const sufijo = Date.now().toString(36).slice(-5);
const dueno = Agent.create(`prueba-ideas-${sufijo}@${DOM}`, URL_CASA, { hosts });
await dueno.register({ adminToken: ADMIN });
const extrano = Agent.create(`prueba-extrano-${sufijo}@${DOM}`, URL_CASA, { hosts });
await extrano.register({ adminToken: ADMIN });
console.log('registrados', dueno.address, extrano.address);
const health = await fetch(`${URL_CASA}/health`).then((r) => r.json()); console.log('health', JSON.stringify(health));
// Alta (o cambio de lista si ya existe de una corrida anterior: sin keys).
let alta = await admin('POST', '/admin/ideas', { owner: dueno.address, allow: [], keys: generateKeys() });
if (alta.status === 409) alta = await admin('POST', '/admin/ideas', { owner: dueno.address, allow: [] });
console.log('alta', alta.status, JSON.stringify(alta.body));
if (![200, 201].includes(alta.status)) process.exit(1);
const t0 = Date.now();
const enviado = await dueno.send({ to: `ideas@${DOM}`, body: 'Idea de prueba en workerd real', project: 'revision' });
const intro = await extrano.send({ to: `ideas@${DOM}`, type: 'intro', body: 'hola' });
console.log('enviados', enviado.id, '(idea)', intro.id, '(intro de extraño)');
// El cron: wrangler dev --test-scheduled expone /__scheduled. Dos veces: una entrega la cola, la otra atiende ideas@ y encola la confirmación; una tercera la entrega.
const cron = async () => { const r = await fetch(`${URL_CASA}/__scheduled?cron=*+*+*+*+*`); return `${r.status} ${(await r.text()).slice(0, 40)}`; };
for (let i = 1; i <= 4; i++) { console.log(`cron ${i}:`, await cron()); await new Promise((r) => setTimeout(r, 1500)); }
const conf = await dueno.waitFor((e) => e.from === `ideas@${DOM}` && e.in_reply_to === enviado.id, { timeoutMs: 15000 }).catch((e) => null);
if (!conf) { console.log('SIN CONFIRMACIÓN en el buzón del dueño'); process.exit(1); }
const abierto = await dueno.open(conf.envelope);
console.log('confirmación:', JSON.stringify(abierto.content.body), '| cifrada:', abierto.encrypted, '| proyecto:', abierto.project, '| firmada por:', abierto.sender.address, abierto.sender.custody?.via);
const rebote = await extrano.waitFor((e) => e.from === `postmaster@${DOM}` && e.in_reply_to === intro.id, { timeoutMs: 5000 }).catch(() => null);
console.log('intro del extraño:', rebote ? `rebotó: ${rebote.envelope.content.body.reason}` : 'SIN REBOTE');
const deIdeasAlExtrano = (await extrano.inbox({ limit: 100 })).filter((m) => m.envelope.from === `ideas@${DOM}`);
console.log('ideas@ le escribió al extraño:', deIdeasAlExtrano.length);
const mio = await fetch(`${URL_CASA}/ideas`, { headers: { authorization: dueno._auth('GET', '/ideas') } }).then(async (r) => ({ status: r.status, body: await r.json() }));
console.log('GET /ideas dueño:', mio.status, `total=${mio.body.total} count=${mio.body.count} next=${mio.body.next}`, JSON.stringify(mio.body.ideas.slice(-1)));
const ajeno = await fetch(`${URL_CASA}/ideas`, { headers: { authorization: extrano._auth('GET', '/ideas') } });
console.log('GET /ideas extraño:', ajeno.status, '| sin firma:', (await fetch(`${URL_CASA}/ideas`)).status);
console.log('GET /ideas casa:', (await admin('GET', '/ideas')).status);
console.log(`recorrido en workerd: ${Date.now() - t0} ms`);
