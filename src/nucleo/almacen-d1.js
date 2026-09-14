// Nyx5/1 — D1Store: la misma interfaz que FileStore, sobre Cloudflare D1 (o el emulador
// d1-local.js en tests). Async real, y la atomicidad que FileStore le debe al proceso único
// aquí la dan las transacciones (db.batch) y las constraints del esquema (0002_nyx5.sql):
//   - un asiento concurrente con el mismo n -> el batch entero falla cerrado (PK diario.n)
//   - una op reentregada -> INSERT choca con PK ops.id y el Libro responde el resultado cacheado
//   - una cotización re-aceptada -> UNIQUE contratos.quote_id
// Los documentos se guardan como JSON íntegro (columna doc): los campos desconocidos sobreviven
// el roundtrip y las firmas siguen verificando (invariante 7).

import { LibroError } from '../libro/errores.js';
import { filaDeIndice, codificarCursor, CADUCO } from '../correo/indice.js';

const j = (v) => JSON.stringify(v);
const p = (row, col = 'doc') => (row ? JSON.parse(row[col]) : null);
const iso = () => new Date().toISOString();

export class D1Store {
  constructor(db) { this.db = db; }

  // --- dominio ---
  async getDomain() { return p(await this.db.prepare('SELECT doc FROM nyx5_domain WHERE id = 1').first()); }
  async putDomain(v) { await this.db.prepare('INSERT INTO nyx5_domain (id, doc) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET doc = excluded.doc').bind(j(v)).run(); }
  async putDomainIfAbsent(v) {
    const r = await this.db.prepare('INSERT OR IGNORE INTO nyx5_domain (id, doc) VALUES (1, ?)').bind(j(v)).run();
    return r.meta.changes === 1;
  }

  // --- agentes ---
  async getAgent(local) { return p(await this.db.prepare('SELECT doc FROM nyx5_agents WHERE local = ?').bind(local).first()); }
  async putAgent(local, v) { await this.db.prepare('INSERT INTO nyx5_agents (local, doc, updated) VALUES (?, ?, ?) ON CONFLICT(local) DO UPDATE SET doc = excluded.doc, updated = excluded.updated').bind(local, j(v), iso()).run(); }
  // Alta atómica: true si este llamador creó el nombre. Dos altas concurrentes del mismo nombre
  // ya no se pisan la clave (ni duplican el regalo de bienvenida).
  async putAgentIfAbsent(local, v) {
    const r = await this.db.prepare('INSERT OR IGNORE INTO nyx5_agents (local, doc, updated) VALUES (?, ?, ?)').bind(local, j(v), iso()).run();
    return r.meta.changes === 1;
  }
  async listAgents() { return (await this.db.prepare('SELECT local FROM nyx5_agents ORDER BY local').all()).results.map((r) => r.local); }

  // --- invitaciones ---
  async getInvite(code) { return p(await this.db.prepare('SELECT doc FROM nyx5_invitations WHERE code = ?').bind(code).first()); }
  async putInvite(inv) { await this.db.prepare('INSERT INTO nyx5_invitations (code, doc) VALUES (?, ?) ON CONFLICT(code) DO UPDATE SET doc = excluded.doc').bind(inv.code, j(inv)).run(); }
  async listInvites() { return (await this.db.prepare('SELECT doc FROM nyx5_invitations').all()).results.map((r) => JSON.parse(r.doc)); }
  // Consumo atómico de un uso: la condición viaja EN el UPDATE, así que diez canjes en paralelo
  // de una invitación de un uso dejan pasar exactamente uno.
  async consumeInvite(code, atIso) {
    const r = await this.db.prepare(`
      UPDATE nyx5_invitations
      SET doc = json_set(json_set(doc, '$.used', json_extract(doc, '$.used') + 1), '$.last_used', ?)
      WHERE code = ? AND json_extract(doc, '$.used') < json_extract(doc, '$.uses')`).bind(atIso, code).run();
    if (r.meta.changes !== 1) return null;
    return this.getInvite(code);
  }

