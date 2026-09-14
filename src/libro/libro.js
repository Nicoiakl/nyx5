// Nyx5/1 — Libro: el ledger de doble entrada de una casa (dominio).
//
// El Libro es el segundo componente del sistema; el primero es el Correo. No tiene login propio:
// toda operación llega como un sobre firmado a `libro@<dominio>`, y la identidad del remitente ya
// viene verificada por la cadena de confianza del Correo. El Libro solo decide si la operación es
// válida (partes, estado, saldo) y ejecuta el asiento.
//
// Kernel: siete primitivas y nada más. Los contratos (contratos.js) se componen encima.
//   1. cotizar   -> no toca el libro: es un documento firmado por el vendedor (verifyQuote lo valida)
//   2. cobrar    -> transfer(de, a, monto)  con reparto de fee a la casa
//   3. retener   -> hold(de, escrow, monto)
//   4. liberar   -> release(escrow, a, monto) con fee
//   5. devolver  -> refund(escrow, a, monto) sin fee
//   6. repartir  -> post() con N líneas que suman cero (el fee de la casa es un reparto)
//   7. afianzar  -> hold() con condición de salida distinta (forfeit / release)
// Transversales: idempotencia (por id de sobre) y meta (contexto legible por máquina en cada asiento).
//
// Cuentas: `agente@dominio` (cualquier agente verificable, de esta casa o de otra), `casa@<dominio>`
// (la distribuidora: emite tokens, cobra fees; es la única que puede quedar en negativo) y
// `escrow:<contrato>` (fondos retenidos). Un asiento es una lista de líneas {cuenta, delta} que suman 0.
//
// ESCRITURAS: cada operación acumula sus escrituras en una transacción (this.tx) y el llamador la
// sella con commit() -> store.libroCommit(bundle). En FileStore el commit es secuencial (proceso
// único); en D1 es un batch atómico donde el número de asiento y el id de la op son claves únicas:
// dos operaciones concurrentes no pueden duplicar un asiento ni descuadrar los saldos — la segunda
// falla cerrado y el correo la reintenta.

import { signObject, verifyObject, canonical, sha256hex, uuid } from '../nucleo/crypto.js';
import { Resolver, parseAddress } from '../correo/resolver.js';
import { CONTRATOS } from './contratos.js';
import { boletaDe } from './estado.js';
import { LibroError } from './errores.js';
export { LibroError };

export const MEDIA = {
  op: 'application/nyx5.libro+json',
  cotizacion: 'application/nyx5.cotizacion+json',
  recibo: 'application/nyx5.recibo+json',
  // NX-305: un comprador PIDE un servicio del catálogo; el vendedor contesta con la cotización.
  pedido: 'application/nyx5.pedido+json',
};

const iso = () => new Date().toISOString();

export class Libro {
  // feeBps: fee de la casa en basis points enteros (1000 = 10%). `feePct` sigue aceptándose
  // como azúcar (0.10 -> 1000) pero el cálculo es siempre entero: sin punto flotante en el dinero.
  // reclaimGraceMs / reviewWindowMs (NX-503): cuánto después del plazo el comprador recupera un
  // escrow sin entrega, y cuánto tiene para objetar una entrega antes de que se libere sola.
  constructor({ domain, store, keys, resolver, feeBps = null, feePct = null, welcome = 0, reclaimGraceMs = 24 * 3600_000, reviewWindowMs = 72 * 3600_000, log = () => {} }) {
    this.domain = domain; this.store = store; this.keys = keys; this.resolver = resolver;
    this.feeBps = feeBps ?? (feePct != null ? Math.round(feePct * 10_000) : 1000);
    this.welcome = welcome; this.log = log;
    this.reclaimGraceMs = reclaimGraceMs; this.reviewWindowMs = reviewWindowMs;
    this.casa = `casa@${domain}`;
    this.address = `libro@${domain}`;
    this.tx = null; // transacción en curso: { state, asientos, contracts: Map, mandates: Map, op }
    this._lock = Promise.resolve(); // serializa las transacciones DENTRO de esta instancia; entre
                                    // procesos/isolates protegen las constraints de D1 (fallar cerrado)
  }
  _serial(fn) { const run = this._lock.then(fn); this._lock = run.catch(() => {}); return run; }
  get feePct() { return this.feeBps / 10_000; } // compat de lectura (tarjeta de libro@)

