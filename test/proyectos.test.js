// node --test test/
// Proyectos en la lista de conversaciones (14-sep-2026, decisión de Nicholas): la app filtra por
// proyecto sin leer cada hilo. `GET /conversations/<local>` devuelve por contacto `projects` (los
// vistos, por último uso, a lo sumo 20) y `pending_by_project` (sólo si hay pendientes), y con
// `?project=` calcula count/pending/last_at sobre ese proyecto. Lo que estas pruebas cuidan:
//   - sin proyecto no hay entrada (no se inventa un «(none)»); pendiente se cuenta por proyecto;
//   - `?project=` es exacto (ni prefijo ni comodín), con la MISMA normalización que al enviar
//     (NFKC, sin invisibles, minúsculas): un homógrafo no esconde un hilo del filtro;
//   - una inyección en el parámetro no encuentra nada (no hay LIKE ni JSON path con el valor);
//   - un secreto y un inexistente contestan byte a byte lo mismo (la ruta es del dueño);
//   - la herramienta MCP que lista conversaciones expone `projects`; FileStore y D1Store, igual.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Estafeta, PROYECTOS_POR_CONTACTO } from '../src/correo/estafeta.js';
import { Agent } from '../src/correo/agente.js';
import { llamar } from '../src/puentes/herramientas.js';
import { D1Store } from '../src/nucleo/almacen-d1.js';
import { openLocalD1, sqliteAvailable } from '../src/nucleo/d1-local.js';
import { MIGRACIONES } from './_migraciones.js';

