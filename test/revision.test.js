// node --test test/
// NX-903 · la revisión adversarial automatizable corre como prueba. Lo que se cuida aquí es doble:
// que una casa recién levantada pase el guion (ninguna falla, y las comprobaciones se EJERCITARON,
// no quedaron indecisas), y que el guion GRITE cuando el defecto está: se le inyecta un fetch que
// reproduce tres defectos reales del 14-sep (un 500 ante %E0%A4%A, un 429 sin Retry-After, y un
// secreto que se distingue de un inexistente) y cada uno tiene que aparecer nombrado.
// Qué NO cubre: lo que exige juicio (scripts/revision-adversarial.md) ni el edge real.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Estafeta } from '../src/correo/estafeta.js';
import { revisar, SEGMENTO_ROTO, RUTAS_CON_NOMBRE, RUTAS_GET } from '../scripts/revision-adversarial.mjs';

// Puerto propio de esta suite (npm test corre en paralelo; lo cuida test/puertos.test.js).
const P = 4751;
const H = 'revision.test';
const URL_CASA = `http://127.0.0.1:${P}`;
let tmp, casa;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-revision-test-'));
  casa = new Estafeta({
    domain: H, port: P, dataDir: path.join(tmp, H), adminToken: 't', hosts: { [H]: { url: URL_CASA } },
    workerIntervalMs: 60_000, log: () => {},
    policy: { registration: 'open', registrations_per_minute: 20, rate_per_minute: 20 },
    index: { enabled: true, crawlMinutes: 999 }, verifica: { enabled: true },
    tareas: { catalogo: [{ id: 'hola', concept: 'decir hola', price: 10, verify: { type: 'sha256', expect: '0'.repeat(64) } }] },
  });
  await casa.start();
});
after(async () => { await casa.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

const porId = (r) => Object.fromEntries(r.comprobaciones.map((c) => [c.id, c]));

test('una casa recién levantada pasa el guion, y las comprobaciones se ejercitaron de verdad', async () => {
  const r = await revisar({ url: URL_CASA, adminToken: 't', intentos: 60 });
  const c = porId(r);
  assert.equal(r.fallas, 0, r.comprobaciones.filter((x) => x.estado === 'falla').map((x) => `${x.id}: ${x.detalle}`).join('\n'));
  // Denominador: cuántas se ejercitaron. Un guion que deja todo indeciso también daría cero fallas.
  for (const id of ['casa', '404-secreto', '500-decode', '429-retry-after', 'tarjetas-sistema', 'tools-tope', 'cursor-fabricado', 'cuerpo-gigante']) {
    assert.equal(c[id]?.estado, 'ok', `${id}: ${c[id]?.estado} — ${c[id]?.detalle}`);
  }
  assert.equal(r.total, r.ok + r.fallas + r.indecisas);
  assert.ok(RUTAS_CON_NOMBRE.length >= 10 && RUTAS_GET.length > RUTAS_CON_NOMBRE.length, 'la lista de rutas públicas no se achicó');
  // El 429 se provocó en varias cubetas, no en una sola.
  assert.match(c['429-retry-after'].detalle, /presente en [3-9] cubeta/);
});

// Grito: el mismo guion contra un mundo con los defectos puestos. Se inyecta el fetch, no se toca
// la casa: lo que se prueba es que el guion los VE.
test('el guion grita ante un 500 por decodificación, un 429 sin Retry-After y un secreto distinguible', async () => {
  const conDefectos = async (u, o) => {
    const url = String(u);
    if (url.includes(SEGMENTO_ROTO) && /\/agents\/[^/?]+\/presence/.test(url)) return new Response('{"reason":"URI malformed"}', { status: 500, headers: { 'content-type': 'application/json' } });
    if (/\/agents\/rev-s-[0-9a-f]{8}\/historial$/.test(url)) return new Response('{"reason":"secret"}', { status: 403, headers: { 'content-type': 'application/json' } });
    const r = await fetch(u, o);
    if (r.status === 429 && url.includes('/notaria/')) {
      const h = new Headers(r.headers); h.delete('retry-after');
      return new Response(await r.text(), { status: 429, headers: h });
    }
    return r;
  };
  const r = await revisar({ url: URL_CASA, adminToken: 't', intentos: 60, fetchImpl: conDefectos });
  const c = porId(r);
  assert.equal(c['500-decode'].estado, 'falla');
  assert.match(c['500-decode'].detalle, /presence.*-> 500/);
  assert.equal(c['429-retry-after'].estado, 'falla');
  assert.match(c['429-retry-after'].detalle, /notaria/);
  assert.equal(c['404-secreto'].estado, 'falla');
  assert.match(c['404-secreto'].detalle, /historial.*\(403 vs 404\)/);
  assert.equal(r.fallas, 3, 'exactamente los tres defectos inyectados, ninguno de más');
});

// Silencio: sin registro posible, la comparación secreto/inexistente NO se declara verde: queda
// indecisa y lo dice. Un guion que no pudo mirar no afirma.
test('lo que no se pudo ejercitar queda indeciso, no verde', async () => {
  const sinRegistro = async (u, o) => (o?.method === 'POST' && String(u).endsWith('/agents') ? new Response('{"reason":"closed"}', { status: 403, headers: { 'content-type': 'application/json' } }) : fetch(u, o));
  const r = await revisar({ url: URL_CASA, adminToken: 't', inundar: false, fetchImpl: sinRegistro });
  const c = porId(r);
  assert.equal(c['404-secreto'].estado, 'indecisa');
  assert.match(c['404-secreto'].detalle, /no se pudo registrar/);
  assert.equal(c['429-retry-after'].estado, 'indecisa');
  assert.equal(r.indecisas, 2);
});