  // ---------- transacción ----------
  // El estado se lee UNA vez al abrir y no se vuelve a leer: si otra operación comete mientras
  // esta decide, el número de asiento que ésta reservó ya estará tomado y su commit falla cerrado.
  // Releer aquí sería el bug: dos cobros que leyeron el mismo mandato tomarían números distintos
  // y ambos entrarían, superando el tope.
  async _begin(concepto = 'control', refs = {}) {
    const base = await this.store.libroState();
    this.tx = { base, state: null, asientos: [], contracts: new Map(), mandates: new Map(), sellos: [], op: null, concepto, refs };
  }
  _bundle() {
    const t = this.tx;
    return { state: t.state, base: t.base, asientos: t.asientos, contracts: [...t.contracts.values()], mandates: [...t.mandates.values()], sellos: t.sellos, op: t.op };
  }
  async _commit() {
    const t = this.tx;
    // Una operación que muta el Libro sin mover dinero (revocar, entregar, sub-delegar) también
    // consume su número de asiento: es la única forma de que choque con quien corre en paralelo.
    // El asiento de control tiene lines vacío, así que sigue cuadrando en cero y queda auditable.
    if (!t.asientos.length && (t.contracts.size || t.mandates.size)) {
      const st = t.state ?? t.base;
      t.asientos.push(signObject({ id: uuid(), n: st.seq + 1, at: iso(), house: this.domain, concept: t.concepto, lines: [], meta: { kind: 'control' }, refs: t.refs }, this.keys));
      t.state = { seq: st.seq + 1, balances: st.balances };
    }
    const b = this._bundle();
    this.tx = null;
    await this.store.libroCommit(b);
    return b;
  }
  _abort() { this.tx = null; }
  // Lecturas que ven las escrituras pendientes de la propia transacción:
  async _state() { return this.tx ? (this.tx.state ?? this.tx.base) : await this.store.libroState(); }
  async getContract(id) { return this.tx?.contracts.get(id) ?? await this.store.libroGetContract(id); }
  putContract(c) { if (!this.tx) throw new LibroError(500, 'putContract fuera de transacción'); this.tx.contracts.set(c.id, c); }
  async getMandate(id) { return this.tx?.mandates.get(id) ?? await this.store.libroGetMandate(id); }
  putMandate(m) { if (!this.tx) throw new LibroError(500, 'putMandate fuera de transacción'); this.tx.mandates.set(m.id, m); }
  // Sello de notaría (NX-601): no mueve dinero ni consume número de asiento. Su candado contra el
  // doble sello es el índice único (sha256, by) del almacén, que hace fallar cerrado el commit.
  putSello(s) { if (!this.tx) throw new LibroError(500, 'putSello fuera de transacción'); this.tx.sellos.push(s); }

  // ---------- consultas ----------
  get ops() { return Object.keys(CONTRATOS.ops); }
  async balance(account) { return (await this.store.libroState()).balances[account] || 0; }
  fee(amount) { return Math.floor((amount * this.feeBps) / 10_000); }
  async account(address) {
    const { contratoPublico } = await import('./contratos.js');
    const contracts = (await this.store.libroListContracts()).filter((c) => [c.seller, c.buyer, c.verifier, c.arbiter].includes(address)).map(contratoPublico);
    const mandates = (await this.store.libroListMandates()).filter((m) => m.grantor === address || m.grantee === address);
    return { account: address, balance: await this.balance(address), contracts, mandates };
  }
  async journal() { return this.store.libroJournal(); }