  // --- deduplicación ---
  async getSeen(id) { return p(await this.db.prepare('SELECT doc FROM nyx5_seen WHERE id = ?').bind(id).first()); }
  async putSeen(id, rec) { await this.db.prepare('INSERT INTO nyx5_seen (id, doc) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET doc = excluded.doc').bind(id, j({ id, at: iso(), ...rec })).run(); }
  async markSeenIfNew(id, meta = {}) {
    const r = await this.db.prepare('INSERT OR IGNORE INTO nyx5_seen (id, doc) VALUES (?, ?)').bind(id, j({ id, at: iso(), ...meta })).run();
    return r.meta.changes === 1;
  }

  // --- buzones ---
  async putMail(local, envelope, meta = {}) {
    const received = iso();
    await this.db.prepare('INSERT INTO nyx5_mailbox (local, id, doc, received) VALUES (?, ?, ?, ?) ON CONFLICT(local, id) DO NOTHING')
      .bind(local, envelope.id, j({ ...meta, received, envelope }), received).run();
  }
  async listMail(local) {
    return (await this.db.prepare('SELECT doc FROM nyx5_mailbox WHERE local = ? AND acked IS NULL ORDER BY received, id').bind(local).all()).results.map((r) => JSON.parse(r.doc));
  }
  async ackMail(local, id) {
    const r = await this.db.prepare('UPDATE nyx5_mailbox SET acked = ? WHERE local = ? AND id = ? AND acked IS NULL').bind(iso(), local, id).run();
    return r.meta.changes === 1;
  }
  // Historial: lo pendiente y lo confirmado, los últimos N en orden de llegada (índice 0006).
  async listMailHistory(local, { limit = 200 } = {}) {
    const r = await this.db.prepare('SELECT doc, acked FROM nyx5_mailbox WHERE local = ? ORDER BY received DESC, id DESC LIMIT ?').bind(local, limit).all();
    return r.results.map((row) => ({ ...JSON.parse(row.doc), acked: row.acked || null })).reverse();
  }
  // Lo pendiente llegado después de un momento: la espera en tiempo real pregunta esto cada segundo,
  // así que filtra en SQL en vez de traer el buzón entero.
  async listMailSince(local, sinceIso) {
    return (await this.db.prepare('SELECT doc FROM nyx5_mailbox WHERE local = ? AND acked IS NULL AND received > ? ORDER BY received, id').bind(local, sinceIso || '').all()).results.map((r) => JSON.parse(r.doc));
  }

  // --- cola de salida ---
  _jobRow(job) { return [job.id, j(job), job.next_attempt, job.status, job.claimed_until || 0]; }
  async enqueue(job) {
    await this.db.prepare('INSERT INTO nyx5_queue (id, doc, next_attempt, status, claimed_until) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET doc = excluded.doc, next_attempt = excluded.next_attempt, status = excluded.status, claimed_until = excluded.claimed_until')
      .bind(...this._jobRow(job)).run();
  }
  async listQueue() { return (await this.db.prepare('SELECT doc FROM nyx5_queue').all()).results.map((r) => JSON.parse(r.doc)); }
  async updateJob(job) { await this.enqueue(job); }
  async removeJob(id) { await this.db.prepare('DELETE FROM nyx5_queue WHERE id = ?').bind(id).run(); }
  async claimDueJobs(nowMs, max = 20) {
    const nowIso = new Date(nowMs).toISOString();
    const until = nowMs + 60_000;
    // Reclamo atómico: un solo UPDATE marca y devuelve; dos ticks concurrentes no comparten trabajo.
    const r = await this.db.prepare(`
      UPDATE nyx5_queue SET status = 'inflight', claimed_until = ?
      WHERE id IN (
        SELECT id FROM nyx5_queue
        WHERE next_attempt <= ? AND (status IN ('queued','retrying') OR (status = 'inflight' AND claimed_until < ?))
        LIMIT ?
      ) RETURNING doc`).bind(until, nowIso, nowMs, max).all();
    return r.results.map((row) => { const job = JSON.parse(row.doc); job.status = 'inflight'; job.claimed_until = until; return job; });
  }

  // --- outbox ---
  async putOutbox(local, entry) {
    await this.db.prepare('INSERT INTO nyx5_outbox (local, job, doc) VALUES (?, ?, ?) ON CONFLICT(local, job) DO UPDATE SET doc = excluded.doc').bind(local, entry.job, j(entry)).run();
  }
  async listOutbox(local) { return (await this.db.prepare('SELECT doc FROM nyx5_outbox WHERE local = ?').bind(local).all()).results.map((r) => JSON.parse(r.doc)); }

