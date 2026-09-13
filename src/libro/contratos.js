// Nyx5/1 — Contratos: máquinas de estado sobre las primitivas del Libro.
//
// Cada operación recibe un contexto { libro, env, from, body, senderCard, opHash, scope } y devuelve
// { result, recibos: [{ to: [...], thread, body }] }. Los recibos los envía la estafeta desde
// `libro@<dominio>`, firmados con la clave de la casa: son la verdad compartida entre las partes.
//
// Agregar un contrato nuevo = agregar entradas a `ops` y, si se cotiza, a CONTRATOS.<kind>.
// El kernel (libro.js) no se toca.
//
// Las operaciones corren DENTRO de la transacción que abre Libro.handle(): leen con
// libro.getContract/getMandate (que ven las escrituras pendientes) y escriben con
// libro.putContract/putMandate (que quedan en la transacción). El commit lo sella handle().

import { sha256hex, canonical, uuid } from '../nucleo/crypto.js';
import { parseAddress } from '../correo/resolver.js';
import { applyInboxPolicy } from '../correo/politica.js';

import { LibroError } from './errores.js';

const iso = () => new Date().toISOString();
const fail = (code, msg) => { throw new LibroError(code, msg); };

// --- helpers ---
async function getContract(libro, id) { const c = await libro.getContract(id); if (!c) fail(404, `contrato inexistente: ${id}`); return c; }
async function getMandate(libro, id) { const m = await libro.getMandate(id); if (!m) fail(404, `mandato inexistente: ${id}`); return m; }
function record(libro, c, op, by, extra = {}) {
  c.history.push({ at: iso(), op, by, ...extra });
  c.updated = iso();
  libro.putContract(c);
  return c;
}
function scopeCap(ctx, amount, what) {
  const cap = ctx.scope?.cap;
  if (cap != null && amount > cap) fail(403, `${what}: ${amount} tok exceeds the subagent cap of ${cap}`);
}
function must(cond, code, msg) { if (!cond) fail(code, msg); }

// ---------- alcance de un mandato: vocabulario CERRADO, y se falla cerrado ----------
// Un mandato es autoridad de gasto. Si el mandante escribe una restricción que el Libro no sabe
// aplicar, la opción segura NO es guardarla y seguir: es negarse.
//
// Nació de un defecto real (9-sep-2026): un mandato con `max_per_charge: 500` y una lista de
// destinatarios permitidos guardó las dos, las FIRMÓ, y después dejó pasar un cobro único de
// 90.000. La restricción se veía al leer el mandato de vuelta y no hacía nada. Un instrumento que
// falla hacia el ruido es peor que uno que no existe: te deja construir encima.
//
// Esto contradice a propósito el invariante 7 (los campos desconocidos se conservan y se ignoran).
// Ese invariante es para MENSAJES, donde ignorar lo que no entiendes es lo que permite extender el
// protocolo sin romperlo. Para autoridad de gasto es lo contrario: ignorar una restricción
// autoriza MÁS de lo que el mandante quiso.
export const ALCANCE_MANDATO = Object.freeze(['concepts', 'max_per_charge']);

function validarAlcance(scope, cap) {
  if (scope == null) return {};
  must(typeof scope === 'object' && !Array.isArray(scope), 400, 'scope must be an object');
  const ajenas = Object.keys(scope).filter((k) => !ALCANCE_MANDATO.includes(k));
  must(!ajenas.length, 400, `this ledger cannot enforce ${ajenas.map((k) => JSON.stringify(k)).join(', ')} in a mandate scope, so it refuses to store it as if it could. It enforces: ${ALCANCE_MANDATO.join(', ')}`);
  if (scope.concepts != null) {
    must(Array.isArray(scope.concepts) && scope.concepts.every((c) => typeof c === 'string'), 400, 'scope.concepts must be a list of strings');
  }
  if (scope.max_per_charge != null) {
    must(Number.isInteger(scope.max_per_charge) && scope.max_per_charge > 0, 400, 'scope.max_per_charge must be a positive integer');
    must(cap == null || scope.max_per_charge <= cap, 400, `scope.max_per_charge (${scope.max_per_charge}) cannot exceed the mandate cap (${cap})`);
  }
  return scope;
}
const parties = (c) => [c.seller, c.buyer, c.verifier, c.arbiter].filter(Boolean);

