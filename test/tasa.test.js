// node --test test/
// Límites de tasa durables (13-sep-2026, NX-901). Antes cada isolate del edge contaba por su lado y
// todos los agentes de la casa compartían un balde por dominio: uno solo frenaba a todos, y el límite
// real era N veces el declarado. Lo que estas pruebas cuidan: dos instancias sobre el MISMO almacén
// cuentan juntas, un agente que se pasa recibe 429 sin frenar a los demás, y el 429 dice cuándo volver.
import { test as _test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Estafeta } from '../src/correo/estafeta.js';
import { Agent } from '../src/correo/agente.js';
import { D1Store } from '../src/nucleo/almacen-d1.js';
import { openLocalD1, sqliteAvailable } from '../src/nucleo/d1-local.js';
import { RateLimiterDurable } from '../src/correo/politica.js';
import { MIGRACIONES } from "./_migraciones.js";
import { signObject } from "../src/nucleo/crypto.js";

// El emulador D1 usa node:sqlite (Node 22.5+). Sin él, la suite salta: no finge un verde.
const test = sqliteAvailable ? _test : (n) => _test(n, { skip: 'node:sqlite no disponible' });

// Puertos propios de esta suite (npm test corre los archivos en paralelo). Lo cuida test/puertos.test.js.
const P1 = 4296, P2 = 4297;
const H = 'tasa.test';
const URL_CASA = `http://127.0.0.1:${P1}`;
const hosts = { [H]: { url: URL_CASA } };
let store, casa1, casa2, ana, beto;

before(async () => {
  if (!sqliteAvailable) return;
  const db = openLocalD1(); db._raw.exec(MIGRACIONES); store = new D1Store(db);
  // Dos casas = dos isolates del edge sobre el mismo D1. Mismo dominio, mismas llaves (casa2 las
  // toma del almacén que casa1 ya inicializó), límite bajo para poder medirlo.
  const cfg = { domain: H, store, adminToken: 't', hosts, workerIntervalMs: 100, libro: { welcome: 0, feeBps: 0 }, log: () => {}, policy: { rate_per_minute: 5 } };
  casa1 = await new Estafeta({ ...cfg, port: P1 }).start();
  casa2 = await new Estafeta({ ...cfg, port: P2 }).start();
  ana = Agent.create(`ana-l@${H}`, URL_CASA, { hosts });
  beto = Agent.create(`beto@${H}`, URL_CASA, { hosts });
  for (const a of [ana, beto]) await a.register({ adminToken: 't' });
});
after(async () => { await casa1?.stop(); await casa2?.stop(); });

const sobre = (de, para, i) => signObject({ nyx5: '1', id: `${de.local}-${i}-${Date.now()}`, from: de.address, to: [para.address], created: new Date().toISOString(), expires: null, thread: null, in_reply_to: null, type: 'message', content: { media: 'text/plain', body: `n${i}` } }, de.keys);

test('el contador es del almacén: dos instancias suman juntas, y un agente que se pasa no frena a otro', async () => {
  // 5 por minuto: tres sobres por una instancia y tres por la otra. El sexto se rechaza con 429,
  // aunque cada instancia por sí sola sólo vio tres.
  const codigos = [];
  for (let i = 0; i < 6; i++) codigos.push((await (i % 2 ? casa2 : casa1).inbound(sobre(ana, beto, i))).code);
  assert.deepEqual(codigos, [202, 202, 202, 202, 202, 429], `secuencia: ${codigos}`);
  // beto sigue mandando: la clave es la dirección, no el dominio.
  assert.equal((await casa2.inbound(sobre(beto, ana, 0))).code, 202, 'un agente frenó a toda la casa');
});

test('el 429 por HTTP lleva Retry-After, y la resolución por IP también se limita', async () => {
  // Por HTTP entra con ip 127.0.0.1; el buzón de ana ya tiene la ventana llena.
  const r = await fetch(`${URL_CASA}/inbound`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sobre(ana, beto, 9)) });
  assert.equal(r.status, 429);
  const ra = Number(r.headers.get('retry-after'));
  assert.ok(ra >= 1 && ra <= 60, `Retry-After en segundos hasta la ventana siguiente: ${r.headers.get('retry-after')}`);
  // /resolve cuenta por IP: cinco pasan, el sexto no, desde cualquiera de las dos instancias.
  const estados = [];
  for (let i = 0; i < 6; i++) estados.push((await fetch(`http://127.0.0.1:${i % 2 ? P2 : P1}/resolve/${encodeURIComponent(beto.address)}`)).status);
  assert.deepEqual(estados, [200, 200, 200, 200, 200, 429], `resolve: ${estados}`);
});

test('la ventana es de un minuto fijo y un almacén caído deja pasar (precisión sobre cobertura)', async () => {
  const t0 = Date.parse('2026-09-14T03:00:00Z');
  const lim = new RateLimiterDurable({ store, perMinute: 2, ns: 'tasa-prueba' });
  assert.equal(await lim.allow('k', t0), true);
  assert.equal(await lim.allow('k', t0 + 1000), true);
  assert.equal(await lim.allow('k', t0 + 2000), false);
  assert.equal(await lim.allow('k', t0 + 60_000), true, 'la ventana siguiente arranca en cero');
  assert.equal(lim.retryAfter(t0 + 2000), 58);
  const roto = new RateLimiterDurable({ store: { kvIncrement: async () => { throw new Error('D1 caído'); } }, perMinute: 1 });
  assert.equal(await roto.allow('k'), true, 'un límite de tasa caído no puede tumbar el correo de todos');
});
