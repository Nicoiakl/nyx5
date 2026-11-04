// node --test test/
// Cero fricción: qué identidad usa un comando cuando nadie la nombró, y que el primer contacto
// con Nyx5 sea UN comando y no dos. Nació el 4-nov-2026 de una frase de Nicholas: «necesitamos
// que funcione sin hacer ningún click... de partida debe ser instantáneo».
//
// La prueba de fondo es la última: una máquina SIN identidad corre `nyx5 inbox` contra una casa
// local y termina con dirección, buzón y respuesta, sin haber corrido `join` ni haber escrito una
// ruta. Si eso deja de pasar, la premisa del proyecto dejó de cumplirse.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Estafeta } from '../src/correo/estafeta.js';
import { elegirLlave, archivoDe, escribirPuntero, listarLlaves, PUNTERO } from '../src/correo/identidad.js';

const ejecutar = promisify(execFile);
const CLI = new URL('../bin/nyx5.js', import.meta.url).pathname;

// Puerto propio de esta suite (npm test corre los archivos en paralelo). Lo cuida test/puertos.test.js.
const P = 4871;
const H = 'identidad.test';
const URL_CASA = `http://127.0.0.1:${P}`;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-id-'));
const llave = (dir, nombre, address) => {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, nombre);
  fs.writeFileSync(p, JSON.stringify({ address, estafeta: URL_CASA, keys: { sig: 'x', sigPriv: 'y', enc: 'z', encPriv: 'w' } }));
  return p;
};

// ---------- la elección, sin red ----------

test('quien lo dice manda: --agent gana sobre todo lo demás', () => {
  const dir = tmp();
  llave(dir, 'otra.json', 'otra@casa');
  assert.deepEqual(elegirLlave({ flag: '/ruta/explicita.json', env: { NYX5_AGENT: '/del/entorno.json' }, dir }), { ruta: '/ruta/explicita.json' });
});

test('NYX5_AGENT sirve donde no hay home: CI, un contenedor', () => {
  const dir = tmp();
  llave(dir, 'otra.json', 'otra@casa');
  assert.deepEqual(elegirLlave({ env: { NYX5_AGENT: '/del/entorno.json' }, dir }), { ruta: '/del/entorno.json' });
});

test('una sola llave es LA identidad: ningún flag, ninguna ruta', () => {
  const dir = tmp();
  const p = llave(dir, 'aria.json', 'aria@casa');
  assert.deepEqual(elegirLlave({ env: {}, dir }), { ruta: p });
});

test('dos identidades NO se adivinan: devuelve las dos con su dirección', () => {
  const dir = tmp();
  llave(dir, 'aria.json', 'aria@casa');
  llave(dir, 'beto.json', 'beto@casa');
  const r = elegirLlave({ env: {}, dir });
  assert.ok(!r.ruta, 'adivinó una identidad habiendo dos: firmaría con la que no era');
  assert.deepEqual(r.varias.map((v) => v.address).sort(), ['aria@casa', 'beto@casa']);
});

test('con varias, el puntero de `nyx5 use` decide; uno roto no cuelga la elección', () => {
  const dir = tmp();
  llave(dir, 'aria.json', 'aria@casa');
  llave(dir, 'beto.json', 'beto@casa');
  escribirPuntero(dir, 'beto.json');
  assert.equal(elegirLlave({ env: {}, dir }).ruta, path.join(dir, 'beto.json'));
  escribirPuntero(dir, 'borrada.json');
  assert.ok(elegirLlave({ env: {}, dir }).varias, 'un puntero a una llave que ya no está tiene que volver a preguntar');
});

test('sin ninguna llave se declara `ninguna`: quien llama decide, el módulo no se une solo', () => {
  const r = elegirLlave({ env: {}, dir: tmp() });
  assert.ok(r.ninguna, 'sin llaves no hay identidad que elegir');
  assert.ok(!r.ruta);
});

test('el puntero no se confunde con una llave', () => {
  const dir = tmp();
  llave(dir, 'aria.json', 'aria@casa');
  escribirPuntero(dir, 'aria.json');
  assert.deepEqual(listarLlaves(dir), ['aria.json'], `${PUNTERO} no es una llave y no puede contarse como una`);
});