  // --- nonces ---
  async useNonce(key, tsMs) {
    const r = await this.db.prepare('INSERT OR IGNORE INTO nyx5_nonces (key, ts) VALUES (?, ?)').bind(key, tsMs).run();
    return r.meta.changes === 1;
  }
  async pruneNonces(beforeMs) { await this.db.prepare('DELETE FROM nyx5_nonces WHERE ts < ?').bind(beforeMs).run(); }

  // --- kv con vencimiento (0006): clientes OAuth, códigos de un uso, tokens (hash) y la bóveda ---
  async kvGet(ns, key, nowMs = Date.now()) {
    return p(await this.db.prepare('SELECT doc FROM nyx5_kv WHERE ns = ? AND key = ? AND (expires IS NULL OR expires > ?)').bind(ns, key, nowMs).first());
  }
  async kvPut(ns, key, doc, expires = null) {
    await this.db.prepare('INSERT INTO nyx5_kv (ns, key, doc, expires, created) VALUES (?, ?, ?, ?, ?) ON CONFLICT(ns, key) DO UPDATE SET doc = excluded.doc, expires = excluded.expires')
      .bind(ns, key, j(doc), expires, iso()).run();
  }
  async kvPutIfAbsent(ns, key, doc, expires = null, nowMs = Date.now()) {
    await this.db.prepare('DELETE FROM nyx5_kv WHERE ns = ? AND key = ? AND expires IS NOT NULL AND expires <= ?').bind(ns, key, nowMs).run();
    const r = await this.db.prepare('INSERT OR IGNORE INTO nyx5_kv (ns, key, doc, expires, created) VALUES (?, ?, ?, ?, ?)').bind(ns, key, j(doc), expires, iso()).run();
    return r.meta.changes === 1;
  }
  // Tomar y borrar en UNA sentencia: dos canjes simultáneos del mismo código no pueden ganar los dos.
  async kvTake(ns, key, nowMs = Date.now()) {
    const r = await this.db.prepare('DELETE FROM nyx5_kv WHERE ns = ? AND key = ? RETURNING doc, expires').bind(ns, key).all();
    const row = r.results[0];
    if (!row || (row.expires != null && row.expires <= nowMs)) return null;
    return JSON.parse(row.doc);
  }
  // Contador atómico con vencimiento en UNA sentencia: dos isolates que suman a la vez no pierden
  // ninguna. Un contador ya vencido arranca de nuevo en 1 (la purga puede no haber pasado aún).
  async kvIncrement(ns, key, expires = null, nowMs = Date.now()) {
    const r = await this.db.prepare(`INSERT INTO nyx5_kv (ns, key, doc, expires, created) VALUES (?, ?, '1', ?, ?)
      ON CONFLICT(ns, key) DO UPDATE SET
        doc = CASE WHEN nyx5_kv.expires IS NOT NULL AND nyx5_kv.expires <= ? THEN '1' ELSE CAST(CAST(nyx5_kv.doc AS INTEGER) + 1 AS TEXT) END,
        expires = excluded.expires
      RETURNING doc`).bind(ns, key, expires, iso(), nowMs).all();
    return Number(r.results[0].doc);
  }
  async kvDelete(ns, key) { await this.db.prepare('DELETE FROM nyx5_kv WHERE ns = ? AND key = ?').bind(ns, key).run(); }
  async kvPurge(nowMs = Date.now()) { await this.db.prepare('DELETE FROM nyx5_kv WHERE expires IS NOT NULL AND expires <= ?').bind(nowMs).run(); }

  // --- pins (una fila por dominio: el primero gana y ningún isolate pisa lo que otro aprendió) ---
  async getPins() {
    const r = await this.db.prepare('SELECT domain, kid FROM nyx5_pin').all();
    return Object.fromEntries(r.results.map((x) => [x.domain, x.kid]));
  }
  async putPin(domain, kid) {
    const r = await this.db.prepare('INSERT OR IGNORE INTO nyx5_pin (domain, kid, at) VALUES (?, ?, ?)').bind(domain, kid, iso()).run();
    return r.meta.changes === 1;
  }
  // Compat: recibe el mapa completo pero NUNCA borra; cada pin se agrega si no existía.
  async putPins(v) { for (const [d, k] of Object.entries(v || {})) await this.putPin(d, k); }

