// node --test test/
// NX-801 — el embudo medido de punta a punta: enlace abierto -> dirección -> Claude conectado ->
// primer mensaje -> primer contrato -> primer mandato. Cada etapa es un evento del diario y el
// informe privado los junta por dirección raíz, por fuente y por semana ISO. Aquí se prueba con
// un recorrido REAL (invitación, OAuth del conector, sobres, cotización, mandato), no con eventos
// inventados; los inventados se usan sólo para el caso de recorridos incompletos.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { Estafeta } from '../src/correo/estafeta.js';
import { Agent } from '../src/correo/agente.js';
import { signObject, b64u } from '../src/nucleo/crypto.js';
import { semanaIso, ETAPAS } from '../src/libro/informe.js';

// Puerto propio de esta suite (npm test corre los archivos en paralelo). Lo cuida test/puertos.test.js.
const P = 4671;
const H = 'embudo.test';
const URL_CASA = `http://127.0.0.1:${P}`;
const hosts = { [H]: { url: URL_CASA } };
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
let tmp, casa, nico, basti, pauli, inv;

const s256 = (v) => b64u(createHash('sha256').update(v).digest());
const json = async (r) => ({ status: r.status, body: await r.json().catch(() => null) });
const form = (ruta, datos) => fetch(`${URL_CASA}${ruta}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(datos).toString() }).then(json);
const eventos = async (name) => (await casa.store.listEvents({ name })) || [];
const informe = () => fetch(`${URL_CASA}/informe.json`, { headers: { authorization: 'Bearer t' } }).then(json);
let rpcId = 0;
const herramienta = async (token, name, args, url) => {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
  }).then(json);
  assert.equal(r.status, 200, `tools/call ${name}: ${JSON.stringify(r.body)}`);
  return r.body.result;
};

// El flujo OAuth del conector, el mismo de test/puente-remoto.test.js: registro dinámico, PKCE,
// delegación firmada por la llave raíz del dueño, canje del código.
async function conectar(dueno, recurso) {
  const reg = await fetch(`${URL_CASA}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: [CALLBACK], grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method: 'none' }) }).then(json);
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const code_verifier = b64u(randomBytes(32));
  const pedido = { response_type: 'code', client_id: reg.body.client_id, redirect_uri: CALLBACK, state: 's', code_challenge: s256(code_verifier), code_challenge_method: 'S256', resource: recurso };
  assert.equal((await fetch(`${URL_CASA}/oauth/authorize?${new URLSearchParams(pedido)}`)).status, 200);
  const prep = await dueno._call('POST', '/oauth/prepare', pedido);
  const delegation = signObject({ by: dueno.address, address: prep.address, sig: prep.sig, scope: prep.scope, valid_until: prep.valid_until, issued: new Date().toISOString() }, dueno.keys);
  const ok = await dueno._call('POST', '/oauth/approve', { ...pedido, delegation, allowlist: [] });
  const code = new URL(ok.redirect).searchParams.get('code');
  const tok = await form('/oauth/token', { grant_type: 'authorization_code', code, code_verifier, client_id: reg.body.client_id, redirect_uri: CALLBACK, resource: recurso });
  assert.equal(tok.status, 200, JSON.stringify(tok.body));
  return { access_token: tok.body.access_token, sub: prep.address, invited_by: ok.invited_by };
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-embudo-'));
  casa = await new Estafeta({
    domain: H, port: P, dataDir: path.join(tmp, H), adminToken: 't', hosts, workerIntervalMs: 100,
    publicUrl: URL_CASA, policy: { registration: 'open', registrations_per_minute: 200 },
    libro: { welcome: 1000, feeBps: 0 }, log: () => {},
    remoto: { enabled: true, vaultKey: randomBytes(32).toString('base64') },
  }).start();
  nico = Agent.create(`nico@${H}`, URL_CASA, { hosts });
  basti = Agent.create(`basti@${H}`, URL_CASA, { hosts });
  pauli = Agent.create(`pauli@${H}`, URL_CASA, { hosts });
});
after(async () => { await casa.stop(); });

