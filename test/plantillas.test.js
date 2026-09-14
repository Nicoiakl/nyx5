// node --test test/
// NX-803 · Plantillas para frameworks de agentes (examples/frameworks/). Lo que se comprueba aquí:
//   - la configuración MCP que generan las plantillas JS arranca el puente REAL (bin/nyx5.js mcp)
//     y responde tools/list con las mismas herramientas que declara el módulo del puente;
//   - el cliente Python (nyx5_http.py) reproduce la firma del cliente JS: JSON canónico byte a
//     byte, registro con prueba de posesión, envío, lectura y acuse contra una casa local; y un
//     cruce JS -> Python. Con mutación: una firma alterada y una ruta distinta se rechazan.
// Lo que NO se ejecuta: ninguna llamada a la API de Anthropic ni de OpenAI, ni nada contra nyx5.com.
// Sin python3 con `cryptography`, las pruebas de Python SALTAN y lo dicen.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Estafeta } from '../src/correo/estafeta.js';
import { Agent } from '../src/correo/agente.js';
import { TOOLS } from '../src/puentes/herramientas.js';
import { canonical } from '../src/nucleo/crypto.js';
import { nyx5Options } from '../examples/frameworks/claude-agent-sdk.mjs';
import { nyx5ServerConfig } from '../examples/frameworks/openai-agents.mjs';

// Puerto propio de esta suite (bloque 4731-4739 reservado a plantillas). Lo cuida test/puertos.test.js.
const P = 4731;
const DOMINIO = 'casa.local';
const URL_CASA = `http://127.0.0.1:${P}`;
const hosts = { [DOMINIO]: { url: URL_CASA } };
const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(raiz, 'bin', 'nyx5.js');
const PY = path.join(raiz, 'examples', 'frameworks', 'nyx5_http.py');
const DIR_PY = path.dirname(PY);

let tmp, casa, hostsFile;
before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-plantillas-'));
  hostsFile = path.join(tmp, 'hosts.json');
  fs.writeFileSync(hostsFile, JSON.stringify(hosts));
  casa = await new Estafeta({
    domain: DOMINIO, port: P, dataDir: path.join(tmp, DOMINIO), adminToken: 't', hosts,
    workerIntervalMs: 100, policy: { registration: 'open', registrations_per_minute: 200 }, log: () => {},
  }).start();
});
after(async () => { await casa.stop(); });

// ---------- python: ¿hay con qué? ----------
const py = spawnSync('python3', ['-c', 'import cryptography, typing_extensions; print(cryptography.__version__)'], { encoding: 'utf8' });
const hayPython = py.status === 0;
const skipPy = hayPython ? false : `python3 con cryptography no disponible: ${(py.stderr || py.error?.message || '').trim().split('\n').pop()}`;
// Asíncrono a propósito: la casa vive EN ESTE PROCESO, y un spawnSync bloquea el bucle de eventos
// mientras Python espera la respuesta de la casa. Se vio como "socket.timeout" en el registro.
const runPy = (args, { input, env } = {}) => new Promise((resolve) => {
  const proc = spawn('python3', args, { cwd: DIR_PY, env: { ...process.env, ...env } });
  let stdout = '', stderr = '';
  proc.stdout.on('data', (d) => { stdout += d; });
  proc.stderr.on('data', (d) => { stderr += d; });
  const t = setTimeout(() => proc.kill(), 30_000);
  proc.on('close', (status) => {
    clearTimeout(t);
    resolve({ status, stdout, stderr, json: () => { try { return JSON.parse(stdout); } catch { throw new Error(`python no devolvió JSON:\nstdout: ${stdout}\nstderr: ${stderr}`); } } });
  });
  if (input != null) proc.stdin.write(input);
  proc.stdin.end();
});

