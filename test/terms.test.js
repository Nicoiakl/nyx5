// /terms existe sólo si la casa entrega el HTML de los términos (aprobados por Nicholas el
// 14-sep-2026). Sin él, la ruta no existe: los términos son declaraciones vinculantes del dueño.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Estafeta } from '../src/correo/estafeta.js';
import { TERMS_HTML } from '../src/plataformas/terms-html.js';

const P = 4811, P2 = 4812;
let tmp, con, sin;
before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-terms-'));
  const cfg = { adminToken: 't', workerIntervalMs: 60, libro: { welcome: 0, feeBps: 0 }, log: () => {} };
  const hosts = { 'con-t.test': `http://127.0.0.1:${P}`, 'sin-t.test': `http://127.0.0.1:${P2}` };
  con = await new Estafeta({ ...cfg, hosts, domain: 'con-t.test', port: P, dataDir: path.join(tmp, 'con'), terms: TERMS_HTML }).start();
  sin = await new Estafeta({ ...cfg, hosts, domain: 'sin-t.test', port: P2, dataDir: path.join(tmp, 'sin') }).start();
});
after(async () => { await con?.stop(); await sin?.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('la página generada trae los términos aprobados, con su fecha, y sin caracteres invisibles', () => {
  assert.match(TERMS_HTML, /<title>Terms · Nyx5<\/title>/);
  assert.match(TERMS_HTML, /Terms for nyx5\.com/);
  assert.match(TERMS_HTML, /cannot be redeemed, exchanged or converted/);
  assert.match(TERMS_HTML, /Last updated: 14 September 2026/);
  assert.doesNotMatch(TERMS_HTML, /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\u0000]/);
});

test('con términos, GET /terms responde 200 en HTML y el sitemap lo lista; sin ellos, la ruta no existe', async () => {
  const r = await fetch(`http://127.0.0.1:${P}/terms`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') || '', /text\/html/);
  assert.match(await r.text(), /What the tokens are/);
  const mapa = await (await fetch(`http://127.0.0.1:${P}/sitemap.xml`)).text();
  assert.match(mapa, /\/terms<\/loc>/);
  const r2 = await fetch(`http://127.0.0.1:${P2}/terms`);
  assert.equal(r2.status, 404);
  const mapa2 = await (await fetch(`http://127.0.0.1:${P2}/sitemap.xml`)).text();
  assert.doesNotMatch(mapa2, /\/terms<\/loc>/);
});
