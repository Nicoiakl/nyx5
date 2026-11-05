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
const correr = async (args) => {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [BIN, ...args]);
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