  // ---------- reputación = una consulta al libro ----------
  // No es un sistema de puntajes aparte: es lo que el libro ya sabe, contado. Por eso no se
  // puede inflar sin gastar. La defensa contra Sybil es de diseño: SOLO cuentan los contratos
  // cuyo asiento ya movió tokens (terminales). Un contrato abierto no dice nada de nadie.
  //
  // Estados terminales que cuentan, por tipo:
  //   spot   settled                      entrega pagada
  //   escrow released | refunded          entrega aceptada | devuelta
  //   bond   released | forfeited         afirmación sostenida | derribada
  static TERMINALES = { spot: ['settled'], escrow: ['released', 'refunded'], bond: ['released', 'forfeited'], metered: [] };

  async historial(address) {
    const todos = await this.store.libroListContracts();
    const mios = todos.filter((c) => [c.seller, c.buyer].includes(address));
    const cuenta = () => ({ n: 0, tokens: 0 });
    const h = {
      address, house: this.domain,
      // entregas_por_silencio: liberadas por el reloj de la casa al vencer la ventana de revisión
      // (NX-503). Silencio no es aceptación: se cuentan aparte, y también dentro de aceptadas.
      vendiendo: { entregas_aceptadas: cuenta(), entregas_por_silencio: cuenta(), entregas_devueltas: cuenta(), ventas_directas: cuenta() },
      comprando: { encargos_liberados: cuenta(), encargos_devueltos: cuenta(), compras_directas: cuenta() },
      afirmando: { fianzas_sostenidas: cuenta(), fianzas_ejecutadas: cuenta(), fianzas_vigentes: cuenta() },
      avalando: { avales_sostenidos: cuenta(), avales_ejecutados: cuenta() },
      abiertos: cuenta(),
      desde: null, hasta: null, total_movido: 0,
    };
    const sumar = (c, monto) => { c.n += 1; c.tokens += monto; };
    for (const c of mios) {
      const terminal = (Libro.TERMINALES[c.kind] || []).includes(c.state);
      if (!terminal) { sumar(h.abiertos, 0); continue; }
      const monto = Number(c.amount) || 0;
      h.total_movido += monto;
      if (!h.desde || c.created < h.desde) h.desde = c.created;
      if (!h.hasta || c.created > h.hasta) h.hasta = c.created;
      if (c.kind === 'bond') {
        const grupo = c.vouchee ? h.avalando : h.afirmando;
        const sostenida = c.state === 'released';
        if (c.vouchee) sumar(sostenida ? grupo.avales_sostenidos : grupo.avales_ejecutados, monto);
        else sumar(sostenida ? grupo.fianzas_sostenidas : grupo.fianzas_ejecutadas, monto);
      } else if (c.seller === address) {
        if (c.kind === 'spot') sumar(h.vendiendo.ventas_directas, monto);
        else {
          sumar(c.state === 'released' ? h.vendiendo.entregas_aceptadas : h.vendiendo.entregas_devueltas, monto);
          if (c.state === 'released' && c.history?.some((x) => x.op === 'expire')) sumar(h.vendiendo.entregas_por_silencio, monto);
        }
      } else {
        if (c.kind === 'spot') sumar(h.comprando.compras_directas, monto);
        else sumar(c.state === 'released' ? h.comprando.encargos_liberados : h.comprando.encargos_devueltos, monto);
      }
    }
    // Fianzas todavía en pie: no son historial cumplido, pero sí tokens en juego ahora mismo.
    for (const c of mios) if (c.kind === 'bond' && c.state === 'posted' && c.seller === address) sumar(h.afirmando.fianzas_vigentes, Number(c.amount) || 0);
    // Arbitrados por la casa (NX-302): sólo los contratos en que este agente VENDÍA, el árbitro
    // era `verifica@<casa>` y el veredicto terminal (release / refund / forfeit) lo dio ese
    // árbitro, no una parte. Es la porción del historial que dos cómplices no pueden fabricar
    // entre sí: para sumar aquí hay que pasar una prueba determinista que corre la casa. Un
    // escrow liberado por el comprador, o por silencio (`expire`), queda fuera aunque el
    // contrato nombrara a verifica@ de árbitro. Campo ADITIVO: la forma anterior no cambia.
    const arbitro = `verifica@${this.domain}`;
    h.arbitrados = { arbitro, liberados: cuenta(), devueltos: cuenta(), ejecutadas: cuenta() };
    for (const c of mios) {
      if (c.seller !== address || c.arbiter !== arbitro) continue;
      if (!(Libro.TERMINALES[c.kind] || []).includes(c.state)) continue;
      const veredicto = (c.history || []).filter((x) => ['release', 'refund', 'forfeit'].includes(x.op)).at(-1);
      if (!veredicto || veredicto.by !== arbitro) continue;
      const monto = Number(c.amount) || 0;
      if (veredicto.op === 'release') sumar(h.arbitrados.liberados, monto);
      else if (veredicto.op === 'refund') sumar(h.arbitrados.devueltos, monto);
      else sumar(h.arbitrados.ejecutadas, monto);
    }
    // El resumen es lo que un agente lee para decidir en una línea; el detalle queda arriba.
    const entregadas = h.vendiendo.entregas_aceptadas.n + h.vendiendo.ventas_directas.n;
    const falladas = h.vendiendo.entregas_devueltas.n;
    const afirmaciones = h.afirmando.fianzas_sostenidas.n + h.afirmando.fianzas_ejecutadas.n;
    h.resumen = {
      entregas: entregadas, entregas_falladas: falladas,
      afirmaciones_con_fianza: afirmaciones, fianzas_perdidas: h.afirmando.fianzas_ejecutadas.n,
      tokens_en_juego_ahora: h.afirmando.fianzas_vigentes.tokens,
      total_movido: h.total_movido,
      // Sin historial no hay tasa: cero de cero no es 100%, es "todavía nada". Lo decimos así.
      cumplimiento: entregadas + falladas > 0 ? Number((entregadas / (entregadas + falladas)).toFixed(4)) : null,
      veracidad: afirmaciones > 0 ? Number((h.afirmando.fianzas_sostenidas.n / afirmaciones).toFixed(4)) : null,
      // Lo que el índice federado usa para ordenar (§13): ponderado por tokens, null sin historial arbitrado.
      puntaje_arbitrado: puntajeArbitrado(h.arbitrados),
    };
    return h;
  }


