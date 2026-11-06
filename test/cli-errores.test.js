// node --test test/
//
// Lo que la CLI contesta cuando el que llega se equivoca. No es cosmética: un agente que aterrizó
// de cero el 5-nov-2026 —sin saber nada de Nyx5, llegando por una búsqueda web— reportó que
// `wait` le imprimió la ayuda COMPLETA, exactamente igual que un comando inventado, así que desde
// la shell no había forma de distinguir «no existe» de «lo escribiste mal». Tuvo que hablarle
// JSON-RPC al subcomando `mcp` y pedirle `tools/list` para averiguar que `nyx5_wait` existe sólo
// por MCP. Y `--timeout` le devolvió el stack trace crudo de Node.
//
// Los comandos de estas pruebas son los que ESE agente corrió, textuales. Un caso que yo inventara
// daría verde con el defecto vivo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'nyx5.js');
const correr = async (args, env = {}) => {
  const opciones = { env: { ...process.env, ...env } };
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [BIN, ...args], opciones);
    return { code: 0, stdout, stderr };
  } catch (e) { return { code: e.code, stdout: e.stdout || '', stderr: e.stderr || '' }; }
};

test('GRITO · un comando que no existe lo DICE, y no se disfraza de ayuda', async () => {
  const r = await correr(['wait']);                     // el comando exacto que probó
  assert.equal(r.code, 1);
  assert.match(r.stderr, /"wait" is not a nyx5 command/, 'tiene que nombrar lo que no existe');
  assert.match(r.stderr, /commands: .*\bsend\b/, 'y decir cuáles sí existen');
  assert.match(r.stderr, /only as MCP tools/, 'y que una capacidad puede vivir sólo en MCP: eso es lo que le faltó');
  // Lo que lo hacía indistinguible: la salida de un comando inventado era IDÉNTICA.
  const inventado = await correr(['noexiste']);
  assert.notEqual(r.stderr, '', 'sin stderr vuelve a ser indistinguible');
  assert.match(inventado.stderr, /"noexiste" is not a nyx5 command/);
  assert.notEqual(r.stderr, inventado.stderr, 'dos comandos distintos no pueden dar el MISMO error');
});

test('GRITO · una bandera desconocida da un mensaje, no el stack trace de Node', async () => {
  const r = await correr(['inbox', '--timeout', '20']);  // lo que de verdad escribió
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--timeout is not a nyx5 option/);
  assert.match(r.stderr, /valid options: .*--body/);
  assert.ok(!/node:internal|ERR_PARSE_ARGS_UNKNOWN_OPTION|at checkOptionUsage/.test(r.stderr),
    `le tiró las tripas de Node a la cara:\n${r.stderr.slice(0, 300)}`);
});

test('SILENCIO · sin comando la ayuda sigue siendo la respuesta correcta, por stdout y con éxito', async () => {
  const r = await correr([]);
  assert.equal(r.code, 0, 'pedir ayuda no es un error');
  assert.match(r.stdout, /Nyx5/);
  assert.equal(r.stderr, '', 'la ayuda no se queja');
});

test('la lista de comandos se lee del código, así que no puede quedar vieja', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(BIN, 'utf8');
  const delSwitch = [...src.matchAll(/^\s{4}case '([a-z0-9-]+)':/gm)].map((m) => m[1]);
  const r = await correr(['noexiste']);
  const anunciados = /commands: (.+)/.exec(r.stderr)[1].trim().split(/\s+/);
  assert.deepEqual(anunciados, delSwitch, 'lo que anuncia la CLI tiene que ser lo que implementa');
  for (const c of ['send', 'inbox', 'join', 'whoami']) assert.ok(delSwitch.includes(c), `falta ${c}`);
});

// Encontrar a OTROS es el momento entero de un protocolo entre agentes, y era donde la CLI pedía
// un dato que un recién llegado no puede adivinar: `nyx5 search` exigía `--index` y contestaba
// «missing --index» a quien acababa de recibir dirección, buzón y saldo (6-nov-2026). Nicholas
// definió que el usuario objetivo es el agente autónomo que busca solo, así que ésta es la puerta
// que importa justo después del alta.
//
// Las pruebas levantan una casa de mentira en localhost en vez de golpear producción: una suite
// que depende de que nyx5.com conteste no mide el código, mide la red — y falla por la razón
// equivocada el día que haya un corte.
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';

const casaFalsa = (responder) => new Promise((listo) => {
  const srv = http.createServer((req, res) => responder(req, res));
  srv.listen(0, '127.0.0.1', () => listo({ srv, url: `http://127.0.0.1:${srv.address().port}` }));
});
const sinIdentidad = () => ({ HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-vacio-')), NYX5_AGENT: '' });

test('GRITO · search no le pide al recién llegado un índice que no puede adivinar', async () => {
  const { srv, url } = await casaFalsa((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ index: 'casa-falsa', total: 2, agents: [{ address: 'a@casa-falsa' }, { address: 'b@casa-falsa' }] }));
  });
  try {
    // Sin identidad y sin --index: tiene que resolver solo a su casa por defecto y BUSCAR.
    const r = await correr(['search', '--limit', '2'], { ...sinIdentidad(), NYX5_HOUSE: url });
    assert.ok(!/missing --index/.test(r.stderr), `siguió pidiendo el índice:\n${r.stderr}`);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /2 agent\(s\) in index/);
  } finally { srv.close(); }
});

test('GRITO · una casa sin índice es un ERROR, no una búsqueda vacía', async () => {
  // Una casa puede no correr índice (se enciende por variable) y contesta 404. Antes esto
  // imprimía «undefined agent(s)»: un agente archivaba «ahí no hay nadie» como hecho verificado.
  // No se pierde un usuario, se propaga una afirmación falsa sobre nosotros, que sale más caro.
  const { srv, url } = await casaFalsa((req, res) => { res.statusCode = 404; res.end('{"reason":"unknown route"}'); });
  try {
    const r = await correr(['search', '--index', url], sinIdentidad());
    assert.equal(r.code, 1, 'un 404 no puede salir con éxito');
    assert.match(r.stderr, /did not answer the index \(HTTP 404\)/);
    assert.equal(r.stdout.trim(), '', 'no se imprime un resultado que no hubo');
  } finally { srv.close(); }
});

test('GRITO · un índice que contesta 200 SIN cuenta no se reporta como un número', async () => {
  // El instrumento que falla hacia el ruido: `d.total` ausente imprimía «undefined agent(s)».
  const { srv, url } = await casaFalsa((req, res) => { res.end(JSON.stringify({ agents: [] })); });
  try {
    const r = await correr(['search', '--index', url], sinIdentidad());
    assert.equal(r.code, 1);
    assert.ok(!/undefined/.test(r.stdout + r.stderr), 'nunca un número que no existe');
  } finally { srv.close(); }
});
