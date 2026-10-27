// node --test test/
// EJECUTORES (NX-412, 27-oct-2026): la otra mitad de «agentes vivos». Un cerebro en la casa piensa
// y tiene cinco manos que no tocan un disco; un rol de la fábrica de Rosetta lee un repositorio y
// escribe archivos, y eso no cabe en un Worker. Para esos, la casa AVISA a un ejecutor de fuera
// (CI) y el ejecutor contesta firmando con la llave del rol, que vive en los secrets de su
// repositorio. Aquí no se dispara ningún CI de verdad: el `fetch` de la casa está simulado y estas
// pruebas no gastan un peso ni un minuto de Actions.
//
// Lo que se prueba, y por qué cada cosa:
//  1. El destino se DERIVA de un `repo` validado y la lista de proveedores es CERRADA: la casa
//     guarda un token con permiso de arrancar trabajo, así que una URL libre la volvería un
//     diputado confundido que manda ese token a donde le digan.
//  2. El aviso NO lleva el contenido del sobre (invariante 8), y lleva la firma de la casa DENTRO
//     del payload, porque un `repository_dispatch` no conserva cabeceras.
//  3. El token es de sólo escritura: ninguna lectura lo devuelve, y un error ajeno que lo repita
//     se redacta antes de guardarse.
//  4. Un despacho perdido se reintenta y, agotados los intentos, el DUEÑO se entera. El `task` que
//     estuvo seis semanas callado en el buzón de qa@ nació de un camino que fallaba sin decirlo.
//  5. La casa avisa y NO cierra el sobre: cerrarlo sería prometer que alguien lo tomó.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Estafeta } from '../src/correo/estafeta.js';
import { Agent } from '../src/correo/agente.js';
import { verifyBytes } from '../src/nucleo/crypto.js';
import {
  PROVEEDORES, TIPOS_DESPACHADOS, CUPO_DESPACHOS_DIA, INTENTOS, ESPERAS,
  validarConfig, urlDe, avisoDe, despachable, despachar, atenderEjecutores, sinSecretos,
} from '../src/correo/ci.js';
import { parsearAviso, verificarAviso, tarjetaDeCasa, recoger, responder } from '../src/puentes/ejecutor.js';

// Puerto propio de esta suite (npm test corre los archivos en paralelo). Lo cuida test/puertos.test.js.
const P = 4841;
const H = 'ci.test';
const URL_CASA = `http://127.0.0.1:${P}`;
const hosts = { [H]: { url: URL_CASA } };
const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'ghp_unTokenDePruebaQueNoExiste0000';
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

let tmp, casa, duena, extrano, rol;
let disparos = [];          // lo que la casa mandó a api.github.com
let respuesta = { status: 204, body: '' };   // lo que CI contesta