  // ---------- el kernel: un asiento ----------
  // lines: [{ account, delta }]; suma cero; nadie salvo la casa queda negativo.
  async post(concept, lines, meta = {}, refs = {}) {
    const total = lines.reduce((s, l) => s + l.delta, 0);
    if (total !== 0) throw new LibroError(500, `asiento descuadrado (${total})`);
    for (const l of lines) if (!Number.isInteger(l.delta)) throw new LibroError(400, 'los montos son enteros (tokens)');
    const state = await this._state();
    const next = { ...state.balances };
    for (const l of lines) {
      next[l.account] = (next[l.account] || 0) + l.delta;
      if (next[l.account] < 0 && l.account !== this.casa) throw new LibroError(402, `insufficient balance in ${l.account} (has ${state.balances[l.account] || 0}, needs ${-l.delta})`);
    }
    const asiento = signObject({ id: uuid(), n: state.seq + 1, at: iso(), house: this.domain, concept, lines, meta, refs }, this.keys);
    if (this.tx) {
      this.tx.asientos.push(asiento);
      this.tx.state = { seq: state.seq + 1, balances: next };
    } else {
      // asiento suelto (topup administrativo): transacción propia, con el mismo candado
      await this.store.libroCommit({ base: state, state: { seq: state.seq + 1, balances: next }, asientos: [asiento], contracts: [], mandates: [], op: null });
    }
    return asiento;
  }