test('semana ISO: los bordes de año que se equivocan a mano', () => {
  assert.equal(semanaIso('2026-01-01T00:00:00Z'), '2026-W01', 'el jueves 1-ene-2026 abre la semana 1');
  assert.equal(semanaIso('2024-12-30T12:00:00Z'), '2025-W01', 'el lunes 30-dic-2024 ya es la semana 1 de 2025');
  assert.equal(semanaIso('2021-01-03T23:59:59Z'), '2020-W53', 'el domingo 3-ene-2021 cierra la semana 53 de 2020');
  assert.equal(semanaIso('no es fecha'), null);
});

test('etapa 1: abrir el enlace de invitación deja open_invite con código y fuente; un código ajeno no deja nada', async () => {
  await nico.register({ source: 'seed' });
  inv = await nico._call('POST', '/contact-invites', { name: 'basti', source: 'whatsapp' });
  const code = inv.link.split('/i/')[1];
  assert.equal((await fetch(inv.link)).status, 200);
  let e = (await eventos('open_invite')).at(-1);
  assert.equal(e.actor, nico.address, 'el actor es quien invitó: el invitado aún no existe');
  assert.deepEqual(e.data, { code, source: 'whatsapp' }, 'la fuente por defecto es la declarada al crear el enlace');
  // El enlace se puede reenviar por otro canal: `?source=` lo precisa. Y se sanea igual que en el join.
  assert.equal((await fetch(`${inv.link}?source=tele gram<b>`)).status, 200);
  e = (await eventos('open_invite')).at(-1);
  assert.equal(e.data.source, 'telegramb');
  const antes = (await eventos('open_invite')).length;
  assert.equal((await fetch(`${URL_CASA}/i/noexiste0000000000000000`)).status, 404);
  assert.equal((await eventos('open_invite')).length, antes, 'un enlace que no existe no cuenta como abierto');
});

test('etapa 3: el conector OAuth deja claude_connected con quién invitó y el código del enlace', async () => {
  await basti.register({});                       // como la app: sin `source`; la fuente vendrá del enlace
  const c = await conectar(basti, inv.connector_url);
  assert.equal(c.invited_by, nico.address);
  const e = (await eventos('claude_connected')).at(-1);
  assert.equal(e.actor, basti.address);
  assert.deepEqual(e.data, { invited_by: nico.address, code: inv.link.split('/i/')[1] });
  basti._claude = c;
  // Sin invitación: null y null, no un campo ausente.
  await pauli.register({ source: 'registro-mcp' });
  pauli._claude = await conectar(pauli, `${URL_CASA}/mcp`);
  assert.deepEqual((await eventos('claude_connected')).at(-1).data, { invited_by: null, code: null });
});

