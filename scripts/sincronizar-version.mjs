// La versión vive en cuatro sitios y tres archivos: package.json, src/version.js (un literal,
// porque ese módulo corre en el edge, donde no hay sistema de archivos) y server.json dos veces
// (la del servidor y la del paquete que declara al registro de MCP).
//
// Dos pruebas ya gritan si se desincronizan, así que el defecto no llega a producción — pero
// gritaban DESPUÉS de que alguien se acordara de editar los tres a mano. Esto lo hace solo:
// `npm version patch` llama a este script por el ciclo de vida de npm, y de paso lo deja en el
// mismo commit.
//
//   node scripts/sincronizar-version.mjs          # lleva src/version.js y server.json a package.json
//   node scripts/sincronizar-version.mjs --check   # sólo comprueba, rojo si no coinciden

import { readFileSync, writeFileSync } from 'node:fs';

const raiz = new URL('..', import.meta.url).pathname;
const leer = (f) => readFileSync(`${raiz}${f}`, 'utf8');
const version = JSON.parse(leer('package.json')).version;
const comprobar = process.argv.includes('--check');

const cambios = [];

// src/version.js: un literal, se reemplaza el literal y nada más.
const antes = leer('src/version.js');
const despues = antes.replace(/(export const VERSION = ')[^']+(')/, `$1${version}$2`);
if (despues !== antes) {
  cambios.push('src/version.js');
  if (!comprobar) writeFileSync(`${raiz}src/version.js`, despues);
}

// server.json: la del servidor y la de CADA paquete, que es la que el registro manda a instalar.
const srv = JSON.parse(leer('server.json'));
let tocado = srv.version !== version;
srv.version = version;
for (const p of srv.packages || []) {
  if (p.registryType === 'npm') {
    if (p.version !== version) tocado = true;
    p.version = version;
  }
}
if (tocado) {
  cambios.push('server.json');
  if (!comprobar) writeFileSync(`${raiz}server.json`, `${JSON.stringify(srv, null, 2)}\n`);
}

if (comprobar) {
  if (cambios.length) {
    console.error(`la version ${version} de package.json no esta en: ${cambios.join(', ')}`);
    process.exit(1);
  }
  console.log(`version ${version} coherente en package.json, src/version.js y server.json`);
} else {
  console.log(cambios.length ? `version ${version} escrita en: ${cambios.join(', ')}` : `version ${version} ya estaba en todos`);
}