// El fetch de la casa: intercepta sólo el host del proveedor y deja pasar el resto (la casa lo usa
// para entregar entre casas). Así se ve EXACTAMENTE lo que viajaría al CI real.
const fetchFalso = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith('https://api.github.com/')) {
    const headers = {};
    new Headers(init.headers || {}).forEach((v, k) => { headers[k] = v; });
    disparos.push({ url: u, method: init.method, headers, body: JSON.parse(init.body) });
    const cuerpo = respuesta.status === 204 || respuesta.status === 304 ? null : respuesta.body;
    return new Response(cuerpo, { status: respuesta.status, headers: { 'content-type': 'application/json' } });
  }
  return globalThis.fetch(url, init);
};
const admin = (metodo, ruta, body) => fetch(`${URL_CASA}${ruta}`, {
  method: metodo, headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const hastaDisparo = async (n = 1, ms = 4000) => {
  const limite = Date.now() + ms;
  while (disparos.length < n && Date.now() < limite) await espera(25);
  return disparos.length >= n;
};

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-ci-'));
  casa = await new Estafeta({
    domain: H, port: P, dataDir: path.join(tmp, H), adminToken: 't', hosts, workerIntervalMs: 100,
    libro: { welcome: 0, feeBps: 0 }, log: () => {}, fetchImpl: fetchFalso,
    remoto: { enabled: true, vaultKey: randomBytes(32).toString('base64') },
  }).start();
  duena = Agent.create(`duena@${H}`, URL_CASA, { hosts });
  extrano = Agent.create(`extrano@${H}`, URL_CASA, { hosts });
  // El rol que EJECUTA: existe, tiene su propia llave y su buzón filtra por lista.
  rol = Agent.create(`carta.rosetta@${H}`, URL_CASA, { hosts });
  for (const a of [duena, extrano]) await a.register({ adminToken: 't' });
  await rol.register({ adminToken: 't', inbox: { policy: 'allowlist', allowlist: [duena.address, `carta.rosetta@${H}`] } });
});
after(async () => { await casa?.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

// ---------- piedra angular: la lista cerrada y el destino derivado ----------

test('la lista de proveedores y la de tipos despachados son exactamente las acordadas', () => {
  assert.deepEqual(Object.keys(PROVEEDORES), ['github'], 'agregar un proveedor es una decisión: se le da a la casa un host al que puede mandar un token');
  assert.deepEqual([...TIPOS_DESPACHADOS], ['message', 'task', 'result']);
  assert.equal(INTENTOS, 3);
  assert.equal(ESPERAS.length, INTENTOS);
  assert.ok(ESPERAS.every((e, i) => i === 0 || e > ESPERAS[i - 1]), 'la espera tiene que crecer: un CI caído no se golpea cada minuto');
});

test('la URL se DERIVA del repo y nunca se recibe: ni una URL, ni un host, ni un traversal entran', () => {
  const base = { provider: 'github', repo: 'Nicoiakl/rosetta', owner: `duena@${H}`, token: TOKEN };
  assert.equal(urlDe(validarConfig(base)), 'https://api.github.com/repos/Nicoiakl/rosetta/dispatches');
  // Lo que NO se acepta, cada uno por su razón:
  const malos = {
    'un proveedor inventado': { ...base, provider: 'jenkins' },
    'un proveedor por prototipo': { ...base, provider: 'constructor' },
    'una URL en el repo': { ...base, repo: 'https://evil.example/x' },
    'un traversal': { ...base, repo: 'a/../../../user/repos' },
    'dos puntos seguidos': { ...base, repo: 'a../b' },
    'una barra extra': { ...base, repo: 'a/b/c' },
    'un repo vacío': { ...base, repo: '' },
    'una barra codificada': { ...base, repo: 'a%2f..%2fb' },
    'un arroba y un host': { ...base, repo: 'a@evil.example/b' },
    'un campo que nadie lee': { ...base, url: 'https://evil.example' },
    'un evento con mayúsculas y espacios': { ...base, event_type: 'Mi Evento' },
    'sin dueño a quien avisar': { provider: 'github', repo: 'a/b', token: TOKEN },
    'sin token': { provider: 'github', repo: 'a/b', owner: `duena@${H}` },
    'un cupo de cero': { ...base, cupo_dia: 0 },
    'un cupo que no es entero': { ...base, cupo_dia: 2.5 },
  };
  for (const [nombre, b] of Object.entries(malos)) {
    const v = validarConfig(b);
    assert.ok(v.error, `pasó lo que no debía: ${nombre}`);
    assert.ok(!v.error.includes(TOKEN), `el error cita el token: ${nombre}`);
  }
  // Y un campo ajeno se NOMBRA, no se ignora: esto es autoridad de gasto, no un mensaje (§7).
  assert.match(validarConfig({ ...base, url: 'x' }).error, /url/);
});

test('la fuente no tiene otra salida a la red que la tabla de proveedores, y grita ante seis mutantes', () => {
  const fuente = fs.readFileSync(path.join(raiz, 'src/correo/ci.js'), 'utf8');
  // Lista CERRADA de lo permitido (el modelo de ideas.js y acciones.js): con una lista de
  // prohibidos, cualquier forma nueva de salir a la red pasaría callada.
  const salidas = (src) => {
    const malas = [];
    // Toda llamada a fetch tiene que ser `est.fetch(urlDe(conf)`: una sola, y con la URL derivada.
    for (const m of src.matchAll(/(?:^|[^.\w])fetch\s*\(/g)) malas.push(`fetch suelto en ${m.index}`);
    for (const m of src.matchAll(/\.fetch\s*\(\s*/g)) {
      const resto = src.slice(m.index + m[0].length, m.index + m[0].length + 11);
      if (resto !== 'urlDe(conf)') malas.push(`fetch con destino no derivado: ${resto}`);
    }
    // Ninguna URL literal fuera de la tabla del proveedor.
    for (const m of src.matchAll(/https?:\/\/[^\s'"`)]+/g)) {
      if (!m[0].startsWith('https://api.github.com/repos/${cfg.repo}')) malas.push(`URL literal: ${m[0]}`);
    }
    // Y la URL del proveedor jamás se toma de la configuración.
    if (/\b(?:cfg|conf|b)\.(?:url|endpoint|host|origin)\b/.test(src)) malas.push('la URL sale de la configuración');
    return malas;
  };
  assert.deepEqual(salidas(fuente), []);
  const mutantes = {
    'un fetch a donde diga la configuración': fuente.replace('est.fetch(urlDe(conf)', 'est.fetch(conf.url || urlDe(conf)'),
    'un fetch suelto': `${fuente}\nexport async function avisar(u) { return fetch(u); }\n`,
    'un proveedor con URL propia': fuente.replace("url: (cfg) => `https://api.github.com", "url: (cfg) => cfg.url || `https://api.github.com"),
    'un webhook literal a otro host': `${fuente}\nconst OTRO = 'https://hooks.example/x';\n`,
    'el repo con barras libres': fuente.replace("const REPO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/", 'const REPO = /^.+$/'),
    'el host del proveedor desde la config': fuente.replace('est.fetch(urlDe(conf)', 'est.fetch(`https://${conf.host}/x`'),
  };
  for (const [nombre, m] of Object.entries(mutantes)) assert.notEqual(m, fuente, `el mutante no mutó: ${nombre}`);
  // El del repo abierto no lo caza la inspección de salidas, lo caza la validación: se comprueba aparte.
  for (const [nombre, m] of Object.entries(mutantes)) {
    if (nombre === 'el repo con barras libres') continue;
    assert.ok(salidas(m).length > 0, `la inspección no vio: ${nombre}`);
  }
  assert.ok(validarConfig({ provider: 'github', repo: 'https://evil.example/x', owner: `d@${H}`, token: TOKEN }).error, 'el repo abierto tiene que seguir rechazándose');
});

// ---------- el aviso: qué viaja y qué NO ----------

test('el aviso lleva nueve campos, la firma de la casa, y NUNCA el contenido del sobre', () => {
  const env = {
    id: 'sobre-1', from: `duena@${H}`, to: [`carta.rosetta@${H}`], type: 'task', created: '2026-10-27T15:00:00.000Z',
    content: { media: 'application/nyx5.cifrado+json', body: { ct: 'ESTO-ES-EL-SECRETO', iv: 'x' } },
    extensions: { 'urn:nyx5:ext:proyecto': { project: 'fabrica' } },
  };
  const aviso = avisoDe(casa, 'carta.rosetta', env);
  assert.deepEqual(Object.keys(aviso).sort(), ['at', 'envelope', 'from', 'house', 'nyx5', 'project', 'sig', 'to', 'type']);
  assert.ok(Object.keys(aviso).length <= 10, 'client_payload de GitHub admite diez propiedades de primer nivel');
  const texto = JSON.stringify(aviso);
  assert.ok(!texto.includes('ESTO-ES-EL-SECRETO'), 'el contenido del sobre no viaja al registro de un tercero');
  assert.ok(!texto.includes('nyx5.cifrado'), 'ni el medio del contenido');
  assert.equal(aviso.project, 'fabrica');
  // La firma es lo que deja al workflow comprobar que el disparo salió de ESTA casa.
  assert.ok(verifyBytes(`ci:sobre-1:carta.rosetta@${H}`, aviso.sig, casa.keys.sig), 'el workflow tiene que poder verificar el disparo');
  assert.ok(!verifyBytes(`ci:otro-sobre:carta.rosetta@${H}`, aviso.sig, casa.keys.sig), 'la firma amarra el id del sobre');
  assert.ok(!verifyBytes(`ci:sobre-1:otro@${H}`, aviso.sig, casa.keys.sig), 'y amarra el destinatario');
});

test('un token que vuelva en un error ajeno se redacta antes de guardarse o registrarse', () => {
  assert.equal(sinSecretos(`401 bad credentials for ${TOKEN}`), '401 bad credentials for [token]');
  assert.equal(sinSecretos('github_pat_11AAAAAAA0bbbbbbbbb'), '[token]');
  assert.equal(sinSecretos('authorization: Bearer abc.def'), 'authorization: Bearer [token]');
  assert.ok(sinSecretos('x'.repeat(5000)).length <= 300, 'un cuerpo de error ajeno no crece sin tope en la base');
});

// ---------- el alta: el token es de sólo escritura, y un sobre lo contesta UNO ----------

test('el alta deja el ejecutor APAGADO y ninguna lectura devuelve el token', async () => {
  const r = await admin('POST', '/admin/executors', {
    local: 'carta.rosetta', provider: 'github', repo: 'Nicoiakl/rosetta', event_type: 'nyx5',
    owner: duena.address, token: TOKEN, cupo_dia: 50,
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.enabled, false, 'nace apagado, como un cerebro adoptado');
  assert.equal(r.body.url, 'https://api.github.com/repos/Nicoiakl/rosetta/dispatches');
  assert.equal(r.body.token, '…0000', 'se muestra el largo o los últimos cuatro, nunca el valor');
  for (const ruta of ['/admin/executors', '/admin/executors/carta.rosetta']) {
    const g = await admin('GET', ruta);
    assert.equal(g.status, 200);
    assert.ok(!JSON.stringify(g.body).includes(TOKEN), `${ruta} devuelve el token`);
  }
  // Y tampoco está en claro en el almacén: el sello de la bóveda es lo único que hay.
  const guardado = JSON.stringify(await casa.store.kvGet('ci', 'carta.rosetta'));
  assert.ok(!guardado.includes(TOKEN), 'el token quedó en claro en la configuración');
  const sello = await casa.store.kvGet('boveda', 'ci:carta.rosetta');
  assert.ok(sello.sellado.startsWith('v1.') && !sello.sellado.includes(TOKEN), 'el token tiene que ir cifrado en reposo');
  // La AAD amarra el sello a su dirección: una fila copiada bajo otro nombre no abre.
  assert.throws(() => casa.boveda.abrir(sello.sellado, 'ci:otra'), /unreadable|unable|Unsupported/i);
  assert.equal(casa.boveda.abrir(sello.sellado, 'ci:carta.rosetta').token, TOKEN);
});

test('un sobre lo contesta UNO: cerebro en la casa o ejecutor en CI, y el 409 va en los dos sentidos', async () => {
  const dup = await admin('POST', '/admin/executors', { local: 'carta.rosetta', provider: 'github', repo: 'a/b', owner: duena.address, token: TOKEN });
  assert.equal(dup.status, 409);
  const cerebro = await admin('POST', '/admin/assistants', { local: 'carta.rosetta', adopt: true });
  assert.equal(cerebro.status, 409, 'darle cerebro a una dirección que ya ejecuta la haría contestar dos veces');
  assert.match(cerebro.body.reason, /executor/);
  // Y al revés: sobre una dirección con cerebro no se monta un ejecutor.
  await casa.store.kvPut('asistente', 'extrano', { local: 'extrano', enabled: false });
  const alReves = await admin('POST', '/admin/executors', { local: 'extrano', provider: 'github', repo: 'a/b', owner: duena.address, token: TOKEN });
  assert.equal(alReves.status, 409);
  assert.match(alReves.body.reason, /brain/);
  await casa.store.kvDelete('asistente', 'extrano');
  // Una dirección que no existe no se puede volver ejecutor, y da lo mismo que una inexistente.
  const no = await admin('POST', '/admin/executors', { local: 'nadie', provider: 'github', repo: 'a/b', owner: duena.address, token: TOKEN });
  assert.equal(no.status, 404);
});

// ---------- el camino completo: un encargo llega y el CI se dispara ----------

test('con el ejecutor encendido, un encargo que llega dispara el CI con el cuerpo que el proveedor pide', async () => {
  disparos = []; respuesta = { status: 204, body: '' };
  assert.equal((await admin('PUT', '/admin/executors/carta.rosetta', { enabled: true })).status, 200);
  const env = await duena.send({ to: rol.address, body: 'desplegá la ruta /og/<id>.png', type: 'task', project: 'fabrica' });
  assert.ok(await hastaDisparo(1), 'el encargo no disparó el CI');
  assert.equal(disparos.length, 1);
  const d = disparos[0];
  assert.equal(d.url, 'https://api.github.com/repos/Nicoiakl/rosetta/dispatches');
  assert.equal(d.method, 'POST');
  assert.equal(d.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(d.headers.accept, 'application/vnd.github+json');
  assert.equal(d.body.event_type, 'nyx5');
  assert.equal(d.body.client_payload.envelope, env.id);
  assert.equal(d.body.client_payload.to, rol.address);
  assert.equal(d.body.client_payload.type, 'task');
  assert.equal(d.body.client_payload.project, 'fabrica');
  assert.ok(verifyBytes(`ci:${env.id}:${rol.address}`, d.body.client_payload.sig, casa.keys.sig));
  assert.ok(!JSON.stringify(d.body).includes('desplegá'), 'el texto del encargo no viaja a GitHub');
  // La casa avisa y NO cierra el sobre: el ejecutor lo confirma cuando ya contestó.
  assert.equal((await casa.store.listMail('carta.rosetta')).length, 1, 'cerrarlo sería prometer que alguien lo tomó');
  const estado = await admin('GET', '/admin/executors/carta.rosetta');
  assert.equal(estado.body.pending, 1);
  assert.deepEqual(estado.body.dispatchable.map((x) => [x.envelope, x.state, x.attempts]), [[env.id, 'ok', 1]]);
  assert.equal(estado.body.used_today, 1);
});

test('reentregar el mismo sobre no vuelve a arrancar el job (invariante 4), y el reloj tampoco', async () => {
  const antes = disparos.length;
  const [m] = await casa.store.listMail('carta.rosetta');
  // La reentrega: el mismo camino que usa la casa cuando un sobre vuelve a pasar por el buzón.
  await casa._ci('carta.rosetta', m.envelope);
  await casa.flushPushes();
  await atenderEjecutores(casa);
  assert.equal(disparos.length, antes, 'un sobre ya despachado volvió a arrancar CI: eso se paga dos veces');
});

test('lo que NO despierta a un ejecutor, y cada caso por su razón', async () => {
  const rec = await casa.store.getAgent('carta.rosetta');
  const base = { id: 'x', from: duena.address, to: [rol.address], type: 'task', signature: { sig: 'x' } };
  const casos = {
    'un recibo del Libro': { env: { ...base, from: `libro@${H}`, type: 'receipt' } },
    'un rebote del postmaster': { env: { ...base, from: `postmaster@${H}`, type: 'message' } },
    'correo sin firma (entró por el puente)': { env: { ...base, signature: undefined }, from_verified: false },
    'un sobre que llegó por un grupo': { env: { ...base, to: [`g.fabrica@${H}`] } },
    'un tipo que no es un encargo': { env: { ...base, type: 'quote' } },
    'un remitente que la lista del buzón NO eligió': { env: { ...base, from: extrano.address } },
  };
  for (const [nombre, m] of Object.entries(casos)) {
    assert.equal(despachable(casa, 'carta.rosetta', rec, m), false, `despertó al ejecutor: ${nombre}`);
  }
  // Y lo que SÍ: el encargo de alguien de la lista, y el recordatorio que el rol se deja a sí mismo.
  assert.equal(despachable(casa, 'carta.rosetta', rec, { envelope: base, from_verified: true }), true);
  assert.equal(despachable(casa, 'carta.rosetta', rec, { envelope: { ...base, from: rol.address }, from_verified: true }), true);
});

// ---------- el freno de plata y la carrera ----------

test('el cupo del día es el freno: pasado el tope no se arranca un job más, y se dice por qué', async () => {
  disparos = [];
  const dia = new Date().toISOString().slice(0, 10);
  await admin('PUT', '/admin/executors/carta.rosetta', { cupo_dia: 4 });
  await casa.store.kvPut('ci-cupo', `carta.rosetta:${dia}`, 4);   // el cupo del día, ya gastado
  const env = { id: `cupo-${Date.now()}`, from: duena.address, to: [rol.address], type: 'task', created: new Date().toISOString(), signature: { sig: 'x' } };
  const r = await despachar(casa, 'carta.rosetta', env);
  assert.equal(r.ok, false);
  assert.equal(r.skipped, 'quota');
  assert.match(r.reason, /daily dispatch quota \(4\)/);
  assert.equal(disparos.length, 0, 'se gastó plata por encima del cupo');
  await casa.store.kvPut('ci-cupo', `carta.rosetta:${dia}`, 0);
  await admin('PUT', '/admin/executors/carta.rosetta', { cupo_dia: 50 });
});

test('dos relojes que ven el mismo sobre pendiente arrancan UN job, no dos', async () => {
  disparos = [];
  const env = { id: `carrera-${Date.now()}`, from: duena.address, to: [rol.address], type: 'task', created: new Date().toISOString(), signature: { sig: 'x' } };
  // La carrera no se ve corriendo el reloj dos veces en Node (el servidor local serializa): se
  // golpea el método, dos despachos concurrentes sobre el mismo almacén.
  const [a, b] = await Promise.all([
    despachar(casa, 'carta.rosetta', env),
    despachar(casa, 'carta.rosetta', env),
  ]);
  assert.equal(disparos.length, 1, 'dos isolates del edge arrancaron dos jobs con un solo sobre');
  assert.equal([a, b].filter((x) => x.ok).length, 1);
  assert.equal([a, b].filter((x) => x.skipped).length, 1);
});

// ---------- lo que falla, falla FUERTE ----------

test('un CI que rechaza se reintenta con espera creciente y no se golpea cada minuto', async () => {
  disparos = [];
  respuesta = { status: 401, body: JSON.stringify({ message: `Bad credentials for ${TOKEN}` }) };
  const id = `falla-${Date.now()}`;
  const env = { id, from: duena.address, to: [rol.address], type: 'task', created: new Date().toISOString(), signature: { sig: 'x' } };
  const r1 = await despachar(casa, 'carta.rosetta', env);
  assert.equal(r1.ok, false);
  assert.equal(r1.status, 401);
  assert.ok(!r1.reason.includes(TOKEN), 'la razón del rechazo repitió el token');
  assert.match(r1.reason, /\[token\]/);
  const guardado = await casa.store.kvGet('ci-despacho', `carta.rosetta:${id}`);
  assert.equal(guardado.intentos, 1);
  assert.equal(guardado.estado, 'fallo');
  assert.ok(!JSON.stringify(guardado).includes(TOKEN));
  // El reloj NO reintenta antes de la primera espera.
  await atenderEjecutores(casa);
  assert.equal(disparos.length, 1, 'reintentó sin esperar: un CI caído se golpearía cada minuto');
  respuesta = { status: 204, body: '' };
});

test('agotados los intentos, el DUEÑO se entera: un sobre que nadie toma no se queda en silencio', async () => {
  disparos = [];
  await casa.store.kvPut('ci-cupo', `carta.rosetta:${new Date().toISOString().slice(0, 10)}`, 0);
  respuesta = { status: 500, body: 'boom' };
  const id = `agotado-${Date.now()}`;
  const env = { id, from: duena.address, to: [rol.address], type: 'task', created: new Date().toISOString(), signature: { sig: 'x' } };
  const desde = Date.now();
  for (let i = 0; i < INTENTOS; i++) {
    const r = await despachar(casa, 'carta.rosetta', env, { nowMs: desde + i * (ESPERAS.at(-1) + 1000) });
    assert.equal(r.ok, false);
  }
  assert.equal(disparos.length, INTENTOS);
  // Un cuarto intento ya no gasta nada.
  assert.equal((await despachar(casa, 'carta.rosetta', env)).skipped, 'attempts exhausted');
  assert.equal(disparos.length, INTENTOS);
  // Y el aviso al dueño llegó, UNA vez, nombrando el sobre, el repo y la razón.
  const bandeja = await casa.store.listMail('duena');
  const avisos = bandeja.filter((m) => m.envelope.from === `postmaster@${H}` && String(m.envelope.content?.body || '').includes(id));
  assert.equal(avisos.length, 1, 'cero avisos es el defecto del task callado; dos es un reloj duplicando');
  const texto = avisos[0].envelope.content.body;
  assert.match(texto, /never took envelope/);
  assert.match(texto, /Nicoiakl\/rosetta/);
  assert.match(texto, /still in the mailbox/);
  assert.match(texto, /POST \/admin\/executors\/carta\.rosetta\/dispatch/, 'el aviso tiene que decir cómo volver a intentarlo');
  assert.ok(!texto.includes(TOKEN), 'el aviso al dueño cita el token');
  respuesta = { status: 204, body: '' };
});

test('sin token legible en la bóveda no se dispara, y el dueño se entera en el primer intento', async () => {
  disparos = [];
  await casa.store.kvPut('ci-cupo', `carta.rosetta:${new Date().toISOString().slice(0, 10)}`, 0);
  const sello = await casa.store.kvGet('boveda', 'ci:carta.rosetta');
  await casa.store.kvDelete('boveda', 'ci:carta.rosetta');
  const id = `sin-token-${Date.now()}`;
  const env = { id, from: duena.address, to: [rol.address], type: 'task', created: new Date().toISOString(), signature: { sig: 'x' } };
  const r = await despachar(casa, 'carta.rosetta', env);
  assert.equal(r.ok, false);
  assert.match(r.reason, /no readable CI token/);
  assert.equal(disparos.length, 0, 'se intentó disparar sin token: eso sería un POST sin autorización');
  const bandeja = await casa.store.listMail('duena');
  assert.equal(bandeja.filter((m) => String(m.envelope.content?.body || '').includes(id)).length, 1);
  await casa.store.kvPut('boveda', 'ci:carta.rosetta', sello);
});

test('el reintento a mano revive lo AGOTADO, no lo que ya corrió, y no levanta el cupo del día', async () => {
  disparos = [];
  const dia = new Date().toISOString().slice(0, 10);
  await casa.store.kvPut('ci-cupo', `carta.rosetta:${dia}`, 0);
  // El único sobre pendiente es el del camino completo, y ya se despachó con éxito: el reintento a
  // mano NO lo vuelve a correr. Arrancar dos veces el mismo job es lo que se paga dos veces.
  const [m] = await casa.store.listMail('carta.rosetta');
  const yaCorrio = await admin('POST', '/admin/executors/carta.rosetta/dispatch');
  assert.equal(yaCorrio.status, 200);
  assert.deepEqual(yaCorrio.body.dispatched, []);
  assert.equal(disparos.length, 0);
  // Puesto en el estado que nombra el aviso al dueño (agotado), el reintento a mano sí lo revive.
  await casa.store.kvPut('ci-despacho', `carta.rosetta:${m.envelope.id}`, { intentos: INTENTOS, ultimo: new Date().toISOString(), estado: 'fallo', razon: '500 boom' });
  const r = await admin('POST', '/admin/executors/carta.rosetta/dispatch');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.dispatched.map((x) => [x.envelope, x.ok]), [[m.envelope.id, true]]);
  assert.equal(disparos.length, 1);
  // Y con el cupo del día gastado, el reintento a mano tampoco pasa: el freno de plata no se
  // levanta por aquí (es la diferencia entre «el CI estaba caído» y «ya gastamos lo del día»).
  await casa.store.kvPut('ci-despacho', `carta.rosetta:${m.envelope.id}`, { intentos: INTENTOS, ultimo: new Date().toISOString(), estado: 'fallo', razon: '500 boom' });
  await admin('PUT', '/admin/executors/carta.rosetta', { cupo_dia: 1 });
  await casa.store.kvPut('ci-cupo', `carta.rosetta:${dia}`, 1);
  disparos = [];
  const r2 = await admin('POST', '/admin/executors/carta.rosetta/dispatch');
  assert.equal(r2.status, 200);
  assert.match(r2.body.dispatched[0].reason, /daily dispatch quota \(1\)/);
  assert.equal(disparos.length, 0);
  await casa.store.kvPut('ci-cupo', `carta.rosetta:${dia}`, 0);
  await admin('PUT', '/admin/executors/carta.rosetta', { cupo_dia: 50 });
});

// ---------- revisión adversarial (27-oct-2026): los seis ataques, corridos en cada `npm test` ----------
// Van aquí y no en un script aparte a propósito: un script de revisión se corre una vez y una prueba
// se corre siempre. Tres de estos empezaron como hallazgos y se arreglaron.

test('A1 · una entrega a una dirección SIN ejecutor no lee su configuración: el índice se consulta primero', async () => {
  const leidas = [];
  const real = casa.store.kvGet.bind(casa.store);
  casa.store.kvGet = (ns, ...r) => { leidas.push(`${ns}:${r[0]}`); return real(ns, ...r); };
  const entregar = (n) => casa._ci('duena', { id: `sin-ejecutor-${n}`, from: extrano.address, to: [duena.address], type: 'task', signature: { sig: 'x' } });
  try {
    casa._ciIdx = null;                       // isolate recién arrancado
    await entregar(1); await casa.flushPushes();
    assert.deepEqual(leidas, ['ci:_indice'], 'en el camino caliente se consulta el índice y nada más');
    leidas.length = 0;
    await entregar(2); await casa.flushPushes();   // con el índice ya cacheado
    assert.deepEqual(leidas, [], 'con el índice en memoria, una entrega a una dirección sin ejecutor no toca la base');
  } finally { casa.store.kvGet = real; }
});

test('A3 · un ejecutor sin token legible NO gasta un despacho del cupo del día', async () => {
  const dia = new Date().toISOString().slice(0, 10);
  await casa.store.kvPut('ci-cupo', `carta.rosetta:${dia}`, 0);
  const sello = await casa.store.kvGet('boveda', 'ci:carta.rosetta');
  await casa.store.kvDelete('boveda', 'ci:carta.rosetta');
  const env = { id: `cupo-sin-token-${Date.now()}`, from: duena.address, to: [rol.address], type: 'task', created: new Date().toISOString(), signature: { sig: 'x' } };
  await despachar(casa, 'carta.rosetta', env);
  assert.equal(Number(await casa.store.kvGet('ci-cupo', `carta.rosetta:${dia}`)) || 0, 0,
    'se cobró el freno de plata por un despacho que nunca salió a la red');
  await casa.store.kvPut('boveda', 'ci:carta.rosetta', sello);
});

test('A7 · la redacción del token no depende de su FORMA: el valor exacto se borra igual', () => {
  // La redacción por forma conoce la del token de GitHub. Un proveedor nuevo traería otra, y la
  // forma dejaría pasar el secreto entero. El valor exacto sí se conoce en el momento del error.
  const raro = 'xyzzy-9c2f-NO-PARECE-UN-TOKEN';
  assert.equal(sinSecretos(`403 denied: ${raro}`), `403 denied: ${raro}`, 'por forma, un token raro no se ve');
  assert.equal(sinSecretos(`403 denied: ${raro}`, raro), '403 denied: [token]');
  assert.equal(sinSecretos(`dos veces: ${raro} y ${raro}`, raro), 'dos veces: [token] y [token]');
});

test('A10 · el id del sobre lo escribe el remitente: no desborda el estado ni se cruza entre direcciones', async () => {
  // `validateEnvelope` acota el id a [A-Za-z0-9._:-]{8,128} y los dos puntos están permitidos, así
  // que un remitente podría intentar que su clave de estado se lea como la de otra dirección.
  const idRaro = 'a:carta.rosetta:b-0000';
  const a = await casa.store.kvPutIfAbsent('ci-despacho', `carta.rosetta:${idRaro}`, { marca: 'uno' }, Date.now() + 60_000);
  const b = await casa.store.kvPutIfAbsent('ci-despacho', `otra:${idRaro}`, { marca: 'dos' }, Date.now() + 60_000);
  assert.ok(a && b, 'dos direcciones con el mismo id tienen que poder guardar su propio estado');
  assert.equal((await casa.store.kvGet('ci-despacho', `carta.rosetta:${idRaro}`)).marca, 'uno');
  assert.equal((await casa.store.kvGet('ci-despacho', `otra:${idRaro}`)).marca, 'dos');
  // Y el aviso que viaja queda acotado: el id a 128, el proyecto a 40, y nada más del remitente.
  const aviso = avisoDe(casa, 'carta.rosetta', {
    id: 'z'.repeat(128), from: duena.address, type: 'task', created: new Date().toISOString(),
    extensions: { 'urn:nyx5:ext:proyecto': { project: 'p'.repeat(200) } },
  });
  assert.ok(aviso.project.length <= 40, `el proyecto viaja sin tope: ${aviso.project.length}`);
  assert.ok(JSON.stringify(aviso).length < 1000, 'el aviso tiene que caber de sobra en un client_payload');
});

test('A11 · ni el remitente ni el aviso eligen el repo, el evento ni el proveedor', async () => {
  disparos = [];
  await casa.store.kvPut('ci-cupo', `carta.rosetta:${new Date().toISOString().slice(0, 10)}`, 0);
  // Un remitente que intenta colar su propio destino por el sobre: extensiones, contenido, tipo.
  const env = {
    id: `inyeccion-${Date.now()}`, from: duena.address, to: [rol.address], type: 'task',
    created: new Date().toISOString(), signature: { sig: 'x' },
    repo: 'atacante/repo', event_type: 'suyo', provider: 'jenkins', url: 'https://evil.example/x',
    extensions: { 'urn:nyx5:ext:ci': { repo: 'atacante/repo', url: 'https://evil.example/x' } },
  };
  const r = await despachar(casa, 'carta.rosetta', env);
  assert.equal(r.ok, true);
  assert.equal(disparos.length, 1);
  assert.equal(disparos[0].url, 'https://api.github.com/repos/Nicoiakl/rosetta/dispatches', 'el remitente movió el destino');
  assert.equal(disparos[0].body.event_type, 'nyx5');
  assert.ok(!JSON.stringify(disparos[0].body).includes('evil.example'));
  assert.ok(!JSON.stringify(disparos[0].body).includes('atacante'));
});

// ---------- el lado CI: lo que corre DENTRO del job ----------

test('el job verifica el aviso contra la tarjeta de la casa, y un aviso falso no lee el buzón', async () => {
  const tarjeta = await tarjetaDeCasa(H, { estafeta: URL_CASA });
  assert.equal(tarjeta.domain, H);
  const bueno = avisoDe(casa, 'carta.rosetta', { id: 'sobre-v', from: duena.address, type: 'task', created: new Date().toISOString() });
  assert.equal(verificarAviso(bueno, tarjeta), true);
  // Un `repository_dispatch` lo lanza cualquiera con el token del repo, y el payload lo escribe
  // quien dispara: éstos son los avisos que un atacante tiene a mano.
  const falsos = {
    'otra firma': { ...bueno, sig: avisoDe(casa, 'carta.rosetta', { id: 'otro', from: duena.address }).sig },
    'otro destinatario con la firma buena': { ...bueno, to: `otro@${H}` },
    'otro sobre con la firma buena': { ...bueno, envelope: 'sobre-cambiado' },
    'firma basura': { ...bueno, sig: 'AAAA' },
  };
  for (const [nombre, a] of Object.entries(falsos)) {
    assert.equal(verificarAviso(a, tarjeta), false, `pasó un aviso falso: ${nombre}`);
  }
  // Y el camino completo también lo rechaza, SIN leer el buzón ni gastar el runner.
  await assert.rejects(
    recoger({ aviso: { ...bueno, envelope: 'sobre-cambiado' }, keys: { ...rol.keys, address: rol.address }, estafeta: URL_CASA, hosts }),
    /not signed by/,
  );
  // Un aviso al que le falta un campo, o de otra versión, no llega ni a pedir la tarjeta.
  assert.throws(() => parsearAviso('{}'), /missing/);
  assert.throws(() => parsearAviso(JSON.stringify({ ...bueno, nyx5: '2' })), /unknown protocol version/);
  assert.throws(() => parsearAviso(JSON.stringify({ ...bueno, house: 'otra.casa' })), /but address/);
  assert.throws(() => parsearAviso('no soy json'), /not JSON/);
});

test('recorrido completo: la casa dispara, el job recoge el encargo descifrado, contesta firmado y recién ahí confirma', async () => {
  disparos = [];
  await casa.store.kvPut('ci-cupo', `carta.rosetta:${new Date().toISOString().slice(0, 10)}`, 0);
  // Se limpia el buzón del rol para que el recorrido mire un solo sobre.
  const previos = (await casa.store.listMail('carta.rosetta')).map((m) => m.envelope.id);
  if (previos.length) await casa.store.ackMail('carta.rosetta', previos[0]);
  const desde = Date.now();
  const env = await duena.send({ to: rol.address, body: 'desplegá /og/<id>.png con los tokens v1.1', type: 'task', project: 'fabrica' });
  assert.ok(await hastaDisparo(1), 'el encargo no disparó el CI');
  const aviso = disparos.at(-1).body.client_payload;

  // --- aquí empieza lo que corre dentro del job, con la llave del rol en un secret ---
  const llave = { ...rol.keys, address: rol.address };
  const r = await recoger({ aviso, keys: llave, estafeta: URL_CASA, hosts });
  assert.equal(r.envelope.id, env.id);
  assert.equal(r.encargo.body, 'desplegá /og/<id>.png con los tokens v1.1', 'el contenido lo abre la llave del rol, no la casa');
  assert.equal(r.encargo.project, 'fabrica');
  assert.equal(r.aviso.project, 'fabrica');
  // El sobre sigue pendiente mientras el job trabaja: si el runner muere, la casa lo redespacha.
  assert.equal((await casa.store.listMail('carta.rosetta')).length, 1);

  const resp = await responder({ aviso, keys: llave, texto: 'ruta desplegada; PNG 1200x630 en paper claro', estafeta: URL_CASA, hosts });
  assert.ok(resp.sent);
  assert.deepEqual(resp.acked, [env.id], 'se confirma DESPUÉS de contestar, nunca antes');
  assert.equal((await casa.store.listMail('carta.rosetta')).length, 0);

  // Y la respuesta llega a quien encargó, firmada por la dirección del rol y en el mismo hilo.
  const llego = await duena.waitFor((e) => e.from === rol.address && Date.parse(e.created) > desde, { timeoutMs: 8000 });
  assert.equal(llego.envelope.in_reply_to, env.id);
  assert.equal(llego.envelope.type, 'result');
  assert.equal((await duena.open(llego.envelope)).content.body, 'ruta desplegada; PNG 1200x630 en paper claro');
});

test('una llave que no es la del aviso no recoge nada, y una respuesta vacía no es una respuesta', async () => {
  const aviso = avisoDe(casa, 'carta.rosetta', { id: 'x', from: duena.address, type: 'task', created: new Date().toISOString() });
  await assert.rejects(recoger({ aviso, keys: { ...extrano.keys, address: extrano.address }, estafeta: URL_CASA, hosts }), /is of .*and the notice is for/);
  await assert.rejects(recoger({ aviso, keys: { sig: 'x' }, estafeta: URL_CASA, hosts }), /must carry sig, sigPriv, enc and encPriv/);
  await assert.rejects(responder({ aviso, keys: { ...rol.keys, address: rol.address }, texto: '   ', estafeta: URL_CASA, hosts }), /empty answer/);
});

test('un ejecutor apagado o quitado no dispara nada, y quitarlo se lleva el token', async () => {
  disparos = [];
  await admin('PUT', '/admin/executors/carta.rosetta', { enabled: false });
  const env = { id: `apagado-${Date.now()}`, from: duena.address, to: [rol.address], type: 'task', created: new Date().toISOString(), signature: { sig: 'x' } };
  assert.equal((await despachar(casa, 'carta.rosetta', env)).skipped, 'disabled');
  assert.equal(disparos.length, 0);
  assert.equal((await admin('DELETE', '/admin/executors/carta.rosetta')).status, 200);
  assert.equal(await casa.store.kvGet('boveda', 'ci:carta.rosetta'), null, 'el token tiene que irse con el ejecutor');
  assert.equal((await admin('GET', '/admin/executors/carta.rosetta')).status, 404);
  assert.deepEqual((await admin('GET', '/admin/executors')).body.executors, []);
  assert.equal((await despachar(casa, 'carta.rosetta', env)).skipped, 'disabled');
  assert.equal(disparos.length, 0);
});

test('las rutas del ejecutor son de la casa: sin el token de administración contestan 401 exista o no', async () => {
  const sin = (ruta, metodo = 'GET') => fetch(`${URL_CASA}${ruta}`, { method: metodo }).then(async (r) => ({ status: r.status, body: await r.text() }));
  const a = await sin('/admin/executors');
  const b = await sin('/admin/executors/carta.rosetta');
  const c = await sin('/admin/executors/no-existe-jamas');
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  assert.equal(c.status, 401);
  assert.equal(b.body, c.body, 'la respuesta tiene que ser idéntica exista o no la dirección');
});

test('el cupo por omisión y el tope de la configuración son los acordados', () => {
  assert.equal(CUPO_DESPACHOS_DIA, 20);
  const v = validarConfig({ provider: 'github', repo: 'a/b', owner: `d@${H}`, token: TOKEN });
  assert.equal(v.cupo_dia, CUPO_DESPACHOS_DIA);
  assert.ok(validarConfig({ provider: 'github', repo: 'a/b', owner: `d@${H}`, token: TOKEN, cupo_dia: 501 }).error);
});
