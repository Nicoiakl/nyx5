// Nyx5/1 — Almacenamiento de una estafeta (Correo) y su Libro en archivos JSON.
// Es deliberadamente simple e inspeccionable. En producción se reemplaza por una clase con la
// misma interfaz sobre D1/Postgres (ver almacen-d1.js y docs/ARQUITECTURA.md).
//
// CONTRATO: la interfaz es async — todo método puede devolver Promise y los llamadores hacen
// await siempre. FileStore implementa en síncrono (un solo proceso Node: sin carreras); D1Store
// implementa en async real y da la atomicidad por transacción donde aquí la da el proceso único.
//
// Operaciones compuestas del contrato (las que en D1 son una transacción):
//   markSeenIfNew(id, meta)  -> boolean   dedupe atómico de sobres
//   claimDueJobs(nowMs, max) -> jobs[]    reclamo exclusivo de trabajos de la cola
//   useNonce(key, ts)        -> boolean   anti-replay de tokens de auth
//   libroCommit(bundle)                   un asiento del Libro con todo lo que lo acompaña
//   inboundCommit(bundle)                 la entrega de un sobre: seen + buzones + Libro, junto

import fs from 'node:fs';
import path from 'node:path';

const readJson = (p, fallback = null) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : fallback);
const writeJson = (p, v) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2));
  fs.renameSync(tmp, p);
};

export class FileStore {
  constructor(dir) {
    this.dir = dir;
    for (const d of ['agents', 'mailbox', 'queue', 'outbox', 'invitations', 'libro/diario', 'libro/contratos', 'libro/mandatos', 'libro/ops', 'eventos', 'indice/casas', 'indice/agentes']) fs.mkdirSync(path.join(dir, d), { recursive: true });
    this.nonces = new Map(); // anti-replay: en FileStore basta memoria (un proceso)
  }

  // --- dominio ---
  getDomain() { return readJson(path.join(this.dir, 'domain.json')); }
  putDomain(v) { writeJson(path.join(this.dir, 'domain.json'), v); }