test('etapa 4: first_message es UNA vez por raíz, no cuenta el auto-envío ni libro@, y el Claude conectado cuenta por su dueño', async () => {
  assert.equal((await eventos('first_message')).length, 0);
  // Auto-envío (memoria entre sesiones): no es escribirle a nadie.
  await basti.send({ to: basti.address, body: 'nota para mí', encrypt: false });
  assert.equal((await eventos('first_message')).length, 0, 'el auto-envío no es un primer mensaje');
  // La cotización a otra dirección sí lo es (y de paso arranca el contrato).
  await basti.quote({ to: nico.address, contract: 'escrow', price: 100, concept: 'trabajo' });
  let fm = await eventos('first_message');
  assert.equal(fm.length, 1);
  assert.equal(fm[0].actor, basti.address);
  assert.deepEqual(fm[0].data, { via: 'root' });
  // Nico acepta: el sobre va a libro@ y NO es su primer mensaje.
  const sobre = await nico.waitFor((x) => x.from === basti.address && x.type === 'message', { timeoutMs: 5000 });
  const aceptada = await nico.accept((await nico.open(sobre.envelope)).content.body);
  await nico.awaitReceipt(aceptada.id);
  assert.equal((await eventos('first_message')).length, 1, 'una op a libro@ no es escribirle a alguien');
  // Un delegado que NO es su Claude (un asistente) tampoco escribe por él.
  const sigo = await nico.delegate('sigo', { scope: { messages_only: true } });
  await sigo.send({ to: basti.address, body: 'respuesta automática', encrypt: false });
  assert.equal((await eventos('first_message')).length, 1, 'un asistente no es el humano escribiendo');
  // Nico escribe él mismo: ahora sí.
  await nico.send({ to: basti.address, body: 'hola', encrypt: false });
  assert.equal((await eventos('first_message')).length, 2);
  assert.equal((await eventos('first_message')).at(-1).actor, nico.address);
  // Pauli escribe por su Claude conectado (MCP remoto): el actor es la raíz, la vía es `claude`.
  await herramienta(pauli._claude.access_token, 'nyx5_send', { to: nico.address, body: 'hola desde el teléfono' }, `${URL_CASA}/mcp`);
  fm = await eventos('first_message');
  assert.equal(fm.length, 3);
  assert.equal(fm.at(-1).actor, pauli.address);
  assert.deepEqual(fm.at(-1).data, { via: 'claude' });
  // Diez más de Basti (raíz y Claude): sigue siendo uno.
  for (let i = 0; i < 9; i++) await basti.send({ to: nico.address, body: `mensaje ${i}`, encrypt: false });
  await herramienta(basti._claude.access_token, 'nyx5_send', { to: nico.address, body: 'y uno por el conector' }, inv.connector_url);
  assert.equal((await eventos('first_message')).length, 3, 'first_message no se repite por raíz');
  // Y una instancia nueva sobre el MISMO almacén tampoco lo repite: la memoria es el kv, no el proceso.
  assert.equal(casa._primeros.has(basti.address), true);
  casa._primeros.clear();
  await basti.send({ to: nico.address, body: 'tras reiniciar', encrypt: false });
  assert.equal((await eventos('first_message')).length, 3, 'el kv recuerda aunque el proceso no');
});

test('etapas 5 y 6 y el informe: el recorrido completo de Basti, con la fuente del enlace', async () => {
  assert.equal((await eventos('first_quote')).at(-1).data.seller, basti.address);
  const m = await basti.mandate(H, { grantee: nico.address, cap: 50 });
  await basti.awaitReceipt(m.id);
  assert.equal((await eventos('mandate_created')).at(-1).actor, basti.address);

  assert.equal((await fetch(`${URL_CASA}/informe`)).status, 401, 'el embudo nombra direcciones: sólo la casa');
  assert.equal((await fetch(`${URL_CASA}/informe.json`)).status, 401);
  const { status, body } = await informe();
  assert.equal(status, 200);
  const e = body.embudo;
  assert.deepEqual(e.etapas, ETAPAS.map((x) => x.label));
  const deBasti = e.recorridos.find((r) => r.address === basti.address);
  assert.ok(deBasti, 'Basti aparece en los recorridos');
  assert.equal(deBasti.source, 'whatsapp', 'su join no declaró fuente: la trae el enlace que abrió');
  for (const x of ETAPAS) assert.match(deBasti.etapas[x.id] || '', /^\d{4}-\d{2}-\d{2}T/, `Basti alcanzó ${x.id}`);
  // Las fechas van en orden: el enlace se abrió antes de conectar, y el mensaje antes del mandato.
  assert.ok(deBasti.etapas.open_invite <= deBasti.etapas.claude_connected);
  assert.ok(deBasti.etapas.first_message <= deBasti.etapas.mandate_created);
  // Por fuente: aperturas por SU fuente; el resto por la fuente del recorrido.
  const fila = (f) => e.porFuente.find((x) => x.fuente === f)?.conteos;
  assert.deepEqual(fila('whatsapp'), [1, 1, 1, 1, 1, 1]);
  assert.deepEqual(fila('telegramb'), [1, 0, 0, 0, 0, 0], 'la segunda apertura fue por otro canal y no trae a nadie');
  assert.deepEqual(fila('seed'), [0, 1, 0, 1, 1, 0], 'Nico: sin Claude, sin mandato propio, comprador del contrato');
  assert.deepEqual(fila('registro-mcp'), [0, 1, 1, 1, 0, 0]);
  // Por semana: las últimas 8, la actual al final, y todo lo de hoy cae en ella.
  assert.equal(e.porSemana.length, 8);
  assert.equal(e.porSemana.at(-1).semana, semanaIso(new Date()));
  assert.deepEqual(e.porSemana.at(-1).conteos, [2, 3, 2, 3, 2, 1]);
  assert.deepEqual(e.porSemana[0].conteos, [0, 0, 0, 0, 0, 0]);
  // El denominador viaja con el resultado.
  assert.ok(e.eventosLeidos > 10 && e.tope === 5000 && e.truncado === false);
});

