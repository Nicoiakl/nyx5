// Nyx5/1 — Adaptador Node: sirve una Estafeta con node:http.
// La Estafeta no conoce el transporte; este archivo traduce req/res -> handleRequest(rx).

import http from 'node:http';

// JSON, o form-urlencoded si así lo declara el cliente: /oauth/token lo exige (RFC 6749 §4.1.3).
export function readJson(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('cuerpo demasiado grande'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      const texto = Buffer.concat(chunks).toString();
      if (String(req.headers['content-type'] || '').includes('application/x-www-form-urlencoded')) return resolve(Object.fromEntries(new URLSearchParams(texto)));
      if (!texto.trim()) return resolve({});
      try { resolve(JSON.parse(texto)); } catch { reject(Object.assign(new Error('invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

// Bytes crudos, sin parsear. Sólo la subida de un adjunto los usa (PUT /blob/<id>): un archivo no
// es JSON, y pasarlo en base64 dentro de un JSON lo infla un tercio para nada.
export function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error(`body too large (maximum ${limit} bytes)`), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
// El transporte deja pasar bastante más que el tope por adjunto para que el motivo del rechazo lo
// dé la RUTA, nombrando el límite real, y no el transporte con un «cuerpo demasiado grande».
export const RAW_MAX = 16 * 1024 * 1024;
const esSubidaDeAdjunto = (method, path) => method === 'PUT' && /^\/blob\/[^/]+$/.test(path);

export async function startNodeServer(estafeta, { port, host }) {
  const server = http.createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    try {
      const url = new URL(req.url, 'http://x');
      const crudo = esSubidaDeAdjunto(req.method, url.pathname);
      const body = (!crudo && (req.method === 'POST' || req.method === 'PUT')) ? await readJson(req) : null;
      const rx = {
        method: req.method,
        path: url.pathname,
        query: url.searchParams,
        headers: req.headers,
        body,
        raw: crudo ? await readRaw(req, RAW_MAX) : null,
        ip: req.socket?.remoteAddress || null,
      };
      const out = await estafeta.handleRequest(rx);
      const extra = out.headers || {};
      if (out.contentType) { res.writeHead(out.status, { ...extra, 'content-type': out.contentType }); res.end(out.body); }
      else { res.writeHead(out.status, { ...extra, 'content-type': 'application/json' }); res.end(JSON.stringify(out.body)); }
      if (out.pending) out.pending.catch(() => {});
      if (out.kick) setImmediate(() => estafeta.tick().catch((e) => estafeta.log('tick error', e.message)));
    } catch (e) {
      send(Number.isInteger(e.status) ? e.status : 500, { reason: e.message });
    }
  });
  await new Promise((r) => server.listen(port, host, r));
  return { server, close: () => new Promise((r) => server.close(r)) };
}