  // Primitivas construidas sobre post()
  async topup(account, amount, concept = 'carga', meta = {}) {
    parseAddress(account); this._amount(amount);
    const asentar = () => this.post(concept, [{ account: this.casa, delta: -amount }, { account, delta: amount }], { kind: 'topup', ...meta });
    return this.tx ? asentar() : this._serial(asentar);
  }
  // referrer opcional { address, share (bps) }: la comisión sale del monto (la recibe el vendedor),
  // no se suma al precio. El asiento pasa a 4 líneas y sigue cuadrando en cero.
  async transfer(from, to, amount, concept, meta = {}, refs = {}, referrer = null) {
    this._amount(amount);
    const fee = this.fee(amount);
    const com = referrer ? Math.floor((amount * referrer.share) / 10_000) : 0;
    const lines = [{ account: from, delta: -amount }, { account: to, delta: amount - fee - com }];
    if (fee) lines.push({ account: this.casa, delta: fee });
    if (com) lines.push({ account: referrer.address, delta: com });
    return this.post(concept, lines, { kind: 'charge', fee, ...(com ? { referrer: referrer.address, commission: com } : {}), ...meta }, refs);
  }
  async hold(from, contractId, amount, concept, meta = {}, refs = {}) {
    this._amount(amount);
    return this.post(concept, [{ account: from, delta: -amount }, { account: `escrow:${contractId}`, delta: amount }], { kind: 'hold', ...meta }, refs);
  }
  async release(contractId, to, amount, concept, meta = {}, refs = {}, referrer = null) {
    this._amount(amount);
    const fee = this.fee(amount);
    const com = referrer ? Math.floor((amount * referrer.share) / 10_000) : 0;
    const lines = [{ account: `escrow:${contractId}`, delta: -amount }, { account: to, delta: amount - fee - com }];
    if (fee) lines.push({ account: this.casa, delta: fee });
    if (com) lines.push({ account: referrer.address, delta: com });
    return this.post(concept, lines, { kind: 'release', fee, ...(com ? { referrer: referrer.address, commission: com } : {}), ...meta }, refs);
  }
  async refund(contractId, to, amount, concept, meta = {}, refs = {}) {
    this._amount(amount);
    return this.post(concept, [{ account: `escrow:${contractId}`, delta: -amount }, { account: to, delta: amount }], { kind: 'refund', ...meta }, refs);
  }
  _amount(a) { if (!Number.isInteger(a) || a <= 0) throw new LibroError(400, `invalid amount: ${a}`); }

