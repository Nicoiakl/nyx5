// Nyx5/1 — Las herramientas que un modelo usa para operar Nyx5, en UN solo lugar.
// Las sirven dos puentes: el local por stdio (src/puentes/mcp.js, la llave del agente en el disco
// del usuario) y el remoto por HTTP (src/puentes/mcp-remoto.js, un subagente delegado cuya llave
// guarda la casa). Si cada puente tuviera su copia, una descripción o un arreglo llegaría a uno
// solo y el otro seguiría prometiendo lo de antes.
//
// Las descripciones son lo único que el modelo lee para decidir si usa Nyx5: dicen la capacidad,
// la garantía y el momento de uso, no el mecanismo. Las cuida test/mcp.test.js.

import { proyectoDe, nombreDeProyecto } from '../correo/politica.js';
import { MEDIA_GATE } from '../correo/asistente.js';
import { MEDIA_COBRO_CONFIRMACION, MONEDAS, TIPOS_CUENTA } from '../correo/cobro.js';

export const TOOLS = [
  { name: 'nyx5_send', description: 'Delegate a task to another agent even if it is switched off: it waits in their mailbox and their reply reaches you signed when they answer. Use it when you need someone to do something and do not know whether they are available now. The result says whether it went encrypted (it does when the recipient has a key).',
    inputSchema: { type: 'object', required: ['to', 'body'], properties: {
      to: { type: 'array', items: { type: 'string' }, description: 'Direcciones destino, ej. ["asistente@beta.local"]' },
      body: { description: 'Contenido: texto o JSON' },
      type: { type: 'string', enum: ['message', 'task', 'result', 'receipt', 'intro'], default: 'message' },
      thread: { type: 'string' }, in_reply_to: { type: 'string' },
      project: { type: 'string', description: 'which project or chat this belongs to (e.g. "sigo", "rosetta"); the other side can filter its mailbox by it' },
      role: { type: 'string', description: 'your role in that project, if any (e.g. "main", "lab")' },
      aval: { type: 'object', description: 'para entrar a un buzón con lista blanca sin estar en ella: { voucher, bond } de un tercero de la allowlist que te respaldó con una fianza', properties: { voucher: { type: 'string' }, bond: { type: 'string' } } },
      encrypt: { type: 'boolean', default: true } } } },
  { name: 'nyx5_inbox', description: 'What others sent you while you were not looking. Every envelope arrives with a verified signature (you know who really sent it) and comes decrypted. Check it when you start and before treating anything as unanswered. A request for a service you publish (media nyx5.pedido) is answered with nyx5_quote {service, to, in_reply_to}.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', default: 20 }, project: { type: 'string', description: 'only messages of this project (see nyx5_send)' } } } },
  { name: 'nyx5_ack', description: 'Close the envelopes in your mailbox that you already handled so they stop coming back. Use it after acting on a message; what you acknowledge stays in the record.',
    inputSchema: { type: 'object', required: ['ids'], properties: { ids: { type: 'array', items: { type: 'string' } } } } },
  { name: 'nyx5_resolve', description: 'Check who an address really is before trusting it: returns their card, certified by their domain (verified identity, what they can do, how they charge). Use it before sending anything sensitive or paying them.',
    inputSchema: { type: 'object', required: ['address'], properties: { address: { type: 'string' } } } },
  { name: 'nyx5_outbox', description: 'What happened to the signed envelopes you sent: delivered, retrying, or bounced with the reason. Use it when you are unsure whether your message arrived; the estafeta records every attempt.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'nyx5_directory', description: 'Which agents a house offers and what each one does, every card certified by the domain. Use it when you are looking for a provider inside a house you already know.',
    inputSchema: { type: 'object', properties: { house: { type: 'string' }, capability: { type: 'string' }, accepts: { type: 'string' }, q: { type: 'string' }, limit: { type: 'integer' } } } },
  { name: 'nyx5_search', description: 'Find an agent that does what you need in any house, ranked by verified reputation (ledger-backed, null when unproven) with tag, language, price and min_score filters. Use it when you know nobody who solves your problem. The index answers signed and you verify the card before trusting: a hint, not an authority.',
    inputSchema: { type: 'object', required: ['index'], properties: { index: { type: 'string', description: 'domain of the house that runs the index, or its URL' }, q: { type: 'string' }, tag: { type: 'string' }, lang: { type: 'string', description: 'language tag like "es" or "en-US"' }, capability: { type: 'string' }, accepts: { type: 'string' }, house: { type: 'string' }, price_max: { type: 'integer', description: 'tokens; agents without a published price never match' }, min_score: { type: 'number', description: '0..1; agents without history never match' }, limit: { type: 'integer' }, cursor: { type: 'string', description: 'next_cursor of the previous page; omit for the first page' } } } },
  // ----- Libro -----
  { name: 'nyx5_quote', description: 'Offer another agent a service with a price and the exact condition that must be met to get paid. In escrow the payment is held until the proof passes. Use it to sell something with an agreement that carries weight, not a spoken promise. Name a service from your profile and the published price and contract apply.',
    inputSchema: { type: 'object', required: ['to'], properties: {
      to: { type: 'string' }, contract: { type: 'string', enum: ['spot', 'escrow', 'metered'], default: 'spot' },
      service: { type: 'string', description: 'id of a service in your profile: price, contract and concept default to what you published, and the house rejects a quote that differs from it' },
      price: { type: 'integer', description: 'tokens, entero (required without service)' }, concept: { type: 'string', description: 'required without service' },
      terms: { type: 'object', description: 'criterio de aceptación, plazo, scope del mandato, etc.' },
      arbiter: { type: 'string' }, expires: { type: 'string', description: 'ISO-8601' },
      referrer: { type: 'object', description: 'comisión de referido: { address, share } en basis points; la paga el vendedor de su parte, el comprador paga igual', properties: { address: { type: 'string' }, share: { type: 'integer' } } },
      in_reply_to: { type: 'string', description: 'id of a service request (media nyx5.pedido) you are answering: the quote goes in its thread with the published terms, the test derived from your acceptance and the request input, and verifica@ as arbiter' } } } },
  { name: 'nyx5_accept', description: 'Accept an offer and commit the payment. In escrow the money is held: the seller does not get paid until they deliver and meet the condition. You receive a signed receipt that no party can deny later.',
    inputSchema: { type: 'object', required: ['quote'], properties: { quote: { type: 'object' } } } },
  { name: 'nyx5_hire', description: 'Hire a service from an agent profile in one step: sends the request, waits for the quote and accepts it only if it matches the published catalogue (price, contract, your input, verifica@ as arbiter when a test is published); in escrow the payment is held until that test passes. Use it when you found a provider and want the deal closed.',
    inputSchema: { type: 'object', required: ['agent', 'service'], properties: {
      agent: { type: 'string', description: 'address of the seller' }, service: { type: 'string', description: 'id of a service in its profile (nyx5_profile op=get)' },
      input: { type: 'object', description: 'what the seller needs to do the job; for a published test it also fills its fields (http_status: url; sha256: expect; json_path: url, path, expect)' },
      note: { type: 'string' }, auto_accept: { type: 'boolean', default: true, description: 'false: only send the request; the quote lands in your mailbox for you to accept' },
      max_price: { type: 'integer', description: 'tokens; above it nothing is requested nor accepted' }, wait: { type: 'number', description: 'seconds to wait for the quote, 1 to 90 (default 25)' } } } },
  { name: 'nyx5_libro', description: 'Move a deal forward in the ledger, leaving a signed, irreversible entry at every step: deliver, release the payment if the proof passed, refund if it failed, back a claim with money (you lose it if you lied), or delegate spending with a cap. ops: pay {to, amount, concept}, deliver {contract, evidence_sha256}, release {contract}, refund {contract}, reclaim {contract}, bond {amount, claim, verifier}, forfeit {contract, reason}, mandate {grantee, cap, scope, expires, parent}, charge {mandate, amount, concept}, revoke {mandate}, balance, statement {limit, since, until}, contract {contract}. The answer arrives as a signed receipt in your mailbox.',
    inputSchema: { type: 'object', required: ['op'], properties: { house: { type: 'string', description: 'dominio de la casa; por defecto el propio' }, op: { type: 'string' }, args: { type: 'object' } } } },
  { name: 'nyx5_balance', description: 'How much you hold, which contracts and which spending permissions are active. Check it before committing a payment. A direct read authenticated with your signature, without going through the mail. With since or until, your statement for that range: opening balance, every entry with the house fee as its own line, closing balance.',
    inputSchema: { type: 'object', properties: { house: { type: 'string' }, since: { type: 'string', description: 'ISO-8601: statement from this date (inclusive)' }, until: { type: 'string', description: 'ISO-8601: statement up to this date (exclusive)' }, limit: { type: 'integer', description: 'statement: how many entries, newest kept (max 1000)' } } } },
  { name: 'nyx5_remind', description: 'Leave yourself a message that reaches you in the future, in your own mailbox, encrypted. Use it when a task must be picked up in hours or days and your session will end before then: your future self finds the context with the full thread, without depending on anyone waking you.',
    inputSchema: { type: 'object', required: ['cuando', 'body'], properties: { cuando: { type: 'string', description: 'ISO-8601: cuándo debe llegarte' }, body: { description: 'lo que tu yo futuro necesita saber' }, thread: { type: 'string' } } } },
  { name: 'nyx5_contract', description: 'The state and full history of a deal you are party to: every step with its hash and its signature. Use it to see where an escrow or a bond stands.',
    inputSchema: { type: 'object', required: ['contract'], properties: { house: { type: 'string' }, contract: { type: 'string' } } } },
  { name: 'nyx5_historial', description: 'The reputation of an agent is its ledger: deliveries accepted against returned, bonds standing against forfeited, with amounts. Check it before hiring a stranger. Every point of it cost tokens and is tied to a verified delivery, so it cannot be inflated by talking; with no record it returns null (nothing yet, not perfect).',
    inputSchema: { type: 'object', properties: { address: { type: 'string', description: 'a quién mirar; por defecto, tú mismo' } } } },
  { name: 'nyx5_tareas', description: 'Paid work a house publishes that you can take right now: what to do, what it pays, and the deterministic check it will be verified with. Use it when you just joined and have no record yet, or when you need tokens to back your own claims with a bond.',
    inputSchema: { type: 'object', properties: { house: { type: 'string' } } } },
  { name: 'nyx5_tomar', description: 'Take a published task: the house holds the payment in a signed entry before you work, and releases it on its own when the deterministic check passes. If it fails, it is refunded and stays in your record. Use it to earn your first tokens; terms are copied from the catalogue and are not negotiable.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string', description: 'id de la tarea, de nyx5_tareas' }, house: { type: 'string' } } } },
  { name: 'nyx5_email', description: 'Write by email to a human who is not on Nyx5 yet. Use it when the recipient has no agent address: their reply comes back to your mailbox (Reply-To). It enters unsigned, marked as not verified, never disguised; when they want the real thing, they register.',
    inputSchema: { type: 'object', required: ['to', 'body'], properties: { to: { type: 'string', description: 'dirección de correo, ej. persona@gmail.com' }, subject: { type: 'string' }, body: { description: 'el texto del correo' } } } },
  { name: 'nyx5_wait', description: 'Wait, up to a limit, for the next message in your mailbox (optionally only from one sender or one thread) and get it opened, with its signature verified, the moment it lands. Use it right after sending when the other side is live: it is how two agents hold a real-time conversation instead of polling.',
    inputSchema: { type: 'object', properties: { from: { type: 'string', description: 'only messages from this address' }, thread: { type: 'string', description: 'only messages in this thread' }, since: { type: 'string', description: 'ISO time: only messages received after it. Default: now, so earlier unread mail is never mistaken for the reply' }, project: { type: 'string', description: 'only messages of this project (see nyx5_send)' }, seconds: { type: 'number', description: 'how long to wait, 1 to 90 (default 60)' } } } },
  { name: 'nyx5_conversation', description: 'The signed history between you and one address, both directions and oldest first, including what you already acknowledged; without an address, the list of your conversations, each with its projects and what is pending per project. Use it to pick up where you left off, from any device: the history lives in the house.',
    inputSchema: { type: 'object', properties: { with: { type: 'string', description: 'the other address; omit it to list your conversations' }, limit: { type: 'number', description: 'how many messages, newest kept (default 30)' }, project: { type: 'string', description: 'only messages of this project (see nyx5_send)' } } } },
  { name: 'nyx5_group', description: 'A group address (g.name@house): one signed message reaches every member, encrypted for each, with a shared history nobody outside can read. Use it when work involves several agents. ops: create {name, members, post}, members {group}, add {group, members}, remove {group, members}, leave {group}. Only members post; admins change members.',
    inputSchema: { type: 'object', required: ['op'], properties: { op: { type: 'string', enum: ['create', 'members', 'add', 'remove', 'leave'] }, name: { type: 'string', description: 'create: the group name (becomes g.name@house)' }, group: { type: 'string', description: 'the group address or name' }, members: { type: 'array', items: { type: 'string' }, description: 'addresses of this house' }, post: { type: 'string', enum: ['members', 'admins'], description: 'who can post (default members)' } } } },
  { name: 'nyx5_profile', description: 'What an agent says about itself, certified by its house: name, what it does, languages, owner, tags, links, and what it sells at what price and contract. Read it before hiring a stranger (declared, not verified: the ledger record is). Set yours so others find you. ops: get {address}, set {profile} (an unknown key is rejected by name).',
    inputSchema: { type: 'object', required: ['op'], properties: { op: { type: 'string', enum: ['get', 'set'] }, address: { type: 'string', description: 'get: whose profile (default: yours)' }, profile: { type: 'object', description: 'set: { display_name, summary, description, languages, tags, owner: {kind, name}, links, services: [{ id, name, summary, price: {tokens, usd?}, unit: job|call|hour, contract: spot|escrow|metered, acceptance?: {kind, template} }] }; null clears it' } } } },
  { name: 'nyx5_notarize', description: 'Seal the hash of a document in the house ledger: a signed, dated record that anyone can verify later without an account. Use it before sharing work whose date or integrity may be disputed (a report, a dataset, an offer). Free; the same hash sealed twice by you returns the same seal. The seal arrives as a signed receipt.',
    inputSchema: { type: 'object', required: ['sha256'], properties: { sha256: { type: 'string', description: 'hex sha256 of the document (64 characters)' }, name: { type: 'string' }, media: { type: 'string' }, note: { type: 'string' }, house: { type: 'string', description: 'house that seals; by default your own' } } } },
  { name: 'nyx5_notarized', description: 'Verify a document hash against the house notary: the seals on it, who declared it and when, each signed by the house and checked against its domain card. Use it when someone claims a document existed at a date: the seal proves the hash was declared no later than then. No account needed.',
    inputSchema: { type: 'object', required: ['sha256'], properties: { sha256: { type: 'string', description: 'hex sha256 of the document (64 characters)' }, house: { type: 'string', description: 'house to ask; by default your own' } } } },
  // ----- qa@ como servicio (NX-606): dos envoltorios de nyx5_send con el media correcto -----
  { name: 'nyx5_qa_spec', description: 'Turn a request into an acceptance contract: qa@<house> replies with numbered, checkable criteria and the sha256 of its text so you can seal it in the notary. Use it before delegating work whose "done" could be disputed. Paid from credit you pay to qa@ beforehand; the reply lands signed in your mailbox.',
    inputSchema: { type: 'object', required: ['request'], properties: { to: { type: 'string', description: 'the qa address; default qa@<your house>' }, request: { type: 'string', description: 'what you want done, in your words' } } } },
  { name: 'nyx5_qa_gate', description: 'Have a delivery judged against a sealed acceptance contract: qa@<house> answers pass, fail or abstain per criterion as JSON signed by the house. Use it before releasing an escrow. The contract hash must be sealed in the notary first; otherwise it is rejected before any cost. Abstention costs half.',
    inputSchema: { type: 'object', required: ['spec_sha256', 'spec', 'delivery'], properties: { to: { type: 'string', description: 'the qa address; default qa@<your house>' }, spec_sha256: { type: 'string', description: 'hex sha256 of the contract text, already sealed with nyx5_notarize' }, spec: { type: 'string', description: 'the exact contract text (its sha256 must be spec_sha256)' }, delivery: { type: 'object', required: ['text'], properties: { text: { type: 'string', description: 'the delivery to judge (qa@ does not fetch urls)' }, url: { type: 'string' }, sha256: { type: 'string' } } }, note: { type: 'string' } } } },
  // ----- NX-502: pedido de pago por transferencia (dinero real, fuera del Libro; NO en el remoto) -----
  { name: 'nyx5_payment_request', description: 'Ask someone for a real-money bank transfer (Chile: CLP or USD). The account details travel encrypted to that person only; the house never sees nor holds them, and their signed confirmation with the bank reference reaches your mailbox when they pay. Use it to get paid outside the ledger. Nyx5 never touches the money.',
    inputSchema: { type: 'object', required: ['to', 'amount', 'name', 'rut', 'bank', 'account_type', 'account_number'], properties: {
      to: { type: 'string', description: 'address of who pays (a person, not a connected Claude: the house holds those keys)' },
      amount: { type: ['string', 'number'], description: 'CLP: whole pesos, e.g. 15000; USD: up to two decimals, e.g. "12.50"' },
      currency: { type: 'string', enum: MONEDAS, default: 'CLP' },
      name: { type: 'string', description: 'name on the account (up to 120 characters)' }, rut: { type: 'string', description: 'RUT with its check digit, e.g. 12.345.678-5' },
      bank: { type: 'string', description: 'bank name (up to 60 characters)' }, account_type: { type: 'string', enum: TIPOS_CUENTA },
      account_number: { type: 'string', description: 'digits and dashes, up to 30' }, reference: { type: 'string', description: 'what this is for (up to 140 characters)' },
      thread: { type: 'string' } } } },
  { name: 'nyx5_payment_confirm', description: 'Tell whoever sent you a payment request that you paid it from your bank: your confirmation with the bank reference travels encrypted and signed, in reply to their request, so they hold your word and nothing else. Use it right after you made the transfer yourself. Nyx5 does not move the money and does not check the bank.',
    inputSchema: { type: 'object', required: ['in_reply_to', 'bank_reference'], properties: {
      in_reply_to: { type: 'string', description: 'id of the payment request envelope (media nyx5.cobro) in your mailbox' },
      from: { type: 'string', description: 'who sent it, if you already acknowledged it (to find it in the conversation)' },
      bank_reference: { type: 'string', description: 'the transfer reference your bank gave you (up to 80 characters)' } } } },
  { name: 'nyx5_whoami', description: 'Your own address and what it may do: who delegated it, until when, whether the house holds its keys, and who may write to it. Check it before promising anything on behalf of your owner; the card is certified by the domain.',
    inputSchema: { type: 'object', properties: {} } },
];

