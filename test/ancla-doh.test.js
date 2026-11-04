// node --test test/
//
// El ancla del DNS por dos transportes (4-nov-2026). Nace de un defecto MEDIDO al probar el alta
// desde cero con el paquete que npm acababa de publicar: en el Mac de Nicholas los tres
// servidores de DNS (sistema, 1.1.1.1, 8.8.8.8) dan ETIMEOUT, así que `npx @nyx5/nyx5 mcp` moría
// en la primera llamada con el registro TXT perfecto. Lo mismo le pasa a un contenedor, a un
// runner de CI y a una red corporativa — o sea, a la población de agentes.
//
// NADA de lo que estas pruebas comparan está escrito a mano: el error de DNS lo produjo esta
// máquina (`fixtures/dns-sin-udp53.json`) y las dos respuestas por HTTPS las bajó curl del
// resolutor de verdad (`fixtures/doh-nyx5-txt.json`, `fixtures/doh-sin-registro.json`). Un
// literal que yo inventara daría verde con el defecto vivo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Resolver } from '../src/correo/resolver.js';

const fx = (n) => JSON.parse(fs.readFileSync(new URL(`fixtures/${n}`, import.meta.url), 'utf8'));
const SIN_UDP = fx('dns-sin-udp53.json');
const DOH_OK = fx('doh-nyx5-txt.json');
const DOH_NO = fx('doh-sin-registro.json');

// Una red sin UDP/53, tal como falla de verdad.
const dnsCaido = { resolveTxt: async () => { throw Object.assign(new Error(SIN_UDP.message), { code: SIN_UDP.code }); } };
// Un DNS que responde, para comprobar que por ahí no se pregunta nada por HTTPS.
const dnsVivo = (txt) => ({ resolveTxt: async () => [[txt]] });

const respuesta = (cuerpo, ok = true, status = 200) => ({ ok, status, json: async () => cuerpo });
function espia(impl) {
  const urls = [];
  return { urls, fetchImpl: async (url, opts) => { urls.push(String(url)); return impl(String(url), opts); } };
}

// El registro real, leído del fixture: es lo que el resolutor sirve hoy para _nyx5.nyx5.com.
const TXT_REAL = String(DOH_OK.Answer.find((a) => a.type === 16).data).replace(/^"|"$/g, '');

test('GRITO · sin UDP/53, el ancla llega por HTTPS y es el MISMO registro', async () => {
  const e = espia(() => respuesta(DOH_OK));
  const r = new Resolver({ dnsImpl: dnsCaido, fetchImpl: e.fetchImpl });
  const loc = await r.locate('nyx5.com');
  assert.equal(loc.source, 'doh', 'con el DNS caído el ancla tiene que venir por HTTPS');
  assert.equal(loc.url, 'https://nyx5.com');
  assert.equal(loc.sig, '-bJ2L1imMn6N3x6SY79LPali3xKCAIiDekl4xwVhBxs');
  assert.match(e.urls[0], /^https:\/\/cloudflare-dns\.com\/dns-query\?name=_nyx5\.nyx5\.com&type=TXT$/);
});

test('los DOS transportes leen el mismo registro y dan la misma ancla', async () => {
  const porUdp = await new Resolver({ dnsImpl: dnsVivo(TXT_REAL), fetchImpl: async () => { throw new Error('no se pregunta por HTTPS si el DNS contesta'); } }).locate('nyx5.com');
  const porHttps = await new Resolver({ dnsImpl: dnsCaido, fetchImpl: async () => respuesta(DOH_OK) }).locate('nyx5.com');
  assert.equal(porUdp.source, 'dns');
  assert.equal(porHttps.source, 'doh');
  assert.deepEqual({ url: porHttps.url, sig: porHttps.sig }, { url: porUdp.url, sig: porUdp.sig },
    'si los transportes no coinciden, uno de los dos está mintiendo');
});

test('SILENCIO · si el DNS no contesta Y por HTTPS tampoco, NO se cae a well-known', async () => {
  for (const [nombre, impl] of [
    ['la petición falla', async () => { throw new Error('ECONNREFUSED'); }],
    ['contesta 500', async () => respuesta(null, false, 500)],
    ['SERVFAIL (status 2)', async () => respuesta({ Status: 2 })],
    ['el respaldo está apagado', null],
  ]) {
    const r = new Resolver({ dnsImpl: dnsCaido, ...(impl ? { fetchImpl: impl } : { doh: null }) });
    await assert.rejects(() => r.locate('nyx5.com'), (err) => {
      assert.match(err.message, /DNS unavailable for nyx5\.com/, nombre);
      assert.equal(err.permanent, false, `${nombre}: es reintentable, no definitivo`);
      return true;
    }, `${nombre}: bloquear el DNS NO puede empujar el ancla a well-known`);
  }
});

test('un resolutor que AFIRMA que no hay registro deja pasar a well-known, como un NXDOMAIN por UDP', async () => {
  assert.equal(DOH_NO.Status, 3, 'el fixture tiene que ser un NXDOMAIN real');
  const r = new Resolver({ dnsImpl: dnsCaido, fetchImpl: async () => respuesta(DOH_NO) });
  assert.deepEqual(await r.locate('nyx5-no-existe-jamas.com'), { source: 'well-known', url: 'https://nyx5-no-existe-jamas.com' });
  // Y un 200 sin ningún TXT de Nyx5 es lo mismo que no haber registro.
  const r2 = new Resolver({ dnsImpl: dnsCaido, fetchImpl: async () => respuesta({ Status: 0, Answer: [{ type: 16, data: '"v=spf1 -all"' }] }) });
  assert.equal((await r2.locate('otra.com')).source, 'well-known');
});

test('con el DNS sano no se pregunta nada por HTTPS: el respaldo es respaldo', async () => {
  const e = espia(() => { throw new Error('no debería preguntarse'); });
  const r = new Resolver({ dnsImpl: dnsVivo(TXT_REAL), fetchImpl: e.fetchImpl });
  assert.equal((await r.locate('nyx5.com')).source, 'dns');
  assert.deepEqual(e.urls, [], 'una petición de más es un tercero enterándose sin necesidad');
});

test('un NXDOMAIN por UDP tampoco gasta una petición por HTTPS', async () => {
  const e = espia(() => { throw new Error('no debería preguntarse'); });
  const dnsNx = { resolveTxt: async () => { throw Object.assign(new Error('queryTxt ENOTFOUND _nyx5.x.com'), { code: 'ENOTFOUND' }); } };
  const r = new Resolver({ dnsImpl: dnsNx, fetchImpl: e.fetchImpl });
  assert.equal((await r.locate('x.com')).source, 'well-known');
  assert.deepEqual(e.urls, []);
});

test('un TXT partido en varias cadenas se une, igual que por UDP', async () => {
  const partido = { Status: 0, Answer: [{ type: 16, data: '"v=nyx51; url=https://nyx5.com; si" "g=LLAVE"' }] };
  const r = new Resolver({ dnsImpl: dnsCaido, fetchImpl: async () => respuesta(partido) });
  assert.deepEqual(await r.locate('nyx5.com'), { source: 'doh', url: 'https://nyx5.com', sig: 'LLAVE' });
});
