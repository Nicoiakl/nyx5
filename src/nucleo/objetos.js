// Nyx5/1 — Almacén de OBJETOS de una casa: dónde vive un adjunto cifrado (NX-413).
//
// Es deliberadamente tonto: guarda bytes bajo una clave y los devuelve. Todo lo que es «sobre»
// (quién puede bajarlo, cuántos bytes, hasta cuándo) vive en los metadatos del almacén normal
// (`kv`, espacio `adjuntos`), y todo lo que es «contenido» (nombre, tipo, llave) viaja dentro
// del bloque cifrado del sobre y no llega nunca hasta aquí.
//
// Tres implementaciones, la misma interfaz async, igual que FileStore / D1Store:
//   ObjetosR2       Cloudflare R2 (producción; el binding lo pasa src/plataformas/worker.js)
//   ObjetosDisco    archivos (la casa local de un test, una demo o un desarrollo)
//   ObjetosMemoria  memoria (un test que no quiere tocar el disco)
//
// CONTRATO:
//   put(clave, bytes) -> void          get(clave) -> Buffer|Uint8Array|null
//   delete(clave)     -> void          claves()   -> [string]   (sólo lo usa el reloj; opcional)
//
// La clave la arma `claveObjeto(blobId)` en src/correo/adjuntos.js y es siempre `blobs/<uuid>`.
// NUNCA el nombre del archivo: un nombre trae `../` y además le dice a la casa qué hay dentro.

export class ObjetosMemoria {
  constructor() { this.m = new Map(); }
  async put(clave, bytes) { this.m.set(clave, Buffer.from(bytes)); }
  async get(clave) { return this.m.get(clave) ?? null; }
  async delete(clave) { this.m.delete(clave); }
  async claves() { return [...this.m.keys()]; }
}

export class ObjetosDisco {
  constructor(dir) { this.dir = dir; }
  // node:fs por import dinámico: este módulo carga limpio en el edge, donde se usa ObjetosR2.
  async _fs() { this.fs ||= await import('node:fs'); this.path ||= await import('node:path'); return this.fs; }
  // La clave ya está acotada a `blobs/<uuid>` por quien llama; aquí se vuelve a comprobar, porque
  // un almacén que escribe donde le digan es un traversal esperando a que alguien se confunda.
  _ruta(clave) {
    if (!/^blobs\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clave)) throw new Error(`clave de objeto inválida: ${JSON.stringify(String(clave).slice(0, 60))}`);
    return this.path.join(this.dir, clave.slice('blobs/'.length));
  }
  async put(clave, bytes) {
    const fs = await this._fs();
    const p = this._ruta(clave);
    fs.mkdirSync(this.path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, Buffer.from(bytes), { mode: 0o600 });
    fs.renameSync(tmp, p);
  }
  async get(clave) {
    const fs = await this._fs();
    const p = this._ruta(clave);
    return fs.existsSync(p) ? fs.readFileSync(p) : null;
  }
  async delete(clave) {
    const fs = await this._fs();
    const p = this._ruta(clave);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  async claves() {
    const fs = await this._fs();
    if (!fs.existsSync(this.dir)) return [];
    return fs.readdirSync(this.dir).filter((f) => !f.endsWith('.tmp')).map((f) => `blobs/${f}`);
  }
}

export class ObjetosR2 {
  constructor(bucket) { this.bucket = bucket; }
  async put(clave, bytes) { await this.bucket.put(clave, bytes); }
  async get(clave) {
    const o = await this.bucket.get(clave);
    if (!o) return null;
    return new Uint8Array(await o.arrayBuffer());
  }
  async delete(clave) { await this.bucket.delete(clave); }
  // R2 pagina; el reloj limpia por los METADATOS (kv), no recorriendo el bucket, así que esto
  // existe sólo para inspección y devuelve la primera página.
  async claves() {
    const l = await this.bucket.list({ prefix: 'blobs/', limit: 1000 });
    return (l.objects || []).map((o) => o.key);
  }
}
