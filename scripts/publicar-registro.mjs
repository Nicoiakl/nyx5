// Publica server.json en el registro oficial de MCP, que es por donde un agente nos encuentra.
//
// Sin binario de terceros: el registro tiene API. Se cambia un token de GitHub por un JWT corto
// del registro (`/v0/auth/github-at`) y se manda la entrada (`/v0/publish`). El namespace
// `io.github.Nicoiakl/*` lo autoriza ese token; el registro además comprueba que el paquete de
// npm declare `mcpName` igual al nombre del servidor.
//
// El token NO se imprime nunca, ni completo ni en un error (§9): sale de `gh auth token` y se
// muestra sólo su largo.
//
// Antes de mandar nada valida contra `/v0/validate`, que es gratis, y después COMPRUEBA contra el
// registro lo que quedó servido — no contra la respuesta del POST (§1: el terreno, no el reporte).
//
//   node scripts/publicar-registro.mjs            # publica
//   node scripts/publicar-registro.mjs --dry-run  # sólo valida

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { SERVIDOR, REGISTRO, revisar } from './puerta-registro.mjs';

const raiz = new URL('..', import.meta.url).pathname;
const entrada = JSON.parse(readFileSync(`${raiz}server.json`, 'utf8'));
const seco = process.argv.includes('--dry-run');

const post = async (ruta, cuerpo, token = null) => {
  const r = await fetch(`${REGISTRO}${ruta}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(cuerpo),
  });
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch { /* el cuerpo de error puede no ser JSON */ }
  return { ok: r.ok, status: r.status, cuerpo: j ?? t };
};

// 1. Validar antes de autenticarse: un server.json malo no debería ni pedir un token.
const v = await post('/v0/validate', entrada);
if (!v.ok || v.cuerpo?.valid !== true) {
  console.error(`server.json no valida (HTTP ${v.status}):`);
  console.error(JSON.stringify(v.cuerpo, null, 2));
  process.exit(1);
}
console.log(`server.json valida contra el registro (version ${entrada.version})`);

// 1b. npm tiene que servir ya la version que la entrada manda a instalar. Al reves se publica
// una receta que apunta a algo que no existe, y el que llega se come un 404 de npm. Se comprueba
// ANTES de pedir token para que un intento temprano no cueste un viaje.
const npmDeclarada = entrada.packages.find((x) => x.registryType === 'npm')?.version;
if (npmDeclarada) {
  const r = await fetch(`https://registry.npmjs.org/${entrada.packages[0].identifier}/${npmDeclarada}`);
  if (!r.ok) {
    console.error(`npm todavia no sirve ${entrada.packages[0].identifier}@${npmDeclarada} (HTTP ${r.status}).`);
    console.error('primero publica el paquete (`git push --follow-tags`, el release corre en CI) y vuelve.');
    process.exit(1);
  }
  console.log(`npm ya sirve ${entrada.packages[0].identifier}@${npmDeclarada}`);
}

if (seco) { console.log('--dry-run: no se publica'); process.exit(0); }

// 2. Token de GitHub -> JWT del registro.
let ghToken;
try {
  ghToken = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
} catch {
  console.error('no hay token de GitHub: correr `gh auth login` primero');
  process.exit(2);
}
if (!ghToken) { console.error('`gh auth token` devolvio vacio'); process.exit(2); }
console.log(`token de GitHub leido (${ghToken.length} caracteres, no se imprime)`);

const a = await post('/v0/auth/github-at', { github_token: ghToken });
if (!a.ok || !a.cuerpo?.registry_token) {
  console.error(`el registro no acepto el token de GitHub (HTTP ${a.status}): ${JSON.stringify(a.cuerpo)}`);
  process.exit(1);
}

// 3. Publicar.
const p = await post('/v0/publish', entrada, a.cuerpo.registry_token);
if (!p.ok) {
  console.error(`el registro rechazo la entrada (HTTP ${p.status}):`);
  console.error(JSON.stringify(p.cuerpo, null, 2));
  process.exit(1);
}
console.log(`publicado: ${SERVIDOR} ${entrada.version}`);

// 4. Comprobar contra el registro, no contra la respuesta del POST.
const r = await fetch(`${REGISTRO}/v0/servers?search=nyx5&version=latest`, { headers: { accept: 'application/json' } });
const d = await r.json();
const servido = (d.servers || []).find((s) => (s.server || s).name === SERVIDOR) || null;
const problemas = revisar({ entrada: servido, versionRepo: entrada.version, npmLatest: entrada.packages.find((x) => x.registryType === 'npm')?.version });
if (problemas.length) {
  console.error('el registro quedo sirviendo algo distinto de lo que se mando:');
  for (const x of problemas) console.error(`  [regla ${x.regla}] ${x.que}`);
  process.exit(1);
}
console.log(`el registro sirve ${(servido.server || servido).version} y no le pide nada a quien llega`);
