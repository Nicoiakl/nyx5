// La puerta de entrada: lo que un desconocido instala tiene que ofrecer lo que la casa ofrece.
//
// Nació de un defecto real (3-nov-2026): npm servía 0.7.0 del 14 de septiembre, 61 commits
// atrás, SIN los adjuntos — la única cosa que resolvía el dolor con el que se presenta Nyx5.
// El repo también decía 0.7.0, así que comparar el número daba verde con la puerta podrida:
// `npm publish` exigía el 2FA de Nicholas y simplemente dejó de ocurrir, sin que nada gritara.
//
// Por eso NO compara versiones: compara la SUPERFICIE que ve el desconocido — los comandos de
// la CLI y las herramientas MCP. Si el paquete publicado ofrece menos que este repo, la puerta
// está atrasada en algo que alguien de fuera puede notar, y eso es rojo.
//
// Falla cerrado y con precisión: sólo reclama por lo que FALTA afuera. Que el paquete tenga
// algo que el repo ya no tiene es asunto de la próxima publicación, no de esta guardia, y una
// diferencia de comentarios o de formato no retiene trabajo bueno.
//
//   node scripts/puerta-npm.mjs            # rojo si npm ofrece menos que el repo
//   node scripts/puerta-npm.mjs --json

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PAQUETE = '@nyx5/nyx5';

// La superficie se lee del código, no de una lista a mano: una lista a mano envejece igual que
// el paquete que vigila.
const comandos = (fuente) => new Set([...fuente.matchAll(/^\s*case '([a-z0-9:-]+)'/gmi)].map((m) => m[1]));
const herramientas = (fuente) => new Set([...fuente.matchAll(/name: '(nyx5_[a-z_]+)'/g)].map((m) => m[1]));

const faltan = (aqui, alla) => [...aqui].filter((x) => !alla.has(x)).sort();

const raiz = new URL('..', import.meta.url).pathname;
const leer = (base, rel) => readFileSync(join(base, rel), 'utf8');

const tmp = mkdtempSync(join(tmpdir(), 'puerta-npm-'));
let publicado;
try {
  const tgz = execFileSync('npm', ['pack', PAQUETE, '--silent', '--pack-destination', tmp], { encoding: 'utf8' }).trim().split('\n').pop();
  execFileSync('tar', ['xzf', join(tmp, tgz), '-C', tmp]);
  publicado = join(tmp, 'package');
} catch (e) {
  console.error(`no se pudo bajar ${PAQUETE} de npm: ${e.message}`);
  process.exit(2);
}

const version = (base) => JSON.parse(leer(base, 'package.json')).version;
const informe = {
  paquete: PAQUETE,
  version_publicada: version(publicado),
  version_del_repo: version(raiz),
  comandos_que_faltan_afuera: faltan(comandos(leer(raiz, 'bin/nyx5.js')), comandos(leer(publicado, 'bin/nyx5.js'))),
  herramientas_que_faltan_afuera: faltan(herramientas(leer(raiz, 'src/puentes/herramientas.js')), herramientas(leer(publicado, 'src/puentes/herramientas.js'))),
};
rmSync(tmp, { recursive: true, force: true });

const atrasada = informe.comandos_que_faltan_afuera.length || informe.herramientas_que_faltan_afuera.length;
informe.puerta = atrasada ? 'ATRASADA' : 'al dia';

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(informe, null, 2));
} else {
  console.log(`${PAQUETE}: npm sirve ${informe.version_publicada}, el repo es ${informe.version_del_repo}`);
  if (!atrasada) console.log('puerta al dia: lo publicado ofrece todo lo que ofrece este repo');
  else {
    console.log('PUERTA ATRASADA — un desconocido que instale hoy no tiene:');
    for (const c of informe.comandos_que_faltan_afuera) console.log(`  comando     ${c}`);
    for (const h of informe.herramientas_que_faltan_afuera) console.log(`  herramienta ${h}`);
    console.log('\nse arregla publicando: npm version <nueva> && git push --tags  (el release corre en CI)');
  }
}
process.exit(atrasada ? 1 : 0);