  // --- agentes ---
  getAgent(local) { return readJson(path.join(this.dir, 'agents', `${local}.json`)); }
  putAgent(local, v) { writeJson(path.join(this.dir, 'agents', `${local}.json`), v); }
  putAgentIfAbsent(local, v) {
    if (this.getAgent(local)) return false;
    this.putAgent(local, v);
    return true;
  }
  listAgents() { return fs.readdirSync(path.join(this.dir, 'agents')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)); }

  // --- invitaciones de registro ---
  getInvite(code) { return readJson(path.join(this.dir, 'invitations', `${code}.json`)); }
  putInvite(inv) { writeJson(path.join(this.dir, 'invitations', `${inv.code}.json`), inv); }
  listInvites() { const d = path.join(this.dir, 'invitations'); return fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(d, f))); }
  // Consumo de un uso, condicional: misma semántica que el UPDATE atómico de D1.
  consumeInvite(code, atIso) {
    const inv = this.getInvite(code);
    if (!inv || inv.used >= inv.uses) return null;
    inv.used += 1; inv.last_used = atIso;
    this.putInvite(inv);
    return inv;
  }

  // --- deduplicación de sobres recibidos ---
  getSeen(id) { return readJson(path.join(this.dir, 'seen', `${id}.json`)); }
  putSeen(id, rec) { writeJson(path.join(this.dir, 'seen', `${id}.json`), { id, at: new Date().toISOString(), ...rec }); }
  // Dedupe atómico: true si es la primera vez. En D1: INSERT con PK y changes === 1.
  markSeenIfNew(id, meta = {}) {
    if (this.getSeen(id)) return false;
    this.putSeen(id, meta);
    return true;
  }

  // --- buzones ---
  putMail(local, envelope, meta = {}) {
    // `received` es del sistema: la meta no puede pisarlo.
    writeJson(path.join(this.dir, 'mailbox', local, `${envelope.id}.json`), { ...meta, received: new Date().toISOString(), envelope });
  }
  listMail(local) {
    const dir = path.join(this.dir, 'mailbox', local);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(dir, f)))
      .sort((a, b) => String(a.received).localeCompare(String(b.received)));
  }
  ackMail(local, id) {
    const p = path.join(this.dir, 'mailbox', local, `${id}.json`);
    if (!fs.existsSync(p)) return false;
    const archived = path.join(this.dir, 'archive', local, `${id}.json`);
    fs.mkdirSync(path.dirname(archived), { recursive: true });
    fs.renameSync(p, archived);
    return true;
  }
  // Historial: lo pendiente y lo ya confirmado (archivado), en orden de llegada, los últimos N.
  listMailHistory(local, { limit = 200 } = {}) {
    const leer = (d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(d, f))) : []);
    const vivos = leer(path.join(this.dir, 'mailbox', local));
    const archivados = leer(path.join(this.dir, 'archive', local)).map((m) => ({ ...m, acked: m.acked || true }));
    return [...vivos, ...archivados].sort((a, b) => String(a.received).localeCompare(String(b.received))).slice(-limit);
  }
  // Lo pendiente que llegó después de un momento dado (la espera en tiempo real pregunta esto).
  listMailSince(local, sinceIso) { return this.listMail(local).filter((m) => !sinceIso || String(m.received) > sinceIso); }

  // --- cola de salida (store-and-forward) ---
  enqueue(job) { writeJson(path.join(this.dir, 'queue', `${job.id}.json`), job); }
  listQueue() { return fs.readdirSync(path.join(this.dir, 'queue')).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(this.dir, 'queue', f))); }
  updateJob(job) { this.enqueue(job); }
  removeJob(id) { const p = path.join(this.dir, 'queue', `${id}.json`); if (fs.existsSync(p)) fs.unlinkSync(p); }
  // Reclamo exclusivo: devuelve los trabajos vencidos y los marca en vuelo con un plazo.
  // En D1 es un solo UPDATE ... RETURNING; aquí, el proceso único lo hace seguro.
  claimDueJobs(nowMs, max = 20) {
    const due = this.listQueue().filter((j) =>
      Date.parse(j.next_attempt) <= nowMs &&
      (j.status === 'queued' || j.status === 'retrying' || (j.status === 'inflight' && (j.claimed_until || 0) < nowMs)))
      .slice(0, max);
    for (const j of due) { j.status = 'inflight'; j.claimed_until = nowMs + 60_000; this.updateJob(j); }
    return due;
  }

  // --- historial de salida por agente (estado de cada envío) ---
  putOutbox(local, entry) { writeJson(path.join(this.dir, 'outbox', local, `${entry.job}.json`), entry); }
  listOutbox(local) {
    const dir = path.join(this.dir, 'outbox', local);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(dir, f)));
  }

  // --- kv con vencimiento: clientes OAuth, códigos de un uso, tokens (hash) y la bóveda ---
  _kvPath(ns, key) { return path.join(this.dir, 'kv', ns, `${encodeURIComponent(key)}.json`); }
  kvGet(ns, key, nowMs = Date.now()) {
    const r = readJson(this._kvPath(ns, key));
    if (!r || (r.expires != null && r.expires <= nowMs)) return null;
    return r.doc;
  }
  kvPut(ns, key, doc, expires = null) { writeJson(this._kvPath(ns, key), { doc, expires, created: new Date().toISOString() }); }
  kvPutIfAbsent(ns, key, doc, expires = null, nowMs = Date.now()) {
    if (this.kvGet(ns, key, nowMs) !== null) return false;
    this.kvPut(ns, key, doc, expires);
    return true;
  }
  // Tomar y borrar en un paso: un código de autorización se usa UNA vez.
  kvTake(ns, key, nowMs = Date.now()) {
    const p = this._kvPath(ns, key);
    const r = readJson(p);
    if (!r) return null;
    fs.unlinkSync(p);
    return (r.expires != null && r.expires <= nowMs) ? null : r.doc;
  }
  // Contador atómico con vencimiento (límites de tasa durables). Un contador vencido arranca en 1.
  kvIncrement(ns, key, expires = null, nowMs = Date.now()) {
    const n = (Number(this.kvGet(ns, key, nowMs)) || 0) + 1;
    this.kvPut(ns, key, n, expires);
    return n;
  }
  kvDelete(ns, key) { const p = this._kvPath(ns, key); if (fs.existsSync(p)) fs.unlinkSync(p); }
  kvPurge(nowMs = Date.now()) {
    const raiz = path.join(this.dir, 'kv');
    if (!fs.existsSync(raiz)) return;
    for (const ns of fs.readdirSync(raiz)) {
      for (const f of fs.readdirSync(path.join(raiz, ns))) {
        const p = path.join(raiz, ns, f);
        const r = readJson(p);
        if (r?.expires != null && r.expires <= nowMs) fs.unlinkSync(p);
      }
    }
  }

  // --- anti-replay de tokens de auth ---
  useNonce(key, tsMs) {
    if (this.nonces.has(key)) return false;
    this.nonces.set(key, tsMs);
    if (this.nonces.size > 10_000) { const cut = Date.now() - 600_000; for (const [k, t] of this.nonces) if (t < cut) this.nonces.delete(k); }
    return true;
  }
  pruneNonces(beforeMs) { for (const [k, t] of this.nonces) if (t < beforeMs) this.nonces.delete(k); }

  // --- pins de claves de dominios ajenos (TOFU) ---
  getPins() { return readJson(path.join(this.dir, 'pins.json'), {}); }
  // TOFU: el primer pin de un dominio manda; putPins agrega, nunca borra lo que otro aprendió.
  putPin(domain, kid) {
    const pins = this.getPins();
    if (pins[domain]) return false;
    pins[domain] = kid;
    writeJson(path.join(this.dir, 'pins.json'), pins);
    return true;
  }
  putPins(v) { for (const [d, k] of Object.entries(v || {})) this.putPin(d, k); }

  // ===== Libro (ledger de doble entrada) =====
  // saldos.json = { seq: <último asiento>, balances: { cuenta: saldo } }
  libroState() { return readJson(path.join(this.dir, 'libro', 'saldos.json'), { seq: 0, balances: {} }); }
  libroPutState(v) { writeJson(path.join(this.dir, 'libro', 'saldos.json'), v); }
  libroAppend(asiento) { writeJson(path.join(this.dir, 'libro', 'diario', `${String(asiento.n).padStart(12, '0')}.json`), asiento); }
  libroJournal() {
    const dir = path.join(this.dir, 'libro', 'diario');
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(dir, f))).sort((a, b) => a.n - b.n);
  }
  libroGetContract(id) { return readJson(path.join(this.dir, 'libro', 'contratos', `${id}.json`)); }
  libroPutContract(c) { writeJson(path.join(this.dir, 'libro', 'contratos', `${c.id}.json`), c); }
  libroListContracts() { const d = path.join(this.dir, 'libro', 'contratos'); return fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(d, f))); }
  libroFindContractByQuote(quoteId) { return this.libroListContracts().find((c) => c.quote_id === quoteId) || null; }
  libroGetMandate(id) { return readJson(path.join(this.dir, 'libro', 'mandatos', `${id}.json`)); }
  libroPutMandate(m) { writeJson(path.join(this.dir, 'libro', 'mandatos', `${m.id}.json`), m); }
  libroListMandates() { const d = path.join(this.dir, 'libro', 'mandatos'); return fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(d, f))); }
  libroGetOp(id) { return readJson(path.join(this.dir, 'libro', 'ops', `${id}.json`)); }
  libroPutOp(id, v) { writeJson(path.join(this.dir, 'libro', 'ops', `${id}.json`), v); }
  // ---------- instrumentación (nombre, fecha, actor y números; nunca contenido) ----------
  putEvent(e) { writeJson(path.join(this.dir, 'eventos', `${e.id}.json`), e); }
  listEvents({ name = null, since = null, limit = 500 } = {}) {
    const d = path.join(this.dir, 'eventos');
    if (!fs.existsSync(d)) return [];
    return fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(d, f)))
      .filter((e) => e && (!name || e.name === name) && (!since || e.ts >= since))
      .sort((a, b) => (a.ts < b.ts ? -1 : 1)).slice(-limit);
  }
  // Extracto por cuenta en el rango [since, until) sobre `at` (ISO ya normalizado por quien
  // llama, ver estado.js): los `limit` asientos MÁS RECIENTES del rango, y `total` = cuántos hay
  // en el rango, se muestren o no (el denominador viaja con el resultado).
  libroStatementRange(account, { since = null, until = null, limit = 20 } = {}) {
    const todos = this.libroJournal().filter((a) => a.lines.some((l) => l.account === account) && (!since || a.at >= since) && (!until || a.at < until));
    return { entries: todos.slice(-limit), total: todos.length };
  }
  libroStatement(account, limit) { return this.libroStatementRange(account, { limit }).entries; }
  // Saldo de una cuenta ANTES del asiento `n` y/o de la fecha `at`: la suma de sus deltas hasta
  // ahí, leída del diario y no de saldos.json, para que un extracto cuadre por sí mismo.
  libroBalanceBefore(account, { n = null, at = null } = {}) {
    return this.libroJournal()
      .filter((a) => (n == null || a.n < n) && (at == null || a.at < at))
      .reduce((s, a) => s + a.lines.filter((l) => l.account === account).reduce((t, l) => t + l.delta, 0), 0);
  }

  // Un movimiento completo del Libro, junto. En D1: un batch atómico donde el PK del asiento (n)
  // y el PK de la op (id de sobre) hacen fallar cerrado la concurrencia y la reentrega.
  // bundle = { state, asientos: [], contracts: [], mandates: [], op: { id, result } | null }
  libroCommit(bundle) {
    // Mismo candado que D1: si otra operación cometió desde que ésta leyó el estado, el número de
    // asiento ya está tomado y esto falla cerrado en vez de pisar. Sin esto, FileStore sería más
    // permisivo que producción y un defecto de concurrencia no se vería en las pruebas locales.
    if (bundle.base) {
      const actual = this.libroState();
      if (actual.seq !== bundle.base.seq) {
        const e = new Error(`ledger concurrency conflict: state moved (seq ${bundle.base.seq} -> ${actual.seq})`);
        e.code = 421; e.transient = true;
        throw e;
      }
    }
    for (const a of bundle.asientos || []) this.libroAppend(a);
    if (bundle.state) this.libroPutState(bundle.state);
    for (const c of bundle.contracts || []) this.libroPutContract(c);
    for (const m of bundle.mandates || []) this.libroPutMandate(m);
    if (bundle.op) this.libroPutOp(bundle.op.id, bundle.op.result);
  }

  // La entrega de un sobre entero, junta: dedupe + buzones + movimientos del Libro (estampillas, ops).
  // bundle = { seen: { id, rec } | null, mails: [{ local, envelope, meta }], libro: [libroBundle...] }
  inboundCommit(bundle) {
    for (const m of bundle.mails || []) this.putMail(m.local, m.envelope, m.meta);
    for (const lb of bundle.libro || []) this.libroCommit(lb);
    if (bundle.seen) this.putSeen(bundle.seen.id, bundle.seen.rec);
  }

  // ===== Índice federado (opcional: solo casas que corren un índice) =====
  indexGetHouse(domain) { return readJson(path.join(this.dir, 'indice', 'casas', `${domain}.json`)); }
  indexPutHouse(h) { writeJson(path.join(this.dir, 'indice', 'casas', `${h.domain}.json`), h); }
  indexListHouses() { const d = path.join(this.dir, 'indice', 'casas'); return fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(d, f))); }
  indexReplaceAgents(domain, cards) { writeJson(path.join(this.dir, 'indice', 'agentes', `${domain}.json`), { domain, cards, updated: new Date().toISOString() }); }
  indexSearch({ q, capability, accepts, house, limit = 50, offset = 0 } = {}) {
    const d = path.join(this.dir, 'indice', 'agentes');
    let cards = fs.readdirSync(d).filter((f) => f.endsWith('.json'))
      .filter((f) => !house || f === `${house}.json`)
      .flatMap((f) => (readJson(path.join(d, f))?.cards || []));
    if (capability) cards = cards.filter((c) => c.capabilities?.[capability]);
    if (accepts) cards = cards.filter((c) => c.capabilities?.accepts?.includes(accepts));
    if (q) { const needle = String(q).toLowerCase(); cards = cards.filter((c) => c.address.includes(needle) || JSON.stringify(c.capabilities || {}).toLowerCase().includes(needle)); }
    return { total: cards.length, offset, agents: cards.slice(offset, offset + limit) };
  }
}