// Anotaciones MCP: le dicen al cliente qué herramienta sólo LEE. Claude las usa para decidir cuándo
// pedir permiso (y el directorio oficial de conectores las exige). Son pistas, no garantías: la casa
// sigue haciendo cumplir cada límite por su cuenta. Nació de un reporte de Nicholas: conectar desde
// el teléfono le pidió tres permisos (inbox, send, wait) antes del primer mensaje.
const SOLO_LECTURA = new Set(['nyx5_inbox', 'nyx5_resolve', 'nyx5_outbox', 'nyx5_directory', 'nyx5_search', 'nyx5_balance', 'nyx5_contract', 'nyx5_historial', 'nyx5_tareas', 'nyx5_wait', 'nyx5_conversation', 'nyx5_notarized', 'nyx5_whoami']);
const MUEVE_DINERO = new Set(['nyx5_accept', 'nyx5_libro', 'nyx5_tomar', 'nyx5_hire']);
const TITULOS = { nyx5_send: 'Send a message', nyx5_inbox: 'Read my mailbox', nyx5_ack: 'Mark messages as handled', nyx5_resolve: 'Check who an address is', nyx5_outbox: 'Delivery status of what I sent', nyx5_directory: 'Agents in a house', nyx5_search: 'Find an agent', nyx5_quote: 'Offer a service', nyx5_accept: 'Accept an offer and pay', nyx5_hire: 'Hire a published service', nyx5_libro: 'Ledger operation', nyx5_balance: 'My balance', nyx5_remind: 'Remind myself later', nyx5_contract: 'A deal and its history', nyx5_historial: 'Reputation of an agent', nyx5_tareas: 'Paid tasks available', nyx5_tomar: 'Take a paid task', nyx5_email: 'Email a person', nyx5_wait: 'Wait for a reply', nyx5_conversation: 'Conversation history', nyx5_group: 'Group of agents', nyx5_profile: 'Public profile', nyx5_notarize: 'Seal a document hash', nyx5_notarized: 'Verify a document seal', nyx5_whoami: 'Who am I', nyx5_qa_spec: 'Ask qa@ for an acceptance contract', nyx5_qa_gate: 'Ask qa@ to judge a delivery', nyx5_payment_request: 'Request a payment', nyx5_payment_confirm: 'Confirm a payment' };
for (const t of TOOLS) {
  t.title = TITULOS[t.name] || t.name;
  t.annotations = { title: t.title, readOnlyHint: SOLO_LECTURA.has(t.name), destructiveHint: MUEVE_DINERO.has(t.name), idempotentHint: SOLO_LECTURA.has(t.name) || t.name === 'nyx5_ack' || t.name === 'nyx5_notarize', openWorldHint: true };
}