// Puertos propios de esta suite (npm test corre los archivos en paralelo). Lo cuida test/puertos.test.js.
const P1 = 4801, P2 = 4802;
const DF = 'proy-f.test', DD = 'proy-d.test';
const hosts = { [DF]: { url: `http://127.0.0.1:${P1}` }, [DD]: { url: `http://127.0.0.1:${P2}` } };
let tmp, casaF, casaD;
const cfg = (domain, port, extra = {}) => ({ domain, port, dataDir: path.join(tmp, domain), adminToken: 't', hosts, workerIntervalMs: 20, log: () => {}, libro: { welcome: 0, feeBps: 0 }, policy: { registration: 'open', registrations_per_minute: 500, rate_per_minute: 2000 }, ...extra });

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-proyectos-'));
  casaF = await new Estafeta(cfg(DF, P1)).start();
  if (sqliteAvailable) {
    const db = openLocalD1(); db._raw.exec(MIGRACIONES);
    casaD = await new Estafeta(cfg(DD, P2, { store: new D1Store(db) })).start();
  }
});
after(async () => { await casaF?.stop(); await casaD?.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

// Entrega en orden: se espera cada sobre antes de mandar el siguiente, así `received` crece.
const llega = async (a, id) => { const m = await a.waitFor((e) => e.id === id, { timeoutMs: 5000 }); assert.ok(m, `no llegó ${id}`); return m; };
const manda = async (de, a, body, project) => { const r = await de.send({ to: a.address, body, project }); return llega(a, r.id); };
const lista = async (a, query = null) => (await a._call('GET', `/conversations/${a.local}${query ? `?${new URLSearchParams(query)}` : ''}`)).conversations;
const porContacto = (convs) => Object.fromEntries(convs.map((c) => [c.with, c]));

// Dos contactos, tres proyectos, pendientes por proyecto; vale igual para los dos almacenes.
async function escenario(domain, url) {
  const ana = Agent.create(`anita@${domain}`, url, { hosts });
  const beto = Agent.create(`beto@${domain}`, url, { hosts });
  const carla = Agent.create(`carla@${domain}`, url, { hosts });
  const dani = Agent.create(`dani@${domain}`, url, { hosts });
  for (const a of [ana, beto, carla, dani]) await a.register({ adminToken: 't' });
  // beto: dos de sigo (pendientes), una de rosetta (se confirma), una sin proyecto (pendiente);
  // y ana le contesta bajo rosetta: el último uso de rosetta es la salida de ana.
  await manda(beto, ana, 'sigo 1', 'sigo');
  const s2 = await manda(beto, ana, 'sigo 2', 'sigo');
  const ros = await manda(beto, ana, 'rosetta 1', 'rosetta');
  await manda(beto, ana, 'sin proyecto', undefined);
  await ana.ack(ros.envelope.id);
  await ana.send({ to: beto.address, body: 'respuesta rosetta', project: 'rosetta' });
  // carla: qready pendiente y «Sigo» con un ancho cero adentro (U+200B): se normaliza a sigo.
  await manda(carla, ana, 'qready 1', 'qready');
  await manda(carla, ana, 'sigo con invisible', 'Si\u200bgo');
  // dani: nunca etiquetó nada.
  await manda(dani, ana, 'hola', undefined);

  const todo = porContacto(await lista(ana));
  assert.deepEqual(Object.keys(todo).sort(), [beto.address, carla.address, dani.address].sort());
  const b = todo[beto.address];
  assert.equal(b.count, 5); assert.equal(b.pending, 3);
  assert.deepEqual(b.projects, ['rosetta', 'sigo'], 'por último uso: la salida de ana bajo rosetta es lo más reciente');
  assert.deepEqual(b.pending_by_project, { sigo: 2 }, 'rosetta se confirmó y lo sin proyecto no cuenta bajo ninguno');
  assert.ok(!('pending_other' in b), 'con todos los proyectos listados no hay pending_other (silencio)');
  const c = todo[carla.address];
  assert.equal(c.count, 2); assert.equal(c.pending, 2);
  assert.deepEqual(c.projects, ['sigo', 'qready'], 'el homógrafo con ancho cero se lee como sigo, y es el último');
  assert.deepEqual(c.pending_by_project, { sigo: 1, qready: 1 });
  const d = todo[dani.address];
  assert.deepEqual(d.projects, [], 'sin proyecto no se inventa uno');
  assert.ok(!('pending_by_project' in d), 'sin pendientes bajo un proyecto no hay pending_by_project');
  assert.equal(d.pending, 1, 'lo pendiente sin proyecto sigue contando en pending');

  // ?project= exacto: sólo los contactos con ese proyecto, y los números SOBRE ese proyecto.
  const sigo = porContacto(await lista(ana, { project: 'sigo' }));
  assert.deepEqual(Object.keys(sigo).sort(), [beto.address, carla.address].sort(), 'dani no tiene sigo');
  assert.equal(sigo[beto.address].count, 2); assert.equal(sigo[beto.address].pending, 2);
  assert.equal(sigo[beto.address].last_at, s2.received, 'last_at es el del último mensaje DE ESE proyecto');
  assert.deepEqual(sigo[beto.address].projects, ['sigo']);
  assert.deepEqual(sigo[beto.address].pending_by_project, { sigo: 2 });
  assert.equal(sigo[carla.address].count, 1);
  const rosetta = porContacto(await lista(ana, { project: 'rosetta' }));
  assert.deepEqual(Object.keys(rosetta), [beto.address]);
  assert.equal(rosetta[beto.address].count, 2, 'una recibida (confirmada) y una enviada');
  assert.equal(rosetta[beto.address].pending, 0);
  assert.ok(!('pending_by_project' in rosetta[beto.address]));
  // Ni prefijo ni comodín; la misma normalización que al enviar: mayúsculas e invisibles no cambian nada.
  assert.deepEqual(await lista(ana, { project: 'sig' }), [], 'prefijo');
  assert.deepEqual(await lista(ana, { project: 'sigo%' }), [], 'comodín');
  assert.deepEqual(await lista(ana, { project: 'SIGO' }), await lista(ana, { project: 'sigo' }), 'la casa normaliza a minúsculas al enviar y al filtrar');
  assert.deepEqual(await lista(ana, { project: 's\u200bigo' }), await lista(ana, { project: 'sigo' }), 'un invisible en el filtro se quita como al enviar');
  assert.deepEqual(await lista(ana, { project: 'nada' }), []);
  return { ana, beto, carla, dani };
}

let F;
test('FileStore · proyectos por contacto, pendientes por proyecto y ?project= exacto', async () => { F = await escenario(DF, hosts[DF].url); });
test('D1Store · lo mismo, con el sobre guardado como JSON en D1', { skip: sqliteAvailable ? false : 'node:sqlite no disponible (Node 22+)' }, async () => { await escenario(DD, hosts[DD].url); });

test('un contacto con más de 20 proyectos devuelve los 20 de último uso; el resto no viaja', async () => {
  const { ana } = F;
  const mucho = Agent.create(`mucho@${DF}`, hosts[DF].url, { hosts });
  await mucho.register({ adminToken: 't' });
  const n = PROYECTOS_POR_CONTACTO + 5;
  for (let i = 1; i <= n; i++) await manda(mucho, ana, `p${i}`, `proyecto-${String(i).padStart(2, '0')}`);
  const m = porContacto(await lista(ana))[mucho.address];
  assert.equal(m.count, n);
  assert.equal(m.projects.length, PROYECTOS_POR_CONTACTO);
  const esperados = []; for (let i = n; i > n - PROYECTOS_POR_CONTACTO; i--) esperados.push(`proyecto-${String(i).padStart(2, '0')}`);
  assert.deepEqual(m.projects, esperados, 'los más recientes primero, y los cinco primeros quedan fuera');
  // Revisión del 14-sep-2026: `pending_by_project` traía UNA clave por proyecto pendiente (1.000 con
  // la ventana del historial) y el lector no podía cruzarlas con los 20 de `projects`. Ahora cubre
  // exactamente los listados y el resto va sumado en `pending_other`.
  assert.deepEqual(Object.keys(m.pending_by_project).sort(), [...esperados].sort(), 'pending_by_project cubre exactamente los proyectos listados');
  assert.equal(Object.values(m.pending_by_project).reduce((s, x) => s + x, 0), PROYECTOS_POR_CONTACTO);
  assert.equal(m.pending_other, 5, 'lo pendiente bajo los cinco proyectos que no se listan va sumado');
  assert.equal(m.pending, PROYECTOS_POR_CONTACTO + 5, 'la suma cuadra: pending = listados + pending_other');
  // Y el filtro sigue encontrando un proyecto que no está entre los 20 listados.
  assert.equal(porContacto(await lista(ana, { project: 'proyecto-01' }))[mucho.address].count, 1);
});

// Revisión del 14-sep-2026: un proyecto llamado `constructor` quedaba listado en `projects` y, sin
// pendientes, ausente de `pending_by_project`; un lector que hiciera `mapa['constructor']` recibía
// una FUNCIÓN (heredada del prototipo) en vez de 0. `__proto__` como clave, al armar un objeto,
// pisa el prototipo. Se rechaza al enviar (con nombre) y la casa lee «sin proyecto» si llega igual.
test('project `__proto__` o `constructor`: el cliente no lo manda, la casa lo lee como sin proyecto', async () => {
  const { ana } = F;
  const reser = Agent.create(`reser@${DF}`, hosts[DF].url, { hosts });
  await reser.register({ adminToken: 't' });
  for (const p of ['__proto__', 'constructor', '\u200b', '\u0000 ']) {
    await assert.rejects(reser.send({ to: ana.address, body: 'x', project: p }), /invalid project name/, `${JSON.stringify(p)} debería rechazarse al enviar`);
  }
  // Silencio: un nombre que CONTIENE la palabra no es la palabra; `toString` en minúsculas no colisiona.
  const ok = await reser.send({ to: ana.address, body: 'x', project: 'Constructor Naval' });
  await llega(ana, ok.id);
  const tostring = await reser.send({ to: ana.address, body: 'x', project: 'toString' });
  await llega(ana, tostring.id);
  // Un sobre que llega de FUERA con ese proyecto (otra implementación no tiene este cliente): la casa
  // lo cuenta como pendiente sin proyecto, nunca como clave del objeto.
  const { uuid } = await import('../src/nucleo/crypto.js');
  for (const p of ['__proto__', 'constructor']) casaF.store.putMail(ana.local, { nyx5: '1', id: uuid(), from: reser.address, to: [ana.address], type: 'message', created: new Date().toISOString(), extensions: { 'urn:nyx5:ext:proyecto': { project: p } }, content: { body: 'x' } }, {});
  const r = porContacto(await lista(ana))[reser.address];
  assert.deepEqual(r.projects, ['tostring', 'constructor naval'], 'ni __proto__ ni constructor se listan; los nombres legítimos sí');
  assert.equal(Object.getPrototypeOf(r.pending_by_project), Object.prototype, 'el objeto no lleva el prototipo pisado');
  assert.ok(!Object.hasOwn(r.pending_by_project, '__proto__') && !Object.hasOwn(r.pending_by_project, 'constructor'));
  assert.deepEqual(r.pending_by_project, { tostring: 1, 'constructor naval': 1 });
  assert.equal(r.pending, 4, 'los dos de fuera cuentan como pendientes sin proyecto');
  assert.ok(!('pending_other' in r), 'sin proyecto no es «otro proyecto»');
  // Y lo que un lector ingenuo recibiría por cada proyecto listado es siempre un número.
  for (const p of r.projects) assert.equal(typeof r.pending_by_project[p], 'number');
});

// Revisión del 14-sep-2026: `?project=%00` (o sólo invisibles, o `__proto__`) caía a «sin filtro» y
// devolvía la lista ENTERA a quien pidió un proyecto. Ahora es 400 con razón; `project=` vacío
// sigue siendo «sin filtro». Y el 400 sale DESPUÉS de autenticar: a un ajeno o a un token basura se
// le contesta lo mismo con y sin el parámetro (no es un oráculo nuevo).
test('?project= que no es un nombre es 400; vacío es sin filtro; a un ajeno no le cambia nada', async () => {
  const { ana, beto } = F;
  const pide = async (p, init = { headers: { authorization: ana._auth('GET', `/conversations/${ana.local}`) } }, local = ana.local) => fetch(`${hosts[DF].url}/conversations/${local}?${new URLSearchParams({ project: p })}`, init);
  for (const p of ['\u0000', '\u200b', '   ', '__proto__', 'constructor', '\u202e']) {
    const r = await pide(p);
    assert.equal(r.status, 400, `${JSON.stringify(p)} dio ${r.status}`);
    assert.match((await r.json()).reason, /invalid project/);
  }
  const vacio = await (await pide('')).json();
  assert.deepEqual(vacio, { conversations: await lista(ana) }, 'project= vacío es la lista sin filtro');
  // Espera en tiempo real: la misma regla.
  const w = await fetch(`${hosts[DF].url}/mailbox/${ana.local}/wait?project=%00&timeout=0`, { headers: { authorization: ana._auth('GET', `/mailbox/${ana.local}/wait`) } });
  assert.equal(w.status, 400);
  // Ajeno y sin credencial: con `?project=%00` la respuesta es la de siempre (403 / 401), nunca 400.
  const ajeno = await pide('\u0000', { headers: { authorization: beto._auth('GET', `/conversations/${ana.local}`) } });
  assert.equal(ajeno.status, 403);
  const nadie = await pide('\u0000', {});
  assert.equal(nadie.status, 401);
});

// El puente normaliza como la casa: `nyx5_inbox { project }` con un homógrafo encontraba 0 mientras
// la casa lo colapsaba a `sigo` (trim().toLowerCase() en vez de nombreDeProyecto, 14-sep-2026).
test('nyx5_inbox filtra por proyecto con la MISMA normalización que la casa', async () => {
  const { ana } = F;
  const conInvisible = JSON.parse((await llamar(ana, 'nyx5_inbox', { project: 'SI\u200bGO', limit: 50 })).content[0].text);
  const plano = JSON.parse((await llamar(ana, 'nyx5_inbox', { project: 'sigo', limit: 50 })).content[0].text);
  assert.ok(plano.length >= 3, `se esperaban los pendientes de sigo, hay ${plano.length}`);
  assert.deepEqual(conInvisible.map((m) => m.id), plano.map((m) => m.id));
});

test('inyección en ?project=: nada de LIKE ni de JSON path con el valor; contesta vacío, no 500', async () => {
  const { ana } = F;
  const pide = async (p) => { const r = await fetch(`${hosts[DF].url}/conversations/${ana.local}?${new URLSearchParams({ project: p })}`, { headers: { authorization: ana._auth('GET', `/conversations/${ana.local}`) } }); assert.equal(r.status, 200, `${JSON.stringify(p)} dio ${r.status}`); return (await r.json()).conversations; };
  for (const p of ["sigo' OR 1=1--", '$.sigo', '%', '_', 'sigo*', '{"project":"sigo"}', '"sigo"', 'sigo.*', '(sigo|rosetta)', '[]', '{"$ne":null}', 'a'.repeat(10240), 'sigo' + 'a'.repeat(10240)]) {
    assert.deepEqual(await pide(p), [], `${JSON.stringify(p)} no debería encontrar nada`);
  }
  // Lo que la casa normaliza al ENVIAR se normaliza igual al filtrar: un bidi (U+202E) se quita, un
  // control (NUL) pasa a espacio y se recorta, un espacio final se recorta. No es un escape: es
  // `nombreDeProyecto`, la misma función en las dos puertas.
  const sigo = await pide('sigo');
  assert.ok(sigo.length >= 2);
  for (const p of ['\u202esigo', 'sigo\u0000', 'sigo ', ' sigo']) assert.deepEqual(await pide(p), sigo, `${JSON.stringify(p)} debería normalizar a sigo`);
});

test('la herramienta MCP que lista conversaciones expone projects, y con project filtra igual', async () => {
  const { ana, beto, carla } = F;
  const todas = JSON.parse((await llamar(ana, 'nyx5_conversation', {})).content[0].text);
  const b = todas.find((x) => x.with === beto.address);
  assert.deepEqual(b.projects, ['rosetta', 'sigo']);
  assert.deepEqual(b.pending_by_project, { sigo: 2 });
  const qready = JSON.parse((await llamar(ana, 'nyx5_conversation', { project: 'qready' })).content[0].text);
  assert.deepEqual(qready.map((x) => x.with), [carla.address]);
  assert.deepEqual(qready[0].projects, ['qready']);
});

// La ruta es del dueño: a cualquier otro se le contesta lo mismo exista o no el nombre, sea secreto
// o no. Se compara cuerpo y cabeceras (menos la fecha), como en test/visibilidad.test.js.
test('un secreto y un inexistente contestan byte a byte lo mismo en /conversations', async () => {
  const { beto } = F;
  const sombra = Agent.create(`sombra@${DF}`, hosts[DF].url, { hosts });
  await sombra.register({ adminToken: 't', visibility: 'secret' });
  const foto = async (local, init, q = '') => { const r = await fetch(`${hosts[DF].url}/conversations/${local}${q}`, init); const h = Object.fromEntries([...r.headers].filter(([k]) => k !== 'date')); return { status: r.status, headers: h, body: (await r.text()).replace(/sombra|nadie/g, 'N') }; };
  // 1. Sin credencial. 2. Token basura. 3. Firmado por otro agente de la casa. Con y sin `?project=`
  // (también uno inválido): el parámetro se evalúa después de autenticar, así que no distingue nada.
  const casos = [{}, { headers: { authorization: 'Nyx5 basura.basura' } }, (local) => ({ headers: { authorization: beto._auth('GET', `/conversations/${local}`) } })];
  for (const caso of casos) {
    const init = (local) => (typeof caso === 'function' ? caso(local) : caso);
    for (const q of ['', '?project=sigo', '?project=%00']) {
      const a = await foto('sombra', init('sombra'), q), b = await foto('nadie', init('nadie'), q);
      assert.deepEqual(a, b, `caso ${JSON.stringify(init('x'))} ${q}: sombra se distingue de nadie`);
      assert.notEqual(a.status, 200);
      assert.notEqual(a.status, 400, `${q}: el 400 del proyecto no puede salir antes de autenticar`);
    }
  }
  // Y el dueño sí ve lo suyo (silencio: la guardia no tapa el uso legítimo).
  assert.deepEqual(await lista(sombra), []);
});
