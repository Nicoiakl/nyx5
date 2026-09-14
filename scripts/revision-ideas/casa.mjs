// Casa local sobre D1 local con ideas@ dado de alta. Sin red: todo por fetchPropio.
import { randomBytes } from 'node:crypto';
import { generateKeys } from '../../src/nucleo/crypto.js';
import { Estafeta } from '../../src/correo/estafeta.js';
import { Agent } from '../../src/correo/agente.js';
import { D1Store } from '../../src/nucleo/almacen-d1.js';
import { openLocalD1 } from '../../src/nucleo/d1-local.js';
import { MIGRACIONES } from '../../test/_migraciones.js';

export const DOM = 'casa.test';
export async function levantar({ dos = false, fetchImpl, salidas = [] } = {}) {
  const db = openLocalD1(); db._raw.exec(MIGRACIONES);
  const store = new D1Store(db);
  const vaultKey = randomBytes(32).toString('base64');
  const espia = fetchImpl || (async (url, init) => { salidas.push(String(url)); throw new Error(`salida a la red: ${url}`); });
  const casaDe = () => new Estafeta({ domain: DOM, store, adminToken: 't', publicUrl: `https://${DOM}`, workerIntervalMs: 999_999, log: () => {}, fetchImpl: espia, remoto: { enabled: true, vaultKey }, ideas: { enabled: true }, policy: { registration: 'open' } });
  const a = casaDe(); await a.init();
  const b = dos ? casaDe() : null; if (b) await b.init();
  const rx = (method, path, body, auth = 'Bearer t') => a.handleRequest({ method, path, query: new URLSearchParams(), headers: auth ? { authorization: auth } : {}, body, ip: '127.0.0.1' });
  const agente = async (local, opts = {}) => { const ag = Agent.create(`${local}@${DOM}`, `https://${DOM}`, { fetchImpl: a.fetchPropio }); await ag.register({ adminToken: 't', ...opts }); return ag; };
  const nicholas = await agente('nicholas');
  const nico = await agente('nico');
  const claudeNico = await nico.delegate('claude', { scope: { messages_only: true }, inbox: { policy: 'allowlist', allowlist: [nico.address] } });
  const alta = await rx('POST', '/admin/ideas', { owner: nicholas.address, allow: [nico.address, claudeNico.address], keys: generateKeys() });
  if (alta.status !== 201) throw new Error(`alta: ${alta.status} ${JSON.stringify(alta.body)}`);
  // Entregar la cola entera (no 20 por tick) sin atender ideas@: sólo mueve sobres al buzón.
  const drenar = async (est = a) => { const real = store.claimDueJobs.bind(store); store.claimDueJobs = (n) => real(n, 5000); try { await est.tick({ programado: false }); } finally { store.claimDueJobs = real; } };
  return { a, b, db, store, rx, agente, nicholas, nico, claudeNico, drenar, salidas, IDEAS: `ideas@${DOM}` };
}
export const ms = (t0) => `${(performance.now() - t0).toFixed(0)} ms`;