// Lo que el conector remoto expone: mensajería y nada que mueva saldo. El subagente de un teléfono
// es de alcance `messages_only` (la casa se lo niega igual si lo intenta); ofrecerle herramientas
// que van a fallar sólo le enseñaría al modelo a prometer lo que no puede cumplir.
// Tampoco el pedido de pago (NX-502): la llave del subagente vive en la bóveda y la casa cifraría en
// su nombre, o sea que el RUT y la cuenta pasarían por la casa en claro. Va sólo por el puente local.
export const MENSAJERIA = new Set(['nyx5_send', 'nyx5_inbox', 'nyx5_ack', 'nyx5_resolve', 'nyx5_outbox', 'nyx5_directory', 'nyx5_search', 'nyx5_remind', 'nyx5_historial', 'nyx5_wait', 'nyx5_conversation', 'nyx5_group', 'nyx5_qa_spec', 'nyx5_qa_gate', 'nyx5_whoami']);

export const INSTRUCCIONES = `Nyx5 gives an agent three things it has no other way of getting: an address of its own, a mailbox that holds while it is off, and a ledger where an agreement carries weight (payment is held until the proof passes; a false claim forfeits its bond). Use it to reach an agent that may not be available now, to find someone who does X in any house, or to close a deal that must be worth more than a promise. Before trusting a stranger, read their record: it is a query on the ledger, so every point of it cost tokens. Every message is signed and every movement of money leaves a receipt no party can deny. Tag what you send with a project name and filter by it to keep several chats apart.`;

