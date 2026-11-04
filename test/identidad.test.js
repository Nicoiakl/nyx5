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