// ============ Operaciones ============
const ops = {

  // --- aceptar una cotización: crea el contrato y ejecuta el primer asiento ---
  async accept(ctx) {
    const { libro, from, body } = ctx;
    const q = body.quote;
    await libro.verifyQuote(q, from); // valida forma, firma, vigencia, no-reuso y que q.contract sea cotizable
    scopeCap(ctx, q.price, 'accepting a quote');
    const kind = CONTRATOS[q.contract];
    const c = {
      id: uuid(), kind: q.contract, house: libro.domain, seller: q.seller, buyer: from, amount: q.price,
      concept: q.concept, terms: q.terms || {}, arbiter: q.arbiter || null, referrer: q.referrer || null,
      quote_id: q.id, quote_sha256: sha256hex(canonical(q)), accept_sha256: ctx.opHash,
      state: 'accepted', created: iso(), history: [],
    };
    const refs = { contract: c.id, quote: q.id, quote_sha256: c.quote_sha256, op: ctx.env.id, op_sha256: ctx.opHash };
    const out = await kind.onAccept({ libro, c, q, refs });
    record(libro, c, 'accept', from, { asiento: out.asiento?.id, mandate: out.mandate?.id });
    // Aviso de plazo: si el trato tiene fecha límite, el Libro se programa un sobre a las partes
    // para ese día. Un escrow que llegó a su deadline sin liberarse deja de quedar mudo.
    const plazo = c.terms?.deadline;
    const avisos = plazo && !Number.isNaN(Date.parse(plazo)) ? [{
      to: parties(c), thread: c.id, deliver_after: new Date(Date.parse(plazo)).toISOString(),
      body: { aviso: 'plazo', contract: c.id, kind: c.kind, deadline: plazo, message: `The deadline for contract ${c.id} (${c.concept}) has arrived. State when scheduled: ${c.state}.` },
    }] : [];
    return { result: { contract: c, asiento: out.asiento, mandate: out.mandate },
      recibos: [{ to: [c.buyer, c.seller], thread: c.id, body: { contract: c, asiento: out.asiento, mandate: out.mandate, cotizacion_sha256: c.quote_sha256 } }],
      avisos };
  },

  // --- escrow: el vendedor declara entregado, con hash de la evidencia ---
  async deliver(ctx) {
    const { libro, from, body } = ctx;
    const c = await getContract(libro, body.contract);
    must(c.kind === 'escrow', 409, 'deliver solo aplica a escrow');
    must(from === c.seller, 403, 'only the seller can declare delivery');
    must(c.state === 'held', 409, `state ${c.state}, expected held`);
    c.state = 'delivered'; c.evidence_sha256 = body.evidence_sha256 || null;
    record(libro, c, 'deliver', from, { evidence_sha256: c.evidence_sha256, note: body.note });
    return { result: { contract: c }, recibos: [{ to: parties(c), thread: c.id, body: { contract: c } }] };
  },

  // --- liberar fondos retenidos: escrow -> vendedor (con fee); fianza -> vuelve al que afianzó ---
  async release(ctx) {
    const { libro, from, body } = ctx;
    const c = await getContract(libro, body.contract);
    let asiento;
    if (c.kind === 'escrow') {
      must([c.buyer, c.arbiter].includes(from), 403, 'solo el comprador o el árbitro liberan el escrow');
      must(['held', 'delivered'].includes(c.state), 409, `estado ${c.state}`);
      asiento = await libro.release(c.id, c.seller, c.amount, `liberación escrow ${c.id}: ${c.concept}`, { contract: c.id }, { op: ctx.env.id, op_sha256: ctx.opHash }, c.referrer);
      c.state = 'released';
    } else if (c.kind === 'bond') {
      const expired = c.expires && Date.parse(c.expires) < Date.now();
      must([c.verifier, c.arbiter].includes(from) || (from === c.seller && expired), 403, 'la fianza la libera el verificador o el árbitro; el afianzado solo cuando vence');
      must(c.state === 'posted', 409, `estado ${c.state}`);
      asiento = await libro.refund(c.id, c.seller, c.amount, `fianza liberada ${c.id}: ${c.claim}`, { contract: c.id, kind: 'bond-release' }, { op: ctx.env.id, op_sha256: ctx.opHash });
      c.state = 'released';
    } else fail(409, `release does not apply to ${c.kind}`);
    record(libro, c, 'release', from, { asiento: asiento.id });
    return { result: { contract: c, asiento }, recibos: [{ to: parties(c), thread: c.id, body: { contract: c, asiento } }] };
  },

  // --- devolver escrow al comprador (sin fee) ---
  async refund(ctx) {
    const { libro, from, body } = ctx;
    const c = await getContract(libro, body.contract);
    must(c.kind === 'escrow', 409, 'refund solo aplica a escrow');
    must([c.seller, c.arbiter].includes(from) || (from === c.buyer && c.state === 'held'), 403, 'devuelven el vendedor o el árbitro; el comprador solo si aún no hay entrega');
    must(['held', 'delivered'].includes(c.state), 409, `estado ${c.state}`);
    const asiento = await libro.refund(c.id, c.buyer, c.amount, `devolución escrow ${c.id}: ${c.concept}`, { contract: c.id }, { op: ctx.env.id, op_sha256: ctx.opHash });
    c.state = 'refunded';
    record(libro, c, 'refund', from, { asiento: asiento.id, note: body.note });
    return { result: { contract: c, asiento }, recibos: [{ to: parties(c), thread: c.id, body: { contract: c, asiento } }] };
  },

  // --- escrow que vence (NX-503): el comprador recupera; una entrega sin objeción se libera ---
  // Antes un contrato vencido sólo mandaba un aviso y la plata quedaba retenida para siempre.
  // reclaim: sólo el comprador, sólo sin entrega, y sólo pasado el plazo más la gracia de la casa.
  async reclaim(ctx) {
    const { libro, from, body } = ctx;
    const c = await getContract(libro, body.contract);
    must(c.kind === 'escrow', 409, 'reclaim only applies to escrow');
    must(from === c.buyer, 403, 'only the buyer reclaims an expired escrow');
    must(c.state === 'held', 409, c.state === 'delivered' ? 'the seller already delivered: refund needs the seller or the arbiter, or the review window' : `state ${c.state}`);
    const plazo = Date.parse(c.terms?.deadline || '');
    must(!Number.isNaN(plazo), 409, 'this escrow has no deadline: only the seller or the arbiter can refund it');
    const desde = plazo + libro.reclaimGraceMs;
    must(Date.now() >= desde, 409, `the deadline plus the grace period has not passed yet (reclaimable from ${new Date(desde).toISOString()})`);
    const asiento = await libro.refund(c.id, c.buyer, c.amount, `escrow vencido ${c.id}: ${c.concept}`, { contract: c.id, kind: 'reclaim' }, { op: ctx.env.id, op_sha256: ctx.opHash });
    c.state = 'refunded';
    record(libro, c, 'reclaim', from, { asiento: asiento.id, deadline: c.terms.deadline });
    return { result: { contract: c, asiento }, recibos: [{ to: parties(c), thread: c.id, body: { contract: c, asiento } }] };
  },
  // expire: lo firma la CASA (libro@) desde el reloj, nunca una parte. Entregado, con plazo vencido,
  // y pasada la ventana de revisión sin que nadie devolviera ni liberara: se libera al vendedor.
  // «Sin disputa» quiere decir que ni el comprador ni el árbitro hicieron refund en la ventana.
  async expire(ctx) {
    const { libro, from, body } = ctx;
    must(from === libro.address, 403, 'only the house settles an expired escrow');
    const c = await getContract(libro, body.contract);
    must(c.kind === 'escrow' && c.state === 'delivered', 409, `state ${c.state}, expected a delivered escrow`);
    const plazo = Date.parse(c.terms?.deadline || '');
    must(!Number.isNaN(plazo), 409, 'no deadline: a delivery without a deadline waits for the buyer or the arbiter');
    const entregado = Date.parse(c.history.findLast?.((h) => h.op === 'deliver')?.at || c.history.filter((h) => h.op === 'deliver').at(-1)?.at || '');
    const desde = Math.max(plazo, entregado || 0) + libro.reviewWindowMs;
    must(Date.now() >= desde, 409, `the review window is still open (until ${new Date(desde).toISOString()})`);
    const asiento = await libro.release(c.id, c.seller, c.amount, `liberación por ventana vencida ${c.id}: ${c.concept}`, { contract: c.id, kind: 'expire' }, { op: ctx.env.id, op_sha256: ctx.opHash }, c.referrer);
    c.state = 'released';
    record(libro, c, 'expire', from, { asiento: asiento.id, review_until: new Date(desde).toISOString() });
    return { result: { contract: c, asiento }, recibos: [{ to: parties(c), thread: c.id, body: { contract: c, asiento, note: 'delivered, deadline passed, no objection within the review window' } }] };
  },

  // --- fianza: el que afirma deposita; si la verificación lo derriba, la pierde ---
  async bond(ctx) {
    const { libro, from, body } = ctx;
    must(typeof body.claim === 'string' && body.claim.length > 0, 400, 'a bond needs a claim (what is being asserted)');
    parseAddress(body.verifier); must(body.verifier !== from, 400, 'the verifier cannot be the one posting the bond');
    // beneficiary y arbiter entran a cuentas del ledger: direcciones válidas o nada.
    if (body.beneficiary) { try { parseAddress(body.beneficiary); } catch { fail(400, 'beneficiary must be a valid agent address'); } }
    if (body.arbiter) { try { parseAddress(body.arbiter); } catch { fail(400, 'arbiter must be a valid agent address'); } }
    // vouchee (avalado): si esta fianza avala a un tercero para presentarse ante un buzón con lista
    // blanca, nombra a quién avala. La política de entrada exige que coincida con el remitente.
    if (body.vouchee) { try { parseAddress(body.vouchee); } catch { fail(400, 'vouchee must be a valid agent address'); } }
    scopeCap(ctx, body.amount, 'posting a bond');
    const c = {
      id: uuid(), kind: 'bond', house: libro.domain, seller: from, verifier: body.verifier, arbiter: body.arbiter || null,
      beneficiary: body.beneficiary || libro.casa, vouchee: body.vouchee || null, amount: body.amount, claim: body.claim, evidence_sha256: body.evidence_sha256 || null,
      expires: body.expires || null, claim_sha256: ctx.opHash, state: 'posted', created: iso(), history: [],
    };
    const asiento = await libro.hold(from, c.id, c.amount, `fianza ${c.id}: ${c.claim}`, { contract: c.id, kind: 'bond' }, { op: ctx.env.id, op_sha256: ctx.opHash });
    record(libro, c, 'bond', from, { asiento: asiento.id });
    return { result: { contract: c, asiento }, recibos: [{ to: [c.seller, c.verifier], thread: c.id, body: { contract: c, asiento } }] };
  },

  // --- ejecutar la fianza: la afirmación era falsa ---
  async forfeit(ctx) {
    const { libro, from, body } = ctx;
    const c = await getContract(libro, body.contract);
    must(c.kind === 'bond', 409, 'forfeit solo aplica a fianzas');
    must([c.verifier, c.arbiter].includes(from), 403, 'solo el verificador o el árbitro ejecutan la fianza');
    must(c.state === 'posted', 409, `estado ${c.state}`);
    const asiento = await libro.post(`fianza ejecutada ${c.id}: ${c.claim}`, [{ account: `escrow:${c.id}`, delta: -c.amount }, { account: c.beneficiary, delta: c.amount }], { kind: 'forfeit', contract: c.id, reason: body.reason }, { op: ctx.env.id, op_sha256: ctx.opHash });
    c.state = 'forfeited';
    record(libro, c, 'forfeit', from, { asiento: asiento.id, reason: body.reason });
    return { result: { contract: c, asiento }, recibos: [{ to: parties(c), thread: c.id, body: { contract: c, asiento } }] };
  },

  // --- mandato: autoridad de gasto delegada, en cadena ---
  async mandate(ctx) {
    const { libro, from, body } = ctx;
    parseAddress(body.grantee);
    must(Number.isInteger(body.cap) && body.cap > 0, 400, 'cap debe ser entero positivo');
    scopeCap(ctx, body.cap, 'granting a mandate');
    let parent = null;
    if (body.parent) {
      parent = await getMandate(libro, body.parent);
      must(parent.state === 'active', 409, 'the parent mandate is not active');
      must(parent.grantee === from, 403, 'only the grantee of the parent mandate can sub-delegate');
      must(body.cap <= parent.cap - parent.spent, 403, `the sub-mandate (${body.cap}) exceeds what the parent has left (${parent.cap - parent.spent})`);
      if (parent.expires) must(!body.expires || Date.parse(body.expires) <= Date.parse(parent.expires), 403, 'the sub-mandate cannot outlast its parent');
    }
    const m = { id: uuid(), house: libro.domain, grantor: from, grantee: body.grantee, cap: body.cap, spent: 0, scope: validarAlcance(body.scope, body.cap), expires: body.expires || parent?.expires || null,
      parent: parent?.id || null, root: parent ? parent.root : from, chain: [], state: 'active', created: iso(), op_sha256: ctx.opHash };
    m.chain = parent ? [...parent.chain, m.id] : [m.id];
    libro.putMandate(m);
    return { result: { mandate: m }, recibos: [{ to: [m.grantor, m.grantee], thread: m.chain[0], body: { mandate: m } }] };
  },

  // --- cobrar bajo mandato: paga el mandante raíz; toda la cadena descuenta ---
  async charge(ctx) {
    const { libro, from, body } = ctx;
    const m = await getMandate(libro, body.mandate);
    must(from === m.grantee, 403, 'only the grantee charges under the mandate');
    must(Number.isInteger(body.amount) && body.amount > 0, 400, 'invalid amount');
    scopeCap(ctx, body.amount, 'charging');
    const chain = [];
    for (let cur = m; cur; cur = cur.parent ? await getMandate(libro, cur.parent) : null) {
      must(cur.state === 'active', 409, `mandate ${cur.id} is not active`);
      must(!cur.expires || Date.parse(cur.expires) > Date.now(), 410, `mandato ${cur.id} vencido`);
      must(cur.cap - cur.spent >= body.amount, 402, `mandate ${cur.id}: ${cur.cap - cur.spent} left, ${body.amount} requested`);
      // Fallar cerrado: un mandato guardado ANTES de este candado puede llevar una restricción que
      // no sabemos aplicar. No se cobra contra él hasta que su mandante lo rehaga.
      const ajenas = Object.keys(cur.scope || {}).filter((k) => !ALCANCE_MANDATO.includes(k));
      must(!ajenas.length, 403, `mandate ${cur.id} carries ${ajenas.map((k) => JSON.stringify(k)).join(', ')} in its scope, which this ledger cannot enforce; it refuses to charge against a limit it cannot apply`);
      if (cur.scope?.concepts?.length) must(cur.scope.concepts.includes(body.concept), 403, `concept "${body.concept}" is outside the mandate scope`);
      // Tope por cobro: el total ya no se puede vaciar de un solo golpe. Se comprueba en CADA
      // eslabón, así que el tope del padre acota lo que cobra el nieto.
      if (cur.scope?.max_per_charge != null) must(body.amount <= cur.scope.max_per_charge, 403, `mandate ${cur.id} caps a single charge at ${cur.scope.max_per_charge}, and ${body.amount} was requested`);
      chain.push(cur);
    }
    // El descuento de la cadena y el asiento van en la MISMA transacción: si el commit falla,
    // ni el dinero se movió ni ningún eslabón descontó (nada de sobre-gasto por caída a medias).
    const asiento = await libro.transfer(m.root, m.grantee, body.amount, body.concept || `cobro bajo mandato ${m.id}`, { mandate: m.id, chain: chain.map((x) => x.id) }, { op: ctx.env.id, op_sha256: ctx.opHash });
    for (const cur of chain) { cur.spent += body.amount; libro.putMandate(cur); }
    const everyone = [...new Set(chain.flatMap((x) => [x.grantor, x.grantee]))];
    return { result: { asiento, mandate: chain[0] }, recibos: [{ to: everyone, thread: chain.at(-1).id, body: { asiento, mandate: chain[0], chain: chain.map((x) => ({ id: x.id, grantor: x.grantor, grantee: x.grantee, cap: x.cap, spent: x.spent })) } }] };
  },

  // --- revocar un mandato y todo lo que cuelga de él ---
  async revoke(ctx) {
    const { libro, from, body } = ctx;
    const m = await getMandate(libro, body.mandate);
    const ancestors = []; for (let cur = m; cur; cur = cur.parent ? await getMandate(libro, cur.parent) : null) ancestors.push(cur.grantor);
    must(ancestors.includes(from), 403, 'only the grantor or a grantor above it can revoke');
    const affected = (await libro.store.libroListMandates()).filter((x) => x.chain.includes(m.id) && x.state === 'active');
    for (const x of affected) { x.state = 'revoked'; x.revoked = { at: iso(), by: from }; libro.putMandate(x); }
    return { result: { revoked: affected.map((x) => x.id) }, recibos: [{ to: [...new Set(affected.flatMap((x) => [x.grantor, x.grantee]))], thread: m.chain[0], body: { revoked: affected.map((x) => x.id), by: from } }] };
  },

  // --- pagar directo: sin cotización ni contrato. Lo firma el que paga; el que recibe no hace nada.
  // Es el "te mando plata" entre dos personas. Sólo dentro de la casa: aquí no hay cómo comprobar
  // que una dirección de otra casa existe, y un pago a nadie deja tokens varados para siempre.
  async pay(ctx) {
    const { libro, from, body } = ctx;
    let to; try { to = parseAddress(body.to); } catch { fail(400, 'pay needs "to": the address that receives'); }
    const address = `${to.local}@${to.domain}`;
    must(to.domain === libro.domain, 400, `pay moves tokens inside ${libro.domain}; ${to.domain} keeps its own ledger`);
    must(address !== from, 400, 'paying yourself moves nothing');
    must(Number.isSafeInteger(body.amount) && body.amount > 0, 400, 'amount must be a positive integer');
    scopeCap(ctx, body.amount, 'paying');
    const rec = await libro.store.getAgent(to.local);
    must(rec && !rec.revoked, 404, `${address} does not exist in this house`);
    // Un subagente de sólo mensajes nunca podrá gastar: lo que le llegue quedaría varado. Se le paga al dueño.
    must(!rec.delegation?.scope?.messages_only, 400, `${address} only carries messages and could never spend this; pay its owner, ${rec.delegation?.by}`);
    const concept = typeof body.concept === 'string' && body.concept.trim() ? body.concept.trim().slice(0, 200) : `pago de ${from}`;
    // Sin fee (decidido por Nicholas el 11-sep-2026): mandarle tokens a una persona es gratis, como un
    // mensaje. El fee de la casa (0,5%) es para el trabajo que alguien encarga: spot, escrow, mandatos.
    const asiento = await libro.post(concept, [{ account: from, delta: -body.amount }, { account: address, delta: body.amount }], { kind: 'pay', to: address, fee: 0 }, { op: ctx.env.id, op_sha256: ctx.opHash });
    // El aviso al que recibe obedece a su buzón, como si el pagador le escribiera. Defecto real
    // (revisión del 11-sep-2026): con pay sin fee, un pago de 1 token dejaba un sobre de libro@ en un
    // buzón que cobra 500 por mensaje. El pago ocurre igual y el saldo lo muestra; el aviso no pasa.
    const p = applyInboxPolicy({ from, to: [address], type: 'receipt' }, rec, null);
    const avisar = p.ok === true && (!p.stamp || body.amount >= p.stamp.price);
    return { result: { asiento, notified: avisar }, recibos: [{ to: avisar ? [from, address] : [from], body: { asiento, pay: { from, to: address, amount: body.amount, concept } } }] };
  },

  // --- lecturas: la respuesta vuelve por correo como recibo ---
  async balance(ctx) {
    const acc = await ctx.libro.account(ctx.from);
    return { result: acc, recibos: [{ to: [ctx.from], body: { account: acc.account, balance: acc.balance, contracts: acc.contracts.length, mandates: acc.mandates.length } }] };
  },
  async statement(ctx) {
    const raw = Number(ctx.body.limit);
    const n = Number.isInteger(raw) && raw > 0 ? Math.min(raw, 200) : 20;
    const entries = await ctx.libro.store.libroStatement(ctx.from, n);
    return { result: { entries }, recibos: [{ to: [ctx.from], body: { entries } }] };
  },
  async contract(ctx) {
    const c = await getContract(ctx.libro, ctx.body.contract);
    must(parties(c).includes(ctx.from), 403, 'you are not a party to this contract');
    return { result: { contract: c }, recibos: [{ to: [ctx.from], thread: c.id, body: { contract: c } }] };
  },
};