  // ===== Libro =====
  async libroState() {
    const row = await this.db.prepare('SELECT seq, balances FROM nyx5_libro_state WHERE id = 1').first();
    return row ? { seq: row.seq, balances: JSON.parse(row.balances) } : { seq: 0, balances: {} };
  }
  async libroPutState(v) { await this.db.prepare('UPDATE nyx5_libro_state SET seq = ?, balances = ? WHERE id = 1').bind(v.seq, j(v.balances)).run(); }
  async libroAppend(asiento) { await this.db.batch(this._asientoStmts(asiento)); }
  _asientoStmts(asiento) {
    return [
      this.db.prepare('INSERT INTO nyx5_libro_diario (n, id, doc) VALUES (?, ?, ?)').bind(asiento.n, asiento.id, j(asiento)),
      ...asiento.lines.map((l) => this.db.prepare('INSERT INTO nyx5_libro_lineas (n, account, delta) VALUES (?, ?, ?)').bind(asiento.n, l.account, l.delta)),
    ];
  }
  async libroJournal() { return (await this.db.prepare('SELECT doc FROM nyx5_libro_diario ORDER BY n').all()).results.map((r) => JSON.parse(r.doc)); }
  async libroGetContract(id) { return p(await this.db.prepare('SELECT doc FROM nyx5_libro_contratos WHERE id = ?').bind(id).first()); }
  _contractStmt(c) {
    return this.db.prepare('INSERT INTO nyx5_libro_contratos (id, quote_id, doc) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET doc = excluded.doc, quote_id = excluded.quote_id').bind(c.id, c.quote_id || null, j(c));
  }
  async libroPutContract(c) { await this._contractStmt(c).run(); }
  async libroListContracts() { return (await this.db.prepare('SELECT doc FROM nyx5_libro_contratos').all()).results.map((r) => JSON.parse(r.doc)); }
  async libroFindContractByQuote(quoteId) { return p(await this.db.prepare('SELECT doc FROM nyx5_libro_contratos WHERE quote_id = ?').bind(quoteId).first()); }
  async libroGetMandate(id) { return p(await this.db.prepare('SELECT doc FROM nyx5_libro_mandatos WHERE id = ?').bind(id).first()); }
  _mandateStmt(m) { return this.db.prepare('INSERT INTO nyx5_libro_mandatos (id, doc) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET doc = excluded.doc').bind(m.id, j(m)); }
  async libroPutMandate(m) { await this._mandateStmt(m).run(); }
  async libroListMandates() { return (await this.db.prepare('SELECT doc FROM nyx5_libro_mandatos').all()).results.map((r) => JSON.parse(r.doc)); }
  async libroGetOp(id) { return p(await this.db.prepare('SELECT doc FROM nyx5_libro_ops WHERE id = ?').bind(id).first()); }
  async libroPutOp(id, v) { await this.db.prepare('INSERT INTO nyx5_libro_ops (id, doc) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET doc = excluded.doc').bind(id, j(v)).run(); }