// ---------- el puente MCP por stdio, con la configuración que produce cada plantilla ----------
// Habla JSON-RPC por líneas con el proceso que la plantilla describe: initialize, tools/list y
// una llamada real (nyx5_whoami). Si la plantilla apuntara a un comando o a un archivo que no
// existe, esto es lo que se rompe.
async function hablarConElPuente({ command, args, env }) {
  const proc = spawn(command, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const respuestas = new Map();
  let buffer = '';
  const esperas = new Map();
  proc.stdout.on('data', (d) => {
    buffer += d;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      respuestas.set(msg.id, msg);
      esperas.get(msg.id)?.(msg);
    }
  });
  let stderr = ''; proc.stderr.on('data', (d) => { stderr += d; });
  let n = 0;
  const pedir = (method, params) => new Promise((resolve, reject) => {
    const id = ++n;
    const t = setTimeout(() => reject(new Error(`sin respuesta a ${method} en 10 s; stderr: ${stderr}`)), 10_000);
    esperas.set(id, (m) => { clearTimeout(t); resolve(m); });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const cerrar = () => new Promise((r) => { proc.on('exit', r); proc.stdin.end(); setTimeout(() => proc.kill(), 2000).unref(); });
  return { pedir, cerrar, stderr: () => stderr };
}

async function claveRegistrada(nombre) {
  const a = Agent.create(`${nombre}@${DOMINIO}`, URL_CASA, { hosts });
  await a.register();
  const file = path.join(tmp, `${nombre}.json`);
  await a.save(file);
  return { agente: a, file };
}

async function puenteRespondeConTodo(config, etiqueta) {
  const p = await hablarConElPuente(config);
  try {
    const init = await p.pedir('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    assert.equal(init.result?.serverInfo?.name, 'nyx5', `${etiqueta}: initialize no responde como el puente nyx5`);
    const list = await p.pedir('tools/list', {});
    const nombres = (list.result?.tools || []).map((t) => t.name);
    // Se compara contra el OBJETO que declara el módulo, no contra el número 24 recordado.
    assert.deepEqual(nombres, TOOLS.map((t) => t.name), `${etiqueta}: tools/list no coincide con herramientas.js`);
    assert.equal(nombres.length, TOOLS.length, `${etiqueta}: se esperaban ${TOOLS.length} herramientas, el puente lista ${nombres.length}`);
    // Y una llamada de verdad, para que "arranca" no sea sólo "imprime una lista".
    const who = await p.pedir('tools/call', { name: 'nyx5_whoami', arguments: {} });
    assert.ok(!who.result?.isError, `${etiqueta}: nyx5_whoami falló: ${JSON.stringify(who.result)}`);
    return { herramientas: nombres.length, whoami: who.result.content[0].text };
  } finally { await p.cerrar(); }
}

test('Claude Agent SDK · el bloque mcpServers de la plantilla arranca el puente y lista las mismas herramientas que el módulo', async () => {
  const { agente, file } = await claveRegistrada('sdk-claude');
  const opts = nyx5Options({ keyfile: file, command: 'node', args: [BIN], env: { NYX5_HOSTS: hostsFile } });
  assert.deepEqual(opts.allowedTools, ['mcp__nyx5__*']);
  assert.deepEqual(nyx5Options({ keyfile: file, tools: ['nyx5_send', 'nyx5_inbox'] }).allowedTools, ['mcp__nyx5__nyx5_send', 'mcp__nyx5__nyx5_inbox']);
  // El bloque por defecto es el publicado (npx); aquí se ejecuta el mismo puente desde el checkout.
  assert.deepEqual(nyx5Options({ keyfile: file }).mcpServers.nyx5.args.slice(0, 4), ['-y', '@nyx5/nyx5', 'mcp', '--agent']);
  assert.throws(() => nyx5Options({}), /keyfile is required/);
  const r = await puenteRespondeConTodo(opts.mcpServers.nyx5, 'claude-agent-sdk');
  assert.match(r.whoami, new RegExp(agente.address), 'whoami no devuelve la dirección del archivo de llaves');
  console.log(`  claude-agent-sdk: ${r.herramientas} de ${TOOLS.length} herramientas; whoami = ${agente.address}`);
});

test('OpenAI Agents SDK · la configuración de MCPServerStdio de la plantilla arranca el mismo puente', async () => {
  const { agente, file } = await claveRegistrada('sdk-openai');
  const cfg = nyx5ServerConfig({ keyfile: file, command: 'node', args: [BIN], env: { NYX5_HOSTS: hostsFile } });
  assert.equal(cfg.name, 'nyx5');
  assert.deepEqual(nyx5ServerConfig({ keyfile: file }).args.slice(0, 4), ['-y', '@nyx5/nyx5', 'mcp', '--agent']);
  assert.throws(() => nyx5ServerConfig({}), /keyfile is required/);
  const r = await puenteRespondeConTodo(cfg, 'openai-agents');
  assert.match(r.whoami, new RegExp(agente.address));
  console.log(`  openai-agents: ${r.herramientas} de ${TOOLS.length} herramientas; whoami = ${agente.address}`);
});

// ---------- python ----------
test('Python · canonical() produce los mismos bytes que el canonical() de JS, y rechaza floats', { skip: skipPy }, async () => {
  // Valores incómodos a propósito: claves desordenadas y con mayúsculas, unicode, comillas,
  // barras, saltos de línea, controles, null, booleanos, enteros grandes y negativos, vacíos.
  const obj = { z: 1, a: [3, -5, 0, 123456789012, null, true, false, '', 'ñandú 🦙 "q" \\ \n\t '], B: { y: null, x: { '1': 'uno', '_': 'guion', 'A': 'a', 'a': 'aa' } }, '': 'vacia', lista: [], mapa: {} };
  const r = await runPy(['-c', 'import sys, json; from nyx5_http import canonical; sys.stdout.write(canonical(json.loads(sys.stdin.read())))'], { input: JSON.stringify(obj) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, canonical(obj), 'el canónico de Python difiere del de JS');
  // El punto ciego declarado: un float no es portable, y Python falla CERRADO en vez de firmar algo que no verifica.
  const f = await runPy(['-c', 'from nyx5_http import canonical; print(canonical({"x": 1.0}))']);
  assert.notEqual(f.status, 0, 'un float tiene que rechazarse: JS lo escribe "1" y Python "1.0"');
  assert.match(f.stderr, /floats are not portable/);
  console.log(`  canonical: ${r.stdout.length} bytes idénticos; float rechazado`);
});

let pyKeyfile, pyAddress;
test('Python · registro con prueba de posesión, envío, lectura y acuse contra la casa local', { skip: skipPy }, async () => {
  pyKeyfile = path.join(tmp, 'py.json');
  const r = await runPy([PY, 'demo', '--house', DOMINIO, '--estafeta', URL_CASA, '--out', pyKeyfile]);
  assert.equal(r.status, 0, `demo falló:\n${r.stderr}`);
  const j = r.json();
  pyAddress = j.address;
  assert.match(pyAddress, new RegExp(`^py-[0-9a-f]{8}@${DOMINIO}$`));
  assert.equal(j.received.id, j.sent, 'lo leído no es lo enviado');
  assert.equal(j.received.content.body, 'hello from Python');
  assert.equal(j.received.encrypted, false);
  // La casa tiene la tarjeta con la llave que Python acuñó (se mira la casa, no el reporte de Python).
  const card = await (await fetch(`${URL_CASA}/agents/${pyAddress.split('@')[0]}`)).json();
  assert.equal(card.sig, JSON.parse(fs.readFileSync(pyKeyfile, 'utf8')).keys.sig);
  assert.equal(card.enc ?? null, null, 'Python no publica llave de cifrado: tiene que verse en la tarjeta');
  // Y el acuse vació el buzón.
  const inbox = (await runPy([PY, 'inbox', '--agent', pyKeyfile])).json();
  assert.equal(inbox.count, 0, `tras el ack el buzón debía quedar vacío, tiene ${inbox.count}`);
  assert.equal(fs.statSync(pyKeyfile).mode & 0o777, 0o600, 'la llave se escribe con permisos 600');
  console.log(`  python demo: ${pyAddress}, 1 enviado, 1 leído, 1 acusado`);
});

test('Python · mutación: una firma alterada y un token de otra ruta se rechazan con 401', { skip: skipPy }, async () => {
  assert.ok(pyKeyfile, 'depende de la prueba anterior');
  const local = pyAddress.split('@')[0];
  const cabecera = async (method, p) => {
    const r = await runPy(['-c', `from nyx5_http import Agent, auth_header; a = Agent.load(${JSON.stringify(pyKeyfile)}); print(auth_header(a.address, a.keys, ${JSON.stringify(method)}, ${JSON.stringify(p)}, a.estafeta))`]);
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const ruta = `/mailbox/${local}`;
  // Grita y calla: el mismo formato, intacto, entra; alterado o en otra ruta, no.
  const h = await cabecera('GET', ruta);
  const ok = await fetch(`${URL_CASA}${ruta}`, { headers: { authorization: h } });
  assert.equal(ok.status, 200, 'el header intacto tiene que entrar');
  // Se altera un carácter del MEDIO de la firma. El último no sirve: codifica 4 bits de relleno
  // que el decodificador base64url descarta, y la firma "alterada" era la misma (medido: 200).
  const [token, firma] = h.slice('Nyx5 '.length).split('.');
  const i = Math.floor(firma.length / 2);
  const alterada = `Nyx5 ${token}.${firma.slice(0, i)}${firma[i] === 'A' ? 'B' : 'A'}${firma.slice(i + 1)}`;
  const mal = await fetch(`${URL_CASA}${ruta}`, { headers: { authorization: alterada } });
  assert.equal(mal.status, 401, 'una firma con un carácter cambiado tiene que rechazarse');
  const otra = await fetch(`${URL_CASA}/outbox/${local}`, { headers: { authorization: await cabecera('GET', ruta) } });
  assert.equal(otra.status, 401, 'un token emitido para /mailbox no sirve en /outbox');
  // El mismo header que ya entró (arriba, 200) no entra dos veces: el nonce se consumió al verificar.
  const repetida = await fetch(`${URL_CASA}${ruta}`, { headers: { authorization: h } });
  assert.equal(repetida.status, 401, 'el nonce es de un solo uso');
  console.log('  mutación: intacta 200, alterada 401, otra ruta 401, nonce repetido 401');
});

test('Python · lo que escribe el cliente JS lo lee el cliente Python (cruce entre implementaciones)', { skip: skipPy }, async () => {
  assert.ok(pyAddress, 'depende de la prueba de registro');
  const js = Agent.create(`js-cruce@${DOMINIO}`, URL_CASA, { hosts });
  await js.register();
  // Python no publica llave de cifrado, así que el JS manda en claro; con encrypt 'required' se niega.
  await assert.rejects(js.send({ to: pyAddress, body: 'x', encrypt: 'required' }), /does not publish an encryption key/);
  const r = await js.send({ to: pyAddress, body: 'hello from JavaScript' });
  assert.ok(r.id && r.jobs?.length === 1, `send devolvió ${JSON.stringify(r)}`);
  assert.equal(r.encrypted, false, 'sin llave enc del lado Python, el sobre tiene que ir en claro');
  // Entrega asíncrona: se espera a que la casa la reparta antes de leer desde Python.
  const lector = new Agent({ address: pyAddress, estafeta: URL_CASA, keys: JSON.parse(fs.readFileSync(pyKeyfile, 'utf8')).keys, hosts });
  await lector.waitFor((e) => e.id === r.id);
  const inbox = (await runPy([PY, 'inbox', '--agent', pyKeyfile, '--ack'])).json();
  const m = inbox.messages.find((x) => x.id === r.id);
  assert.ok(m, `Python no ve el sobre ${r.id}: ${JSON.stringify(inbox)}`);
  assert.equal(m.from, js.address);
  assert.equal(m.content.body, 'hello from JavaScript');
  // Y al revés: Python escribe, JS abre con verificación de firma completa.
  const s = (await runPy([PY, 'send', '--agent', pyKeyfile, '--to', js.address, '--body', 'reply from Python'])).json();
  const got = await js.waitFor((e) => e.id === s.id);
  const abierto = await js.open(got.envelope);
  assert.equal(abierto.from, pyAddress);
  assert.equal(abierto.content.body, 'reply from Python');
  console.log(`  cruce: JS -> Python y Python -> JS, 1 sobre cada uno, firma verificada por JS`);
});

test('Python · las tools de CrewAI y los nodos de LangGraph funcionan sin el framework instalado', { skip: skipPy }, async () => {
  assert.ok(pyKeyfile, 'depende de la prueba de registro');
  // CrewAI: las dos funciones son Python plano; el decorador se aplica sólo si crewai está.
  const crew = await runPy(['-c', [
    'import json, crewai_nyx5 as c',
    `s = json.loads(c.nyx5_send(${JSON.stringify(pyAddress)}, "via crewai tool"))`,
    'import time; t = time.time() + 15',
    'while time.time() < t:',
    '    got = [m for m in json.loads(c.nyx5_inbox(ack=False)) if m["id"] == s["id"]]',
    '    if got: break',
    '    time.sleep(0.2)',
    'inbox = json.loads(c.nyx5_inbox())',
    'print(json.dumps({"sent": s["id"], "got": got}))',
  ].join('\n')], { env: { NYX5_AGENT: pyKeyfile } });
  assert.equal(crew.status, 0, crew.stderr);
  const cj = crew.json();
  assert.equal(cj.got.length, 1, 'la tool nyx5_inbox no vio lo que mandó nyx5_send');
  assert.equal(cj.got[0].content.body, 'via crewai tool');
  // LangGraph: si está instalado se corre el grafo compilado; si no, los tres nodos en secuencia.
  const lg = await runPy(['-c', [
    'import json, langgraph_nyx5 as g',
    'state = {"house": ' + JSON.stringify(DOMINIO) + ', "estafeta": ' + JSON.stringify(URL_CASA) + ', "body": "via langgraph node"}',
    'try:',
    '    import langgraph; out = g.build().invoke(state); modo = "graph"',
    'except ImportError:',
    '    out = dict(state); modo = "nodes"',
    '    for n in (g.join, g.send, g.read): out.update(n(out))',
    'print(json.dumps({"modo": modo, "address": out["agent"].address, "received": out["received"]}))',
  ].join('\n')]);
  assert.equal(lg.status, 0, lg.stderr);
  const lj = lg.json();
  assert.match(lj.address, new RegExp(`^lg-[0-9a-f]{8}@${DOMINIO}$`));
  assert.ok(lj.received.some((m) => m.content?.body === 'via langgraph node'), JSON.stringify(lj));
  console.log(`  crewai tools: 1 de 1 sobre; langgraph (${lj.modo}): ${lj.received.length} sobre(s) leídos`);
});

// ---------- lo público que promete este directorio ----------
// Rangos U+200B-200F, U+202A-202E, U+2060-2064 y U+FEFF, construidos por código para no tener ni escapes ni literales en la fuente.
const rango = (a, b) => String.fromCharCode(a) + '-' + String.fromCharCode(b);
const INVISIBLES = new RegExp('[' + rango(0x200B, 0x200F) + rango(0x202A, 0x202E) + rango(0x2060, 0x2064) + String.fromCharCode(0xFEFF) + ']');
test('la documentación de las plantillas sólo nombra herramientas y comandos que existen, y está en inglés', () => {
  const reales = new Set(TOOLS.map((t) => t.name));
  const cli = fs.readFileSync(BIN, 'utf8');
  const comandos = new Set([...cli.matchAll(/case '([a-z]+)':/g)].map((m) => m[1]));
  const docs = fs.readdirSync(DIR_PY).filter((f) => /\.(md|mjs|py)$/.test(f));
  assert.ok(docs.length >= 7, `se esperaban al menos 7 archivos en examples/frameworks, hay ${docs.length}`);
  for (const f of docs) {
    const t = fs.readFileSync(path.join(DIR_PY, f), 'utf8');
    for (const m of t.matchAll(/\bnyx5_[a-z0-9_]+\b/g)) {
      // nyx5_http es el archivo; el resto de nyx5_* son herramientas y tienen que existir.
      if (m[0] === 'nyx5_http') continue;
      assert.ok(reales.has(m[0]), `${f} nombra la herramienta ${m[0]}, que no existe`);
    }
    for (const m of t.matchAll(/(?:npx @nyx5\/nyx5|node bin\/nyx5\.js)\s+([a-z]+)/g)) assert.ok(comandos.has(m[1]), `${f} promete "${m[1]}" y el CLI no lo implementa`);
    assert.ok(!/[áéíóúñ¡¿]/.test(t.replace(/ñandú/g, '')), `${f} tiene texto en español: lo público va en inglés`);
    // Ningún carácter invisible literal (ancho cero, bidi): se corrompen en silencio.
    assert.ok(!INVISIBLES.test(t), `${f} contiene un carácter invisible`);
  }
  const readme = fs.readFileSync(path.join(raiz, 'README.md'), 'utf8');
  assert.match(readme, /examples\/frameworks\//, 'el README principal tiene que apuntar a examples/frameworks/');
  console.log(`  documentación: ${docs.length} archivos revisados`);
});