// ============ Tipos de contrato cotizables ============
export const CONTRATOS = {
  ops,
  // Spot: cotizar -> cobrar. Comprar un dato, un informe, una verificación.
  spot: { quoteable: true, async onAccept({ libro, c, refs }) {
    c.state = 'settled';
    return { asiento: await libro.transfer(c.buyer, c.seller, c.amount, `spot ${c.id}: ${c.concept}`, { contract: c.id }, refs, c.referrer) };
  } },
  // Escrow: retener al encargar -> liberar si la prueba pasa, devolver si falla. La cajita con dientes.
  escrow: { quoteable: true, async onAccept({ libro, c, refs }) {
    c.state = 'held';
    return { asiento: await libro.hold(c.buyer, c.id, c.amount, `escrow ${c.id}: ${c.concept}`, { contract: c.id }, refs) };
  } },
  // Medido: la aceptación crea un mandato del comprador al vendedor con tope = precio cotizado.
  metered: { quoteable: true, async onAccept({ libro, c, q, refs }) {
    const m = { id: uuid(), house: libro.domain, grantor: c.buyer, grantee: c.seller, cap: c.amount, spent: 0, scope: validarAlcance(q.terms?.scope, c.amount), expires: q.terms?.expires || q.expires || null,
      parent: null, root: c.buyer, chain: [], state: 'active', created: iso(), contract: c.id, op_sha256: refs.op_sha256 };
    m.chain = [m.id];
    libro.putMandate(m);
    c.state = 'active'; c.mandate = m.id;
    return { mandate: m };
  } },
  // Bond (fianza) no se cotiza: se deposita directamente con la operación `bond`.
  bond: { quoteable: false },
};