  // --- notaría (NX-601): sellos de hash (migrations/0008_notaria.sql) ---
  async notariaGet(id) { return p(await this.db.prepare('SELECT doc FROM nyx5_notaria WHERE id = ?').bind(id).first()); }
  async notariaList(sha256) { return (await this.db.prepare('SELECT doc FROM nyx5_notaria WHERE sha256 = ? ORDER BY at, id').bind(sha256).all()).results.map((r) => JSON.parse(r.doc)); }
  async notariaFind(sha256, by) { return p(await this.db.prepare('SELECT doc FROM nyx5_notaria WHERE sha256 = ? AND "by" = ?').bind(sha256, by).first()); }
  // Sin ON CONFLICT a propósito: el índice único (sha256, by) es el candado, y un choque tiene
  // que tirar el batch entero (421 reintentable), no pisar el sello anterior en silencio.
  _selloStmt(s) { return this.db.prepare('INSERT INTO nyx5_notaria (id, sha256, "by", at, doc) VALUES (?, ?, ?, ?, ?)').bind(s.id, s.sha256, s.by, s.at, j(s)); }
  async notariaPut(s) { try { await this._selloStmt(s).run(); } catch (e) { throw this._traducirConflicto(e); } }
  // ---------- instrumentación ----------
  async putEvent(e) { await this.db.prepare('INSERT OR IGNORE INTO nyx5_eventos (id, name, ts, actor, data) VALUES (?, ?, ?, ?, ?)').bind(e.id, e.name, e.ts, e.actor || null, j(e.data || {})).run(); }
  async listEvents({ name = null, since = null, limit = 500 } = {}) {
    const cond = ['1 = 1']; const bind = [];
    if (name) { cond.push('name = ?'); bind.push(name); }
    if (since) { cond.push('ts >= ?'); bind.push(since); }
    const r = await this.db.prepare(`SELECT id, name, ts, actor, data FROM nyx5_eventos WHERE ${cond.join(' AND ')} ORDER BY ts DESC LIMIT ?`).bind(...bind, Number(limit)).all();
    return r.results.map((x) => ({ ...x, data: JSON.parse(x.data) })).reverse();
  }
  // Extracto por cuenta en [since, until) sobre `at` del asiento (json_extract sobre el doc: la
  // fecha ya vive ahí, sin migración). Los `limit` más recientes y el total del rango.
  _statementWhere(account, since, until) {
    const cond = ['n IN (SELECT DISTINCT n FROM nyx5_libro_lineas WHERE account = ?)']; const binds = [account];
    if (since) { cond.push("json_extract(doc, '$.at') >= ?"); binds.push(since); }
    if (until) { cond.push("json_extract(doc, '$.at') < ?"); binds.push(until); }
    return { where: cond.join(' AND '), binds };
  }
  async libroStatementRange(account, { since = null, until = null, limit = 20 } = {}) {
    const { where, binds } = this._statementWhere(account, since, until);
    const total = Number((await this.db.prepare(`SELECT COUNT(*) AS c FROM nyx5_libro_diario WHERE ${where}`).bind(...binds).first())?.c || 0);
    const r = await this.db.prepare(`SELECT doc FROM nyx5_libro_diario WHERE ${where} ORDER BY n DESC LIMIT ?`).bind(...binds, limit).all();
    return { entries: r.results.map((row) => JSON.parse(row.doc)).reverse(), total };
  }
  async libroStatement(account, limit) { return (await this.libroStatementRange(account, { limit })).entries; }
  // Saldo de una cuenta antes del asiento `n` y/o de la fecha `at`, sumado de las líneas.
  async libroBalanceBefore(account, { n = null, at = null } = {}) {
    const cond = ['l.account = ?']; const binds = [account];
    if (n != null) { cond.push('l.n < ?'); binds.push(n); }
    if (at != null) { cond.push("json_extract(d.doc, '$.at') < ?"); binds.push(at); }
    const row = await this.db.prepare(`SELECT COALESCE(SUM(l.delta), 0) AS s FROM nyx5_libro_lineas l JOIN nyx5_libro_diario d ON d.n = l.n WHERE ${cond.join(' AND ')}`).bind(...binds).first();
    return Number(row?.s || 0);
  }

  // Un movimiento del Libro, atómico. El orden importa: el diario va primero (PK n = candado
  // optimista del ledger entero) para que un conflicto aborte el batch antes de tocar nada más.
  _libroCommitStmts(bundle) {
    const stmts = [];
    for (const a of bundle.asientos || []) stmts.push(...this._asientoStmts(a));
    if (bundle.state) stmts.push(this.db.prepare('UPDATE nyx5_libro_state SET seq = ?, balances = ? WHERE id = 1').bind(bundle.state.seq, j(bundle.state.balances)));
    for (const c of bundle.contracts || []) stmts.push(this._contractStmt(c));
    for (const m of bundle.mandates || []) stmts.push(this._mandateStmt(m));
    for (const s of bundle.sellos || []) stmts.push(this._selloStmt(s));
    if (bundle.op) stmts.push(this.db.prepare('INSERT INTO nyx5_libro_ops (id, doc) VALUES (?, ?)').bind(bundle.op.id, j(bundle.op.result)));
    return stmts;
  }
  async libroCommit(bundle) {
    const stmts = this._libroCommitStmts(bundle);
    if (!stmts.length) return;
    try { await this.db.batch(stmts); }
    catch (e) { throw this._traducirConflicto(e); }
  }