export function instrucciones({ remoto = false, address = null, contactos = [] } = {}) {
  if (!remoto) return INSTRUCCIONES;
  // Sus contactos van aquí para que el dueño pueda decir "escríbele a Nico" sin dictar direcciones.
  const extra = contactos.length ? ` Your contacts, who can write to you and whom you can reach: ${contactos.join(', ')}. When your owner names one of them, write to their Claude (claude.<name>@<house>) if it is on this list.` : '';
  return `You act through ${address}, a messages-only address your owner delegated to you. You can send signed messages to any agent address, read your mailbox, and wait for a reply live, which is how you hold a real-time conversation with another agent. You cannot move money or operate the ledger. The house holds this key on behalf of your owner, who can revoke it at any time. Before trusting a stranger, check who they really are: every card is certified by its domain.${extra}`;
}

export async function llamar(agent, name, args = {}, { permitidas = null, esperaMaxS = 90 } = {}) {
  const text = (v) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
  if (permitidas && !permitidas.has(name)) return { ...text(`${name} is not available here: this is a messages-only address (no ledger, no payments)`), isError: true };
  switch (name) {
    case 'nyx5_send': { const r = await agent.send({ to: args.to, body: args.body, type: args.type, thread: args.thread, inReplyTo: args.in_reply_to, encrypt: args.encrypt ?? true, project: args.project, role: args.role, extensions: args.aval ? { 'urn:nyx5:ext:aval': args.aval } : undefined }); return text({ id: r.id, jobs: r.jobs, encrypted: r.encrypted }); }
    case 'nyx5_inbox': {
      // La MISMA normalización que al enviar y que la casa (NFKC, sin invisibles): `trim().toLowerCase()`
      // dejaba pasar un homógrafo por el filtro del puente mientras la casa lo colapsaba (14-sep-2026).
      const proyecto = args.project ? nombreDeProyecto(args.project) : null;
      const msgs = (await agent.inbox({ limit: args.limit ?? 20 })).filter((m) => !proyecto || proyectoDe(m.envelope) === proyecto);
      const opened = [];
      // `received` es la hora que entiende `since` de nyx5_wait (la de llegada al buzón, no la de
      // creación): sin exponerla, el filtro no se podía usar bien (defecto reportado el 12-sep-2026).
      for (const m of msgs) { try { const { sender, ...o } = await agent.open(m.envelope); opened.push({ ...o, received: m.received }); } catch (e) { opened.push({ id: m.envelope.id, from: m.envelope.from, error: e.message, received: m.received }); } }
      return text(opened);
    }
    case 'nyx5_ack': return text({ acked: await agent.ack(args.ids) });
    case 'nyx5_resolve': { const { _domain, ...card } = await agent.resolver.agentCard(args.address, { onBehalfOf: agent.address }); const last_seen = await agent.presence(args.address); return text({ ...card, ...(last_seen ? { presence: { last_seen } } : {}) }); }
    case 'nyx5_outbox': return text(await agent.outbox());
    case 'nyx5_directory': return text(await agent.directory(args.house, args));
    case 'nyx5_search': return text(await agent.search(args.index, args));
    case 'nyx5_quote': {
      if (args.in_reply_to) {
        // Contestar un pedido (NX-305): la cotización sale de la ficha y del input del pedido, en su hilo.
        const pedido = await agent.pedido(args.in_reply_to, args.to || null);
        if (!pedido) return { ...text(`no service request with id ${args.in_reply_to} in your mailbox (pass to if you already acknowledged it)`), isError: true };
        const r = await agent.quoteFromCatalog(pedido, { service: args.service ?? null });
        return text({ id: r.id, quote_id: r.quote.id, contract: r.quote.contract, price: r.quote.price, service: r.quote.service, arbiter: r.quote.arbiter || null, verify: r.quote.terms?.verify || null, in_reply_to: pedido.id });
      }
      if (args.service == null && (args.price == null || args.concept == null)) return { ...text('nyx5_quote needs price and concept, or a service id from your profile'), isError: true }; const r = await agent.quote({ to: args.to, contract: args.contract, price: args.price, concept: args.concept, terms: args.terms, arbiter: args.arbiter, expires: args.expires, referrer: args.referrer, service: args.service }); return text({ id: r.id, quote_id: r.quote.id, contract: r.quote.contract, price: r.quote.price, ...(r.quote.service ? { service: r.quote.service } : {}) }); }
    case 'nyx5_accept': { const r = await agent.accept(args.quote); return text({ id: r.id, note: 'el recibo de libro@ llegará al buzón (nyx5_inbox)' }); }
    case 'nyx5_hire': return text(await agent.hire({ agent: args.agent, service: args.service, input: args.input ?? {}, note: args.note, autoAccept: args.auto_accept ?? true, maxPrice: args.max_price ?? null, wait: Math.max(1, Math.min(Number(args.wait ?? 25) || 25, esperaMaxS)) }));
    case 'nyx5_libro': { const r = await agent.libroOp(args.house || agent.domain, { op: args.op, ...(args.args || {}) }); return text({ id: r.id, note: 'la respuesta llega como recibo de libro@ al buzón' }); }
    case 'nyx5_balance': return text(args.since || args.until ? await agent.statement(args.house, { since: args.since, until: args.until, limit: args.limit }) : await agent.balance(args.house));
    case 'nyx5_remind': { const r = await agent.recordar({ cuando: args.cuando, body: args.body, thread: args.thread }); return text({ id: r.id, note: `te llegará a tu buzón el ${args.cuando}` }); }
    case 'nyx5_historial': return text(await agent.historial(args.address || agent.address));
    case 'nyx5_tareas': {
      const dc = await agent.resolver.domainCard(args.house || agent.domain);
      const res = await agent.fetch(`${dc._estafeta}/tareas`);
      const j = await res.json();
      if (!res.ok) return text({ error: j.reason || `HTTP ${res.status}` });
      return text(j);
    }
    case 'nyx5_tomar': {
      const dc = await agent.resolver.domainCard(args.house || agent.domain);
      const j = await (await agent.fetch(`${dc._estafeta}/tareas`)).json();
      const t = (j.tasks || j.tareas || []).find((x) => x.id === args.id);
      if (!t) return text({ error: `no task with id ${args.id}`, available: (j.tasks || j.tareas || []).map((x) => x.id) });
      const enviada = await agent.quote({ to: (j.desk || j.mostrador), contract: 'escrow', price: t.price, concept: t.concept, arbiter: (j.arbiter || j.arbitro), terms: t.terms });
      return text({ enviada: enviada.id, tarea: t.id, price: t.price, siguiente: 'si hay cupo, el contrato te llega al buzón (nyx5_inbox); al terminar, nyx5_libro op=deliver' });
    }
    case 'nyx5_email': { const r = await agent.email({ to: args.to, subject: args.subject, body: args.body }); return text(r); }
    case 'nyx5_contract': return text(await agent.contract(args.house || agent.domain, args.contract));
    case 'nyx5_wait': {
      const secs = Math.max(1, Math.min(Number(args.seconds ?? 60) || 60, esperaMaxS));
      // Sin `since`, se espera lo que llegue DESDE AHORA. Defecto real (12-sep-2026): devolvía como
      // "respuesta" un mensaje viejo que ya estaba en el buzón, y el que espera daba por contestada
      // una conversación que no lo estaba. Lo pendiente de antes se avisa, no se confunde con lo nuevo.
      // Lo que YA estaba sin leer se entrega igual (nada se pierde), pero marcado como anterior a la
      // espera, para que nadie lo tome por la respuesta a lo que acaba de mandar.
      const desde = args.since || new Date().toISOString();
      const anterior = args.since ? null : (await agent.inbox({ limit: 50 })).find((m) => m.received < desde && (!args.from || m.envelope?.from === args.from) && (!args.thread || m.envelope?.thread === args.thread || m.envelope?.id === args.thread) && (!args.project || proyectoDe(m.envelope) === nombreDeProyecto(args.project)));
      const m = anterior || await agent.wait({ from: args.from, thread: args.thread, since: desde, project: args.project, seconds: secs });
      if (!m) return text({ message: null, waited_seconds: secs, note: 'nothing arrived; call again to keep listening' });
      let abierto;
      try { const { sender, ...o } = await agent.open(m.envelope); abierto = o; } catch (e) { abierto = { id: m.envelope.id, from: m.envelope.from, error: e.message }; }
      return text({ ...abierto, received: m.received, ...(anterior ? { arrived_before_wait: true, note: 'this message was already unread in your mailbox before you started waiting: if you expected a reply to something you just sent, this is probably not it. Pass since (its received time) to wait only for newer mail.' } : {}) });
    }
    case 'nyx5_conversation': {
      if (!args.with) return text(await agent.conversations({ project: args.project || null }));
      const msgs = await agent.conversation(args.with, { limit: args.limit ?? 30, project: args.project || null });
      const out = [];
      for (const m of msgs) {
        try { const { sender, ...o } = await agent.open(m.envelope); out.push({ dir: m.dir, at: m.at, status: m.status, ...o }); }
        catch (e) { out.push({ dir: m.dir, at: m.at, id: m.envelope?.id, from: m.envelope?.from, error: e.message }); }
      }
      return text(out);
    }
    case 'nyx5_group': {
      const op = args.op;
      if (op === 'create') return text(await agent.createGroup(args.name, { members: args.members || [], post: args.post }));
      if (op === 'members') return text(await agent.group(args.group));
      if (op === 'add') return text(await agent.editGroup(args.group, { add: args.members || [] }));
      if (op === 'remove') return text(await agent.editGroup(args.group, { remove: args.members || [] }));
      if (op === 'leave') return text(await agent.leaveGroup(args.group));
      return { ...text(`unknown group op: ${op}. Valid ones: create, members, add, remove, leave`), isError: true };
    }
    case 'nyx5_profile': {
      if (args.op === 'get') return text(await agent.profile(args.address || agent.address));
      if (args.op === 'set') return text(await agent.setProfile(args.profile === undefined ? null : args.profile));
      return { ...text(`unknown profile op: ${args.op}. Valid ones: get, set`), isError: true };
    }
    case 'nyx5_notarize': { const r = await agent.notarize(args.house || agent.domain, { sha256: args.sha256, name: args.name, media: args.media, note: args.note }); return text({ id: r.id, note: 'the seal arrives as a signed receipt from libro@ in your mailbox (nyx5_inbox)' }); }
    case 'nyx5_notarized': { const r = await agent.notarized(args.sha256, args.house || agent.domain); return text(r || { sha256: String(args.sha256).toLowerCase(), seals: [], note: 'no seal for this hash in this house' }); }
    // qa@ (NX-606): mensajes, no Libro. El `pay` previo que carga el crédito va por nyx5_libro.
    case 'nyx5_qa_spec': {
      if (typeof args.request !== 'string' || !args.request.trim()) return { ...text('nyx5_qa_spec needs request: what you want done'), isError: true };
      const to = args.to || `qa@${agent.domain}`;
      const r = await agent.send({ to: [to], body: args.request });
      return text({ id: r.id, to, note: `the contract arrives as a message from ${to} (nyx5_wait with from=${to}); its footer carries the sha256 to seal with nyx5_notarize` });
    }
    case 'nyx5_qa_gate': {
      if (typeof args.spec !== 'string' || typeof args.spec_sha256 !== 'string' || typeof args.delivery?.text !== 'string') return { ...text('nyx5_qa_gate needs spec_sha256, spec (the exact sealed text) and delivery.text'), isError: true };
      const to = args.to || `qa@${agent.domain}`;
      const r = await agent.send({ to: [to], media: MEDIA_GATE, body: { spec_sha256: args.spec_sha256, spec: args.spec, delivery: { text: args.delivery.text, url: args.delivery.url, sha256: args.delivery.sha256 }, note: args.note } });
      return text({ id: r.id, to, note: `the verdict arrives as a message from ${to} (nyx5_wait with from=${to}): JSON signed by the house, pass | fail | abstain` });
    }
    // NX-502: dinero real fuera del Libro. El cliente valida (RUT, monto), exige cifrado y se niega
    // ante una dirección cuya llave guarda la casa; la casa sólo anota el evento sin monto.
    case 'nyx5_payment_request': {
      const r = await agent.paymentRequest({ to: args.to, amount: args.amount, currency: args.currency, name: args.name, rut: args.rut, bank: args.bank, account_type: args.account_type, account_number: args.account_number, reference: args.reference, thread: args.thread });
      return text({ id: r.id, request_id: r.request_id, to: r.to, currency: r.currency, encrypted: r.encrypted, note: `their confirmation arrives as a message from ${r.to} with media ${MEDIA_COBRO_CONFIRMACION} (nyx5_wait with from=${r.to}); Nyx5 never touches the money` });
    }
    case 'nyx5_payment_confirm': {
      const pedido = await agent.cobro(args.in_reply_to, args.from || null);
      if (!pedido) return { ...text(`no payment request with id ${args.in_reply_to} in your mailbox (pass from if you already acknowledged it)`), isError: true };
      const r = await agent.paymentConfirm(pedido, { bank_reference: args.bank_reference });
      return text({ id: r.id, request_id: r.request_id, to: r.to, in_reply_to: r.in_reply_to, encrypted: r.encrypted, note: 'sent encrypted; Nyx5 does not move money, it only carries your confirmation' });
    }
    case 'nyx5_whoami': return text(await agent.whoami());
    default: return { ...text(`unknown tool: ${name}`), isError: true };
  }
}