  // ---------- cotizaciones: documentos firmados por el vendedor ----------
  // Una cotización viaja adentro de un sobre (cifrado si se quiere) y se presenta al Libro al aceptar.
  static buildQuote({ seller, buyer, house, contract = 'spot', price, concept, terms = {}, expires, arbiter = null, referrer = null, service = null }, sellerKeys) {
    if (!CONTRATOS[contract]?.quoteable) throw new LibroError(400, `contrato no cotizable: ${contract}`);
    // `service` (NX-301): el id de un servicio publicado en la ficha del vendedor. Va firmado en la
    // cotización y verifyQuote lo cruza con la ficha al aceptar: precio y contrato tienen que ser los publicados.
    if (service != null && (typeof service !== 'string' || !/^[a-z0-9-]{1,40}$/.test(service))) throw new LibroError(400, 'service debe ser el id de un servicio de la ficha (letras minúsculas, dígitos y guiones)');
    if (arbiter) parseAddress(arbiter);
    // Comisión de referido: el vendedor firma en su cotización que le paga `share` (en basis points)
    // a quien trajo el trato. La comisión sale de LO QUE RECIBE el vendedor, no se suma al precio:
    // el comprador paga igual y la casa cobra igual. verifyQuote valida los límites al aceptar.
    if (referrer != null) {
      parseAddress(referrer.address);
      if (!Number.isInteger(referrer.share) || referrer.share <= 0) throw new LibroError(400, 'referrer.share debe ser un entero de basis points > 0');
    }
    return signObject({ tipo: 'cotizacion', id: uuid(), house, seller, buyer, contract, price, currency: 'tok', concept, terms, arbiter, referrer: referrer || undefined, service: service || undefined, issued: iso(), expires: expires || null }, sellerKeys);
  }
  async verifyQuote(q, buyer) {
    if (q?.tipo !== 'cotizacion' || !q.id || !q.seller || !q.signature) throw new LibroError(400, 'cotización malformada');
    // Solo tipos cotizables: una cotización firmada a mano con un kind inexistente (o no cotizable)
    // se rechaza limpio aquí, no explota en onAccept.
    if (!CONTRATOS[q.contract]?.quoteable) throw new LibroError(400, `contrato no cotizable: ${q.contract}`);
    if (q.house !== this.domain) throw new LibroError(400, `la cotización es para la casa ${q.house}, no ${this.domain}`);
    if (q.buyer !== buyer) throw new LibroError(403, 'la cotización no está dirigida a quien la acepta');
    if (q.expires && Date.parse(q.expires) < Date.now()) throw new LibroError(410, 'cotización vencida');
    if (q.arbiter) { try { parseAddress(q.arbiter); } catch { throw new LibroError(400, 'árbitro inválido en la cotización'); } }
    if (q.referrer != null) {
      try { parseAddress(q.referrer.address); } catch { throw new LibroError(400, 'referidor inválido en la cotización'); }
      if (!Number.isInteger(q.referrer.share) || q.referrer.share <= 0) throw new LibroError(400, 'referrer.share debe ser un entero de basis points > 0');
      // El fee de la casa y la comisión salen ambos del monto: juntos no pueden dejar al vendedor en negativo.
      if (this.feeBps + q.referrer.share > 10_000) throw new LibroError(400, `fee (${this.feeBps} bps) + comisión (${q.referrer.share} bps) supera el 100% del precio`);
      if (q.referrer.address === q.seller) throw new LibroError(400, 'el vendedor no puede ser su propio referidor');
    }
    this._amount(q.price);
    let card;
    try { card = await this.resolver.agentCardForKid(q.seller, q.signature.kid); } catch (e) { throw new LibroError(e.permanent ? 403 : 421, `no se pudo verificar al vendedor: ${e.message}`); }
    if (!Resolver.acceptedKids(card).includes(q.signature.kid) || !verifyObject(q, q.signature.kid)) throw new LibroError(403, 'firma de la cotización inválida');
    // Una dirección de sólo mensajes (la del Claude de un teléfono, cuya llave guarda la casa) no
    // vende: aceptarle una cotización le movería saldo, que es justo lo que su dueño no autorizó.
    if (card.delegation?.scope?.messages_only) throw new LibroError(403, 'the seller is a messages-only address: it cannot sell');
    // Cotización sobre un servicio publicado (NX-301): se compara contra la ficha CERTIFICADA del
    // vendedor tal como está hoy, nunca contra lo que la cotización dice de sí misma. Mismo espíritu
    // que tareas.coincide: un precio o un contrato distintos del publicado son rechazo, no negociación.
    // Si el vendedor cambió su catálogo después de cotizar, la cotización vieja ya no coincide y se rechaza.
    if (q.service != null) {
      if (typeof q.service !== 'string') throw new LibroError(400, 'service must be the id of a published service');
      const s = (card.profile?.services || []).find((x) => x.id === q.service);
      if (!s) throw new LibroError(400, `service "${q.service}" is not published in the profile of ${q.seller}`);
      if (s.price.tokens !== q.price || s.contract !== q.contract) throw new LibroError(400, `service ${s.id} is published at ${s.price.tokens} tok as ${s.contract}; the quote says ${q.price} as ${q.contract}`);
    }
    if (await this.store.libroFindContractByQuote(q.id)) throw new LibroError(409, 'cotización ya aceptada');
    return card;
  }