test('se elige por dirección, por local o por archivo: el agente usa el nombre que tiene a mano', () => {
  const dir = tmp();
  llave(dir, 'aria.json', 'aria@casa.local');
  llave(dir, 'beto.json', 'beto@casa.local');
  assert.equal(archivoDe(dir, 'aria@casa.local'), 'aria.json');
  assert.equal(archivoDe(dir, 'ARIA@CASA.LOCAL'), 'aria.json');
  assert.equal(archivoDe(dir, 'beto'), 'beto.json');
  assert.equal(archivoDe(dir, 'beto.json'), 'beto.json');
  assert.equal(archivoDe(dir, 'nadie'), null);
});

// ---------- el primer contacto, contra una casa de verdad ----------

let casa;
before(async () => {
  casa = new Estafeta({ domain: H, port: P, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-casa-')), adminToken: 'x', policy: { registration: 'open' }, log: () => {} });
  await casa.start();
});
after(async () => { await casa?.stop(); });

test('UN comando desde cero: sin llave, sin --agent y sin haber corrido join, el agente queda con dirección y buzón', async () => {
  const home = tmp();
  const hosts = path.join(home, 'hosts.json');
  fs.writeFileSync(hosts, JSON.stringify({ [H]: { url: URL_CASA } }));
  const env = { ...process.env, NYX5_HOME: home, NYX5_HOSTS: hosts, NYX5_HOUSE: H };

  assert.deepEqual(listarLlaves(home), [], 'la máquina parte sin ninguna identidad');

  const { stdout, stderr } = await ejecutar(process.execPath, [CLI, 'inbox'], { env });

  // Se unió solo, lo dijo por stderr (stdout queda limpio para quien lo canaliza a un archivo),
  // y dejó la llave donde el siguiente comando la va a encontrar.
  assert.match(stderr, new RegExp(`@${H}`), `no avisó de qué identidad se creó. stderr: ${stderr}`);
  assert.equal(listarLlaves(home).length, 1, 'tenía que quedar exactamente una llave nueva');
  assert.match(stdout, /mailbox empty|"id"/, `el comando no llegó a correr. stdout: ${stdout}`);
});

test('el segundo comando reusa la misma identidad: no se une dos veces', async () => {
  const home = tmp();
  const hosts = path.join(home, 'hosts.json');
  fs.writeFileSync(hosts, JSON.stringify({ [H]: { url: URL_CASA } }));
  const env = { ...process.env, NYX5_HOME: home, NYX5_HOSTS: hosts, NYX5_HOUSE: H };

  await ejecutar(process.execPath, [CLI, 'whoami'], { env });
  const primera = listarLlaves(home);
  const { stdout } = await ejecutar(process.execPath, [CLI, 'whoami'], { env });

  assert.deepEqual(listarLlaves(home), primera, 'creó una identidad nueva en vez de reusar la que ya había');
  assert.match(stdout, new RegExp(`@${H}`), 'whoami tiene que decir quién es');
});

// Nació de un defecto que apareció HACIENDO la demo, no leyendo el código: `join` escribía en
// ~/.nyx5 mientras el alta automática escribía en el directorio configurado. Dos escritores, dos
// directorios, y una identidad recién creada que el comando siguiente no encontraba. Lo que lo
// tapaba es que en la máquina del que programa los dos sitios suelen ser el mismo.
test('`join` escribe donde los demás comandos buscan: un solo directorio de llaves', async () => {
  const home = tmp();
  const hosts = path.join(home, 'hosts.json');
  fs.writeFileSync(hosts, JSON.stringify({ [H]: { url: URL_CASA } }));
  const env = { ...process.env, NYX5_HOME: home, NYX5_HOSTS: hosts, NYX5_HOUSE: H };

  await ejecutar(process.execPath, [CLI, 'join', '--name', 'escribe-aqui', '--json'], { env });

  const llaves = listarLlaves(home);
  assert.deepEqual(llaves, ['escribe-aqui.json'], `join dejó la llave fuera del directorio que lee el resto. Encontradas: ${JSON.stringify(llaves)}`);

  // Y el comando siguiente la encuentra sin que nadie le diga dónde está.
  const { stdout, stderr } = await ejecutar(process.execPath, [CLI, 'whoami'], { env });
  assert.match(stdout, new RegExp(`escribe-aqui@${H}`), 'whoami no usó la identidad que join acababa de crear');
  assert.doesNotMatch(stderr, /joined /, 'se unió de nuevo en vez de reusar la que join creó');
});

// EL camino por el que un agente usa Nyx5 dentro de su cliente. Hasta el 4-nov-2026 `nyx5 mcp`
// exigía `--agent <ruta>`, así que el bloque de configuración era DISTINTO para cada agente y
// había que haber corrido `join` antes de poder pegarlo. Con eso, nada de la cero fricción llegaba
// al camino que de verdad usa un agente: lo encontré porque Nicholas preguntó tres veces cómo
// adoptaba Nyx5 el agente de Felipe, no porque lo viera leyendo el código.
test('el puente MCP arranca desde una máquina en blanco: se une solo y contesta quién es', async () => {
  const home = tmp();
  const hosts = path.join(home, 'hosts.json');
  fs.writeFileSync(hosts, JSON.stringify({ [H]: { url: URL_CASA } }));
  const env = { ...process.env, NYX5_HOME: home, NYX5_HOSTS: hosts, NYX5_HOUSE: H };

  const { spawn } = await import('node:child_process');
  const proc = spawn(process.execPath, [CLI, 'mcp'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let muerto = null;
  proc.on('exit', (c) => { muerto = c; });
  const respuestas = [];
  let buffer = '';
  proc.stdout.on('data', (d) => {
    buffer += d.toString();
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const linea = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (linea) respuestas.push(JSON.parse(linea));
    }
  });
  const pedir = (msg) => new Promise((res, rej) => {
    const n = respuestas.length;
    proc.stdin.write(JSON.stringify(msg) + '\n');
    // El temporizador se limpia en LOS DOS caminos. Sin esto, un puente que muere al arrancar
    // dejaba el intervalo vivo y la suite entera colgada: una prueba que cuelga es peor que una
    // que falla, porque no dice nada y se lleva el resto por delante. (Medido al mutar, 4-nov.)
    const i = setInterval(() => { if (respuestas.length > n) { listo(); res(respuestas[n]); } }, 20);
    const t = setTimeout(() => { listo(); rej(new Error(`sin respuesta a ${msg.method}`)); }, 10_000);
    function listo() { clearInterval(i); clearTimeout(t); }
  });

  try {
    const init = await pedir({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    assert.equal(init.result.serverInfo.name, 'nyx5', 'el puente no se presentó');

    const tools = await pedir({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const nombres = tools.result.tools.map((t) => t.name);
    assert.ok(nombres.includes('nyx5_send') && nombres.includes('nyx5_inbox'), 'faltan las herramientas básicas');
    assert.ok(nombres.includes('nyx5_attach'), 'el puente local TIENE que poder mandar archivos: es su diferencia con el remoto');

    const quien = await pedir({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nyx5_whoami', arguments: {} } });
    assert.match(quien.result.content[0].text, new RegExp(`@${H}`), 'el puente no sabe quién es');
    assert.equal(listarLlaves(home).length, 1, 'tenía que haberse unido solo al arrancar');
  } finally {
    proc.kill();
  }
});

// El bloque que se pega en el cliente es el MISMO para todos: sin ruta, sin nombre, sin nada que
// cambiar. Con la ruta dentro, cada agente necesitaba el suyo, y eso obliga a correr algo antes de
// poder configurarlo — justo lo que este proyecto dice no pedir.
test('el bloque de configuración MCP es constante: no lleva la ruta de nadie', async () => {
  const { bloqueMcp } = await import('../src/correo/unirse.js');
  const b = bloqueMcp({ address: 'aria@casa.local' });
  const args = b.mcpServers.nyx5.args;
  assert.deepEqual(args, ['-y', '@nyx5/nyx5', 'mcp'], `el bloque dejó de ser constante: ${JSON.stringify(args)}`);
  // Ninguna ruta de esta máquina: lo único con barra permitido es el nombre del paquete.
  assert.ok(!args.some((a) => a !== '@nyx5/nyx5' && a.includes('/')), `el bloque lleva una ruta de esta máquina: ${JSON.stringify(args)}`);
  // Y sigue existiendo el camino explícito, para quien tiene varias identidades.
  assert.deepEqual(bloqueMcp({ keyfile: '/k/aria.json' }).mcpServers.nyx5.args, ['-y', '@nyx5/nyx5', 'mcp', '--agent', '/k/aria.json']);
});