  // La entrega de un sobre entera, en un batch: dedupe + buzones + estampillas.
  async inboundCommit(bundle) {
    const stmts = [];
    for (const lb of bundle.libro || []) stmts.push(...this._libroCommitStmts(lb));
    for (const m of bundle.mails || []) {
      const received = iso();
      stmts.push(this.db.prepare('INSERT INTO nyx5_mailbox (local, id, doc, received) VALUES (?, ?, ?, ?) ON CONFLICT(local, id) DO NOTHING')
        .bind(m.local, m.envelope.id, j({ ...m.meta, received, envelope: m.envelope }), received));
    }
    if (bundle.seen) stmts.push(this.db.prepare('INSERT INTO nyx5_seen (id, doc) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET doc = excluded.doc')
      .bind(bundle.seen.id, j({ id: bundle.seen.id, at: iso(), ...bundle.seen.rec })));
    if (!stmts.length) return;
    try { await this.db.batch(stmts); }
    catch (e) { throw this._traducirConflicto(e); }
  }

  _traducirConflicto(e) {
    // Un choque de constraint es concurrencia legítima, no un rechazo del contenido: se responde
    // 421 (temporal, en la lista RETRYABLE de la estafeta) para que el correo lo reintente y la
    // segunda pasada gane o vea el resultado ya cacheado. Con 409 el sobre se rebotaba como
    // fallo permanente y la operación válida se perdía.
    if (/UNIQUE|PRIMARY KEY|constraint/i.test(String(e?.message))) {
      return Object.assign(new LibroError(421, `conflicto de concurrencia en el ledger, reintentable: ${e.message}`), { transient: true });
    }
    return e;
  }