  // ---------- entrada: un sobre dirigido a libro@<dominio> ----------
  // Devuelve { ok, code, reason, result, recibos: [{ to: [...], body }] }. Idempotente por id de sobre.
  async handle(env, senderCard) {
    const prev = await this.store.libroGetOp(env.id);
    if (prev) return { ...prev, duplicate: true };
    if (!env.content || env.content.media !== MEDIA.op) return { ok: false, code: 400, reason: `the Libro only accepts content.media = ${MEDIA.op} (unencrypted: the house must read it)` };
    const body = env.content.body || {};
    const op = CONTRATOS.ops[body.op];
    if (!op) return { ok: false, code: 400, reason: `unknown operation: ${body.op}. Valid ones: ${Object.keys(CONTRATOS.ops).join(', ')}` };
    // Sólo mensajes no opera el Libro, entre el sobre por donde entre: la regla vive donde se mueve
    // el dinero, no sólo en la puerta (revisión del 11-sep-2026).
    if (senderCard?.delegation?.scope?.messages_only) return { ok: false, code: 403, reason: 'this is a messages-only address: it cannot operate the ledger' };
    const ctx = { libro: this, env, from: env.from, body, senderCard, opHash: sha256hex(canonical(env)), scope: senderCard?.delegation?.scope || null };
    return this._serial(async () => {
      await this._begin(`op ${body.op}`, { op: env.id, op_sha256: ctx.opHash });
      let result;
      try { result = await op(ctx); }
      catch (e) {
        this._abort();
        if (e instanceof LibroError) return { ok: false, code: e.code, reason: e.message };
        throw e;
      }
      // Boleta (NX-501): todo recibo que lleva un asiento con reparto dice cuánto fue fee de la casa
      // y cuánto comisión de referido, leído de las líneas del asiento (estado.js), en el único
      // punto donde se arman los recibos.
      const boleta = (b) => boletaDe(b.asiento, { casa: this.casa, feeBps: this.feeBps, share: b.contract?.referrer?.share ?? null });
      const out = { ok: true, code: 202, result: result.result, recibos: (result.recibos || []).map((r) => ({ ...r, body: { ...r.body, ...boleta(r.body), of: env.id, op: body.op, op_sha256: ctx.opHash, from: env.from } })), avisos: result.avisos || [] };
      this.tx.op = { id: env.id, result: out };
      try { await this._commit(); }
      catch (e) {
        // Conflicto de concurrencia (asiento u op duplicados en D1): la op ya corrió en paralelo.
        const cached = await this.store.libroGetOp(env.id);
        if (cached) return { ...cached, duplicate: true };
        throw e;
      }
      return out;
    });
  }

  // Estampilla: un sobre con `stamp` hacia un buzón con política `stamp` paga al llegar.
  // NO comete: devuelve { asiento, bundle } para que la estafeta lo selle JUNTO con el buzón y el
  // dedupe del sobre (inboundCommit) — así una reentrega jamás cobra la estampilla dos veces.
  async stamp(env, recipient, price) {
    const s = env.stamp;
    if (!s || s.house !== this.domain || !Number.isInteger(s.amount) || s.amount < price) throw new LibroError(402, `this mailbox requires a stamp of ${price} tok in house ${this.domain} (stamp field: {house, amount})`);
    return this._serial(async () => {
    await this._begin('estampilla', { envelope: env.id });
    try {
      const asiento = await this.transfer(env.from, recipient, s.amount, `estampilla ${env.from} -> ${recipient}`, { kind: 'stamp' }, { envelope: env.id, envelope_sha256: sha256hex(canonical(env)) });
      const bundle = this._bundle();
      this.tx = null;
      return { asiento, bundle };
    } catch (e) { this._abort(); throw e; }
    });
  }
}

// Puntaje de reputación arbitrada: tokens liberados sobre tokens decididos por verifica@
// (liberados + devueltos + fianzas ejecutadas). Ponderado por monto, no por cuenta: una entrega
// de 5.000 pesa más que diez de 10. `null` cuando no hay nada decidido: cero de cero no es 100 %.
// UNA definición: la usan `historial` (resumen.puntaje_arbitrado) y el índice federado.
export function puntajeArbitrado(arbitrados) {
  if (!arbitrados || typeof arbitrados !== 'object') return null;
  const t = (k) => Number(arbitrados[k]?.tokens) || 0;
  const total = t('liberados') + t('devueltos') + t('ejecutadas');
  if (total <= 0) return null;
  return Number((t('liberados') / total).toFixed(4));
}
