// node --test test/
//
// El registro oficial de MCP es por donde un agente nos ENCUENTRA, y su entrada no es
// documentación: es la receta con la que un cliente arma el comando. El 4-nov-2026 esa entrada
// llevaba siete semanas sirviendo la 0.7.0 y, dentro, declaraba `--agent` como requerido con un
// texto que mandaba a correr `join` y a pegar la ruta de la llave — el paso que esa misma tarde
// habíamos borrado. El canal de descubrimiento enseñaba la fricción que ya no existe.
//
// El caso de prueba NO es un ejemplo inventado: `test/fixtures/registro-mcp-0.7.0.json` lo bajó
// curl del registro, tal cual estaba. Un literal escrito a mano ya dio verde con el defecto vivo
// dos veces en esta casa.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { revisar, versionEnLaUrl } from '../scripts/puerta-registro.mjs';

const leer = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));

const vieja = leer('./fixtures/registro-mcp-0.7.0.json');
const nuestra = leer('../server.json');
const paquete = leer('../package.json');

test('GRITO · la entrada que de verdad estuvo publicada se reporta por sus tres defectos', () => {
  const p = revisar({ entrada: vieja, versionRepo: '0.9.0', npmLatest: '0.9.0' });
  const reglas = new Set(p.map((x) => x.regla));
  assert.ok(reglas.has(1), 'no vio que el registro estaba siete semanas atrás');
  assert.ok(reglas.has(2), 'no vio que la entrada exige --agent antes de poder usar nada');
  assert.ok(reglas.has(3), 'no vio que el .mcpb apunta a un artefacto de otra versión');
  // Y lo dice nombrando el campo, no "hay un problema".
  assert.match(p.find((x) => x.regla === 2).que, /--agent/);
  assert.match(p.find((x) => x.regla === 3).que, /0\.4\.0/);
});

test('SILENCIO · la entrada de este repo no le pide nada a quien llega', () => {
  const p = revisar({ entrada: nuestra, versionRepo: paquete.version, npmLatest: paquete.version });
  assert.deepEqual(p, [], `server.json tiene problemas:\n${p.map((x) => `  [${x.regla}] ${x.que}`).join('\n')}`);
});

// La regla 2 es la que importa para la adopción, así que se fija sobre el ARCHIVO y no sólo
// sobre lo publicado: así un `isRequired` nuevo lo caza `npm test`, no la guardia de los lunes.
test('server.json no declara ningún argumento requerido, en ninguno de los dos arrays', () => {
  for (const pk of nuestra.packages || []) {
    for (const a of [...(pk.runtimeArguments || []), ...(pk.packageArguments || [])]) {
      assert.ok(!a.isRequired, `${a.name || a.value} quedó requerido: eso es un campo que el desconocido tiene que rellenar antes de ver nada`);
    }
  }
});

// La entrada y el paquete tienen que decir lo mismo: el registro manda al cliente a npm.
test('server.json y package.json declaran la misma version y el mismo nombre MCP', () => {
  assert.equal(nuestra.version, paquete.version);
  assert.equal(nuestra.packages.find((p) => p.registryType === 'npm').version, paquete.version);
  assert.equal(nuestra.name, paquete.mcpName, 'el registro valida que el paquete declare mcpName igual al nombre del servidor');
});

test('una URL con la version dentro se reconoce; una sin version no inventa una', () => {
  assert.equal(versionEnLaUrl('https://github.com/x/y/releases/download/v0.4.0/n-0.4.0.mcpb'), '0.4.0');
  assert.equal(versionEnLaUrl('https://example.com/latest.mcpb'), null);
});

test('si el registro no tiene entrada, es rojo y no silencio', () => {
  const p = revisar({ entrada: null, versionRepo: '0.9.0' });
  assert.equal(p.length, 1);
  assert.equal(p[0].regla, 1);
});