  // ===== Índice federado =====
  async indexGetHouse(domain) { return p(await this.db.prepare('SELECT doc FROM nyx5_indice_casas WHERE domain = ?').bind(domain).first()); }
  async indexPutHouse(h) { await this.db.prepare('INSERT INTO nyx5_indice_casas (domain, doc) VALUES (?, ?) ON CONFLICT(domain) DO UPDATE SET doc = excluded.doc').bind(h.domain, j(h)).run(); }
  async indexListHouses() { return (await this.db.prepare('SELECT doc FROM nyx5_indice_casas').all()).results.map((r) => JSON.parse(r.doc)); }
  // Reemplazo por casa con generación: cada fila conserva un historial corto de sus puntajes
  // (hist, first_gen) para que un recorrido por cursor no repita ni salte a quien cambió de
  // puntaje entre página y página (cabecera de src/correo/indice.js).
  async indexReplaceAgents(domain, cards) {
    const previas = (await this.db.prepare('SELECT address, first_gen, hist FROM nyx5_indice_agentes WHERE house = ?').bind(domain).all()).results;
    const previo = new Map(previas.map((r) => [r.address, { first_gen: r.first_gen, hist: JSON.parse(r.hist || '[]') }]));
    const gen = ((await this.db.prepare('SELECT COALESCE(MAX(gen), 0) AS g FROM nyx5_indice_agentes').first()).g || 0) + 1;
    await this.db.batch([
      this.db.prepare('DELETE FROM nyx5_indice_agentes WHERE house = ?').bind(domain),
      ...cards.map((c) => {
        const r = filaDeIndice(domain, c, gen, previo.get(c.address) || null);
        return this.db.prepare('INSERT INTO nyx5_indice_agentes (house, address, doc, tags, langs, price_min, score, jobs_done, gen, first_gen, hist) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(domain, c.address, j(c), j(r.tags), j(r.langs), r.price_min, r.score, r.jobs_done, r.gen, r.first_gen, j(r.hist));
      }),
    ]);
  }
  // La misma búsqueda que buscarEnMemoria (indice.js), en SQL. `g` va como literal entero (ya
  // validado como entero seguro) porque la clave de orden aparece varias veces en la consulta.
  async indexSearch(f = {}) {
    const gActual = (await this.db.prepare('SELECT COALESCE(MAX(gen), 0) AS g FROM nyx5_indice_agentes').first()).g || 0;
    if (f.cursor && f.cursor.g > gActual) throw Object.assign(new Error('invalid cursor: it names a generation of the index that does not exist'), { status: 400 });
    const g = f.cursor ? f.cursor.g : gActual;
    if (!Number.isSafeInteger(g) || g < 0) throw Object.assign(new Error('invalid cursor'), { status: 400 });
    // El puntaje congelado en g: la última entrada del historial con generación <= g; NULL si la
    // dirección entró al índice después de g (claveCongelada, en indice.js, es la referencia).
    const ULT = `(SELECT json_extract(e.value, '$.s') FROM json_each(hist) e WHERE json_extract(e.value, '$.g') <= ${g} ORDER BY json_extract(e.value, '$.g') DESC LIMIT 1)`;
    const K = `(CASE WHEN first_gen > ${g} THEN NULL ELSE ${ULT} END)`;
    const where = []; const binds = [];
    if (f.house) { where.push('house = ?'); binds.push(f.house); }
    if (f.capability) { where.push("json_extract(doc, '$.capabilities.' || ?) IS NOT NULL"); binds.push(f.capability); }
    if (f.accepts) { where.push("EXISTS (SELECT 1 FROM json_each(doc, '$.capabilities.accepts') WHERE value = ?)"); binds.push(f.accepts); }
    if (f.tag) { where.push('EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)'); binds.push(f.tag); }
    if (f.lang) { where.push("EXISTS (SELECT 1 FROM json_each(langs) WHERE value = ? OR value LIKE ? || '-%')"); binds.push(f.lang, f.lang); }
    if (f.price_max != null) { where.push('price_min IS NOT NULL AND price_min <= ?'); binds.push(f.price_max); }
    if (f.q) { where.push('lower(doc) LIKE ?'); binds.push(`%${String(f.q).toLowerCase()}%`); }
    const wBase = where.length ? `WHERE ${where.join(' AND ')}` : '';
    if (f.cursor) {
      // Caduco: una fila que ya existía en g y cuyo historial no conserva ninguna entrada <= g.
      const caduco = (await this.db.prepare(`SELECT COUNT(*) AS c FROM nyx5_indice_agentes ${wBase} ${where.length ? 'AND' : 'WHERE'} first_gen <= ${g} AND NOT EXISTS (SELECT 1 FROM json_each(hist) e WHERE json_extract(e.value, '$.g') <= ${g})`).bind(...binds).first()).c;
      if (caduco > 0) throw Object.assign(new Error(CADUCO), { status: 410 });
    }
    if (f.min_score != null) { where.push(`${K} >= ?`); binds.push(f.min_score); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (await this.db.prepare(`SELECT COUNT(*) AS c FROM nyx5_indice_agentes ${w}`).bind(...binds).first()).c;
    const keyset = []; const kb = [];
    if (f.cursor) {
      if (f.cursor.s == null) { keyset.push(`${K} IS NULL AND address > ?`); kb.push(f.cursor.a); }
      else { keyset.push(`(${K} < ? OR (${K} = ? AND address > ?) OR ${K} IS NULL)`); kb.push(f.cursor.s, f.cursor.s, f.cursor.a); }
    }
    const wPag = [...where, ...keyset].length ? `WHERE ${[...where, ...keyset].join(' AND ')}` : '';
    const rows = (await this.db.prepare(`SELECT address, ${K} AS k, doc FROM nyx5_indice_agentes ${wPag} ORDER BY k DESC NULLS LAST, address ASC LIMIT ?`).bind(...binds, ...kb, f.limit + 1).all()).results;
    const pagina = rows.slice(0, f.limit);
    const ultima = pagina[pagina.length - 1];
    const next_cursor = rows.length > f.limit ? codificarCursor({ s: ultima.k ?? null, a: ultima.address, g }) : null;
    return { total, agents: pagina.map((r) => JSON.parse(r.doc)), next_cursor };
  }
}