test('el informe HTML: privado, sin JS, con las direcciones escapadas; /report sigue sin nombrar a nadie', async () => {
  const html = await fetch(`${URL_CASA}/informe`, { headers: { authorization: 'Bearer t' } }).then((r) => r.text());
  assert.match(html, /<h2>Funnel<\/h2>/);
  assert.ok(html.includes(`basti@${H}`), 'el recorrido de Basti está en la página');
  assert.ok(!/<script/i.test(html), 'sin JavaScript');
  assert.ok(html.includes('names addresses'), 'el pie dice que es privada');
  const publico = await fetch(`${URL_CASA}/report`).then((r) => r.text());
  assert.ok(!publico.includes('basti@') && !publico.includes('Funnel'), 'el informe público no lleva el embudo');
});

test('recorridos incompletos: etapas faltantes se muestran vacías, el alias viejo cuenta, y lo no atribuible se declara', async () => {
  // Una dirección que sólo se registró (como los join de producción anteriores a NX-801).
  const solo = Agent.create(`solo@${H}`, URL_CASA, { hosts });
  await solo.register({ source: 'npm' });
  // El evento que existía antes de NX-801 en el mismo punto del OAuth: cuenta como etapa 3.
  await casa._evento('connector_authorized', solo.address, { client: 'Claude', open: true });
  // Un contrato cuyo comprador no es de esta casa ni delegado de nadie conocido.
  await casa._evento('first_quote', `fantasma@otra.test`, { contract: 'x', kind: 'spot', amount: 1, seller: `ayudante.solo@${H}` });
  const { status, body } = await informe();
  assert.equal(status, 200, 'un diario con huecos no tumba el informe');
  const r = body.embudo.recorridos.find((x) => x.address === solo.address);
  assert.equal(r.source, 'npm');
  assert.ok(r.etapas.join && r.etapas.claude_connected, 'join y el alias viejo de Claude conectado');
  assert.equal(r.etapas.open_invite, null);
  assert.equal(r.etapas.first_message, null);
  assert.ok(r.etapas.first_quote, 'el delegado ayudante.solo se atribuye a su raíz');
  assert.equal(r.etapas.mandate_created, null);
  assert.deepEqual(body.embudo.sinRaiz, { first_quote: 1 }, 'el comprador fantasma queda contado, no atribuido');
  // Defensa en profundidad: si algún día una fuente llega sin sanear al diario, la página la escapa
  // en las DOS rutas donde se imprime: como fila de «By source» y como celda de «Journeys».
  // (Una primera versión de esta prueba sólo cubría la fila y dejó pasar la celda sin escape.)
  await casa._evento('join', `malo@${H}`, { via: 'open', listed: false, source: '<img src=x onerror=alert(1)>' });
  const html = await fetch(`${URL_CASA}/informe`, { headers: { authorization: 'Bearer t' } }).then((x) => x.text());
  assert.match(html, /Not attributed to any known root address: first_quote 1/);
  assert.ok(!html.includes('<img'), 'una fuente con HTML no llega viva a la página');
  assert.equal((html.match(/&lt;img src=x onerror=alert\(1\)&gt;/g) || []).length, 3, 'escapada en «Where they came from», en la fila por fuente Y en la celda del recorrido');
  // Con el diario apagado, el embudo se sirve vacío en vez de romperse.
  const sinEventos = { store: { listEvents: async () => [] } };
  const { datosEmbudo } = await import('../src/libro/informe.js');
  const vacio = await datosEmbudo(sinEventos);
  assert.deepEqual(vacio.recorridos, []);
  assert.deepEqual(vacio.porFuente, []);
  assert.equal(vacio.porSemana.length, 8);
});
