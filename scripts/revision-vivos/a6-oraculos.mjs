// Ataque 6: oráculos de existencia en las rutas nuevas. `/admin/assistants` sin Bearer, con Bearer
// malo, sobre una dirección que no existe, sobre una que existe sin cerebro, y sobre una SECRETA.
// La regla (guion §1): un token inválido cuenta como nadie y la respuesta tiene que ser la MISMA
// exista o no el nombre — cuerpo y cabeceras byte a byte.
import { levantar, DOM } from './casa.mjs';

const { a, rx, agente, duena, rosetta } = await levantar();
const secreta = await agente('secreta', { visibility: 'secret' });
console.log(`secreta@ registrada con visibilidad: ${(await a.store.getAgent('secreta')).visibility}`);

const casos = {
  'sin Bearer': (p) => rx('GET', p, undefined, null),
  'Bearer malo': (p) => rx('GET', p, undefined, 'Bearer no-es'),
  'Bearer bueno': (p) => rx('GET', p, undefined, 'Bearer t'),
};
const rutas = {
  'inexistente': '/admin/assistants/fantasma',
  'viva sin cerebro': '/admin/assistants/amiga',
  'SECRETA sin cerebro': '/admin/assistants/secreta',
  'con cerebro (rosetta@)': '/admin/assistants/rosetta',
};
for (const [nc, f] of Object.entries(casos)) {
  console.log(`\n${nc}`);
  const vistos = new Map();
  for (const [nr, ruta] of Object.entries(rutas)) {
    const r = await f(ruta);
    const huella = `${r.status} ${JSON.stringify(r.body)}`;
    vistos.set(nr, huella);
    console.log(`   ${nr.padEnd(24)} -> ${huella.slice(0, 110)}`);
  }
  const distintas = new Set([...vistos.values()].map((x) => x.slice(0, 200)));
  if (nc !== 'Bearer bueno') console.log(`   ${distintas.size === 1 ? 'IGUALES: no hay oráculo' : `DISTINTAS (${distintas.size}): hay oráculo`}`);
}
// Y los métodos que escriben, sin credencial: ninguno tiene que mirar el almacén antes del 401.
console.log('\nescrituras sin credencial');
for (const [m, p, b] of [['POST', '/admin/assistants', { adopt: true, local: 'rosetta', keys: rosetta.keys, config: {} }], ['DELETE', '/admin/assistants/rosetta', undefined], ['PUT', '/admin/assistants/rosetta/config', { enabled: false }], ['POST', '/admin/assistants/rosetta/pause', undefined]]) {
  const r = await rx(m, p, b, null);
  console.log(`   ${m} ${p} -> ${r.status} ${JSON.stringify(r.body)}`);
}
console.log(`\nel cerebro de rosetta@ sigue encendido: ${(await a.store.kvGet('asistente', 'rosetta')).enabled}`);
console.log(`la dirección secreta sigue sin aparecer en el directorio: ${JSON.stringify((await rx('GET', '/directory')).body?.agents?.map((x) => x.address) || [])}`);