// ---------- vocabulario público: el ciclo de trabajo de ERC-8183 (ACP), sin la cadena ----------
// Los estados internos no cambian (romperlos rompería contratos vivos). Lo que se publica hacia
// afuera habla el vocabulario que ya existe, para que quien integró ACP entienda esto sin traducir.
//
//   Open       el trato existe pero el dinero todavía no se movió
//   Funded     hay tokens retenidos o comprometidos a nombre del trabajo
//   Submitted  el vendedor entregó y espera evaluación
//   Terminal   se acabó: liberado, devuelto, pagado o ejecutado
export const ACP = { accepted: 'Open', held: 'Funded', posted: 'Funded', active: 'Funded', delivered: 'Submitted', released: 'Terminal', refunded: 'Terminal', settled: 'Terminal', forfeited: 'Terminal' };
// Cómo terminó, para no perder información al agrupar en Terminal.
export const ACP_DESENLACE = { released: 'accepted', refunded: 'returned', settled: 'paid', forfeited: 'forfeited' };

export function estadoACP(contrato) {
  const s = contrato?.state;
  const fase = ACP[s] || 'Open';
  return { phase: fase, outcome: ACP_DESENLACE[s] || null, state: s };
}

// Vista pública de un contrato: lo mismo que hay, más el vocabulario ACP. No agrega ni oculta.
export function contratoPublico(contrato) {
  return contrato ? { ...contrato, acp: estadoACP(contrato) } : contrato;
}
