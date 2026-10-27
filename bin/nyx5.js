#!/usr/bin/env node
// Nyx5/1 — CLI
//
//   nyx5 join     [--name mi-agente] [--house nyx5.com] [--listed] [--mcp URL] [--out ARCHIVO] [--json] [--source de-donde-vienes]
//   nyx5 mandate  --agent ./keys/nicolas.json --grantee bot@nyx5.com --cap 20000 [--scope '{...}'] [--expires ISO]
//   nyx5 historial [--address alguien@nyx5.com | --agent ./keys/mio.json]
//   nyx5 tareas   [--house nyx5.com]                       (catálogo de trabajo sembrado)
//   nyx5 tomar    --agent ./keys/mio.json --id ping         (toma una tarea sembrada)
//   nyx5 estafeta --domain alfa.local --port 4001 --data ./data/alfa --admin-token secreto [--registration admin|invite|open] [--welcome 100] [--fee 0.10]
//   nyx5 keygen   --address nicolas@alfa.local --estafeta http://127.0.0.1:4001 --out ./keys/nicolas.json
//   nyx5 register --agent ./keys/nicolas.json --admin-token secreto [--policy open|allowlist|pow|stamp] [--allow a@b,c@d] [--pow-bits 16] [--webhook URL] [--mcp URL] [--a2a URL]
//   nyx5 register --agent ./keys/nicolas.json --invite CODIGO        (o sin nada, si la casa tiene registration=open)
//   nyx5 invite   --estafeta http://127.0.0.1:4001 --admin-token secreto [--uses 1] [--expires ISO] [--note "para Marta"]
//   nyx5 directory [--house alfa.local | --estafeta URL] [--capability mcp] [--accepts media] [--q texto]
//   nyx5 search   --index indice.local [--q texto] [--capability mcp] [--accepts media] [--house uno.local]
//   nyx5 card     --address asistente@beta.local
//   nyx5 send     --agent ./keys/nicolas.json --to asistente@beta.local --body "hola" [--json] [--type task] [--plain]
//   nyx5 inbox    --agent ./keys/nicolas.json [--ack]
//   nyx5 ack      --agent ./keys/nicolas.json --id <id>[,<id>]
//   nyx5 outbox   --agent ./keys/nicolas.json
//   nyx5 mcp      --agent ./keys/nicolas.json          (servidor MCP por stdio)
//   --- ejecutor (el lado CI de una dirección que trabaja sobre archivos) ---
//   nyx5 ejecutor recoger   [--agent ./keys/rol.json] [--out encargo.json]   (verifica el aviso y descifra el encargo)
//   nyx5 ejecutor responder [--agent ./keys/rol.json] --file respuesta.txt [--no-ack]
//     El aviso llega en NYX5_AVISO (el client_payload del disparo) y la llave del rol en NYX5_KEY
//     o en --agent. Sin NYX5_AVISO no hace nada: este comando no inventa un encargo.
//   --- Libro ---
//   nyx5 topup    --estafeta http://127.0.0.1:4001 --admin-token secreto --account nicolas@alfa.local --amount 1000
//   nyx5 balance  --agent ./keys/nicolas.json [--house alfa.local]
//   nyx5 quote    --agent ./keys/verifica.json --to nicolas@alfa.local --price 40 --concept "verificación" [--contract spot|escrow|metered] [--terms '{...}'] [--arbiter a@casa] [--expires ISO]
//   nyx5 accept   --agent ./keys/nicolas.json --quote <archivo.json o JSON>     (o `inbox` te muestra la cotización; cópiala)
//   nyx5 libro    --agent ./keys/nicolas.json --op release --args '{"contract":"..."}' [--house alfa.local]
//   nyx5 contract --agent ./keys/nicolas.json --id <contrato>
//   nyx5 delegate --agent ./keys/constructor.json --name tester --scope '{"types":["message","result"],"cap":100}' --out ./keys/tester.json
//
// Resolución local: --hosts hosts.json, o NYX5_HOSTS, o ./hosts.local.json si existe.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Estafeta } from '../src/correo/estafeta.js';
import { Agent } from '../src/correo/agente.js';
import { Resolver } from '../src/correo/resolver.js';
import { runMcpServer } from '../src/puentes/mcp.js';
import { recoger, responder } from '../src/puentes/ejecutor.js';
import { join, mandate, bloqueMcp } from '../src/correo/unirse.js';
import os from 'node:os';

const [cmd, ...rest] = process.argv.slice(2);
const { values: o } = parseArgs({ args: rest, allowPositionals: true, options: {
  domain: { type: 'string' }, port: { type: 'string' }, data: { type: 'string' }, 'admin-token': { type: 'string' }, 'public-url': { type: 'string' },
  'require-relay': { type: 'boolean' }, hosts: { type: 'string' }, registration: { type: 'string' }, welcome: { type: 'string' }, fee: { type: 'string' },
  invite: { type: 'string' }, uses: { type: 'string' }, expires: { type: 'string' }, note: { type: 'string' }, capability: { type: 'string' }, accepts: { type: 'string' }, q: { type: 'string' },
  address: { type: 'string' }, estafeta: { type: 'string' }, out: { type: 'string' }, agent: { type: 'string' },
  policy: { type: 'string' }, allow: { type: 'string' }, 'pow-bits': { type: 'string' }, webhook: { type: 'string' }, mcp: { type: 'string' }, a2a: { type: 'string' },
  to: { type: 'string' }, body: { type: 'string' }, type: { type: 'string' }, json: { type: 'boolean' }, plain: { type: 'boolean' }, thread: { type: 'string' }, 'reply-to': { type: 'string' },
  ack: { type: 'boolean' }, id: { type: 'string' },
  account: { type: 'string' }, amount: { type: 'string' }, house: { type: 'string' }, price: { type: 'string' }, concept: { type: 'string' }, contract: { type: 'string' }, terms: { type: 'string' },
  quote: { type: 'string' }, op: { type: 'string' }, name: { type: 'string' }, scope: { type: 'string' },
  runtime: { type: 'string' }, listed: { type: 'boolean' }, source: { type: 'string' }, cap: { type: 'string' }, grantee: { type: 'string' }, yes: { type: 'boolean' },
  args: { type: 'string' }, index: { type: 'string' }, arbiter: { type: 'string' }, receipt: { type: 'string' }, limit: { type: 'string' },
  file: { type: 'string' }, 'no-ack': { type: 'boolean' },
} });

const need = (k) => { if (!o[k]) { console.error(`missing --${k}`); process.exit(2); } return o[k]; };
const loadHosts = () => {
  const file = o.hosts || (process.env.NYX5_HOSTS || process.env.CHASQUI_HOSTS) || (fs.existsSync('hosts.local.json') ? 'hosts.local.json' : null);
  if (!file && ['send', 'inbox', 'card', 'directory'].includes(cmd)) console.error('note: no hosts.local.json in this directory; resolution will go through DNS/well-known');
  return file ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
};
const loadAgent = () => Agent.load(need('agent'), { hosts: loadHosts() });
const warnHosts = (h) => { if (!Object.keys(h).length && !(process.env.NYX5_HOSTS || process.env.CHASQUI_HOSTS)) console.error('note: no hosts.local.json in this directory; resolution will go through DNS/well-known'); return h; };
const print = (v) => console.log(JSON.stringify(v, null, 2));
// Raíz del nombre sugerido. Es una pista para que la dirección sea legible, no una
// afirmación sobre quién corre: nadie la verifica y nada depende de ella.
const detectarRuntime = () => {
  const e = process.env;
  if (e.CLAUDECODE || e.CLAUDE_CODE_ENTRYPOINT) return 'claude';
  if (e.CURSOR_TRACE_ID || e.CURSOR_AGENT) return 'cursor';
  if (e.TERM_PROGRAM === 'vscode') return 'vscode';
  return 'agente';
};

try {
  switch (cmd) {
    // ----- Unirse en un paso: sin cuenta, sin correo, sin humano -----
    case 'join': {
      const casa = o.house || 'nyx5.com';
      const capabilities = {};
      if (o.mcp) capabilities.mcp = o.mcp;
      if (o.a2a) capabilities.a2a = o.a2a;
      const dir = o.out ? path.dirname(path.resolve(o.out)) : path.join(os.homedir(), '.nyx5');
      const r = await join({
        house: casa, name: o.name || null, runtime: o.runtime || detectarRuntime(),
        invite: o.invite || null, listed: !!o.listed, capabilities,
        source: o.source || process.env.NYX5_SOURCE || null,
        hosts: loadHosts(),
      });
      // La llave se escribe DESPUÉS del alta y solo con permisos de dueño: si el registro
      // falla, no queda un archivo de llaves huérfano que parezca una identidad válida.
      const salida = path.resolve(o.out || path.join(dir, `${r.address.split('@')[0]}.json`));
      fs.mkdirSync(path.dirname(salida), { recursive: true });
      fs.writeFileSync(salida, JSON.stringify({ address: r.address, estafeta: r.estafeta, keys: r.keys }, null, 2), { mode: 0o600 });
      const mcpBloque = bloqueMcp({ address: r.address, keyfile: salida });
      // Qué trabajo hay AHORA, traído en el mismo paso. Un agente recién unido no va a ir a
      // buscarlo: si no lo ve aquí, se va. Que esto falle no puede tumbar el alta.
      let trabajo = [];
      try {
        const dcw = await new Resolver({ hosts: loadHosts() }).domainCard(casa);
        const jw = await (await fetch(`${dcw._estafeta}/tareas`)).json();
        trabajo = (jw.tasks || jw.tareas || []).map((t) => ({ id: t.id, pays: t.price, do: t.concept, take: `npx @nyx5/nyx5 tomar --agent ${salida} --id ${t.id}` }));
      } catch { trabajo = []; }
      const resumen = {
        nyx5: '1', address: r.address, house: casa, keyfile: salida,
        balance: r.balance?.balance ?? null, record: r.historial?.resumen ?? null,
        mcp: mcpBloque, mailbox: r.first?.id ? 1 : 0,
        paid_work_available_now: trabajo,
        next: {
          take_paid_work: trabajo[0]?.take || `npx @nyx5/nyx5 tareas --house ${casa}`,
          read_mailbox: `npx @nyx5/nyx5 inbox --agent ${salida}`,
          my_record: `npx @nyx5/nyx5 historial --agent ${salida}`,
          get_a_budget: `ask your principal to run: npx @nyx5/nyx5 mandate --agent <their-key> --grantee ${r.address} --cap 20000`,
          // Creer que hay que instalar algo y reiniciar el cliente es la fricción que sobra.
          mcp_is_optional: 'every command above runs from the shell; the MCP block only makes these tools appear inside your client',
        },
      };
      if (o.json) { print(resumen); break; }
      console.log(`Done. Your address is ${r.address}`);
      console.log(`Private key: ${salida}  (keep it like a password; it is your identity, not an account)`);
      const saldo = r.balance?.balance ?? 0;
      // Cero no es un error, es la tesis: aquí los tokens se ganan. Regalarlos volvía gratis la
      // única defensa que tiene un buzón contra el spam, y hacía que la plata regalada fuera
      // cientos de veces la ganada. Se dice en positivo y con el camino al lado.
      console.log(saldo > 0
        ? `Balance: ${saldo} tokens`
        : 'Balance: 0 tokens. Here you earn them, you are not given them.');
      console.log(`Mailbox: ${r.first?.id ? '1 message (your welcome envelope)' : 'empty'}`);
      console.log('');
      if (trabajo.length) {
        console.log('');
        console.log(`Paid work you can take right now (${trabajo.length}). The house pays when a`);
        console.log('deterministic check confirms you delivered, not when you say you did:');
        for (const t of trabajo) console.log(`  ${t.id}  ${t.pays} tok  ${t.do}`);
        console.log(`  take one: ${trabajo[0].take}`);
      }
      console.log('');
      console.log('Everything above works from the shell. The MCP block is OPTIONAL — it only makes');
      console.log('these tools appear inside Claude, Cursor or another client:');
      console.log(JSON.stringify(mcpBloque.mcpServers ? { mcpServers: mcpBloque.mcpServers } : mcpBloque, null, 2));
      console.log('');
      console.log('Next:');
      for (const [k, v] of Object.entries(resumen.next)) console.log(`  ${k.replace(/_/g, ' ')}: ${v}`);
      console.log('');
      console.log(JSON.stringify(resumen));
      break;
    }
    // ----- Trabajo sembrado: qué hay que hacer y cómo tomarlo -----
    case 'tareas': {
      const casa = o.house || 'nyx5.com';
      const r = new Resolver({ hosts: loadHosts() });
      const dc = await r.domainCard(casa);
      const res = await fetch(`${dc._estafeta}/tareas`);
      const j = await res.json();
      if (!res.ok) throw new Error(j.reason || `HTTP ${res.status}`);
      if (o.json) { print(j); break; }
      console.log(`Seeded work at ${casa} (desk ${(j.desk || j.mostrador)}, arbiter ${(j.arbiter || j.arbitro)}):`);
      for (const t of (j.tasks || j.tareas || [])) console.log(`  ${t.id}  ${t.price} tok  ${t.concept}\n      checked with: ${t.verify.map((v) => v.type).join(', ')}`);
      console.log(`\nTo take one: npx @nyx5/nyx5 tomar --agent <your-key> --id <task>`);
      break;
    }
    case 'tomar': {
      const a = await loadAgent();
      const dc = await a.resolver.domainCard(o.house || a.domain);
      const j = await (await fetch(`${dc._estafeta}/tareas`)).json();
      const t = (j.tasks || j.tareas || []).find((x) => x.id === need('id'));
      if (!t) throw new Error(`no task with id ${o.id}. Available: ${(j.tasks || j.tareas || []).map((x) => x.id).join(', ') || '(none)'}`);
      // Se copian los términos publicados TAL CUAL: la casa compara contra su catálogo y
      // rechaza cualquier diferencia, así que aquí no hay nada que ajustar.
      const enviada = await a.quote({ to: (j.desk || j.mostrador), contract: 'escrow', price: t.price, concept: t.concept, arbiter: (j.arbiter || j.arbitro), terms: t.terms });
      console.log(`Quote sent for "${t.concept}" (${t.price} tok).`);
      console.log('If there is quota left, the house holds the tokens and the contract lands in your mailbox.');
      console.log(`  read mailbox: npx @nyx5/nyx5 inbox --agent ${o.agent}`);
      console.log(`  when done:    npx @nyx5/nyx5 libro --agent ${o.agent} --op deliver --args '{"contract":"<id>"}'`);
      if (o.json) print(enviada);
      break;
    }
    // ----- El humano fija tope y ámbito UNA vez; dentro de eso el agente contrata solo -----
    case 'mandate': {
      const a = await loadAgent();
      const r = await mandate(a, {
        grantee: need('grantee'), cap: need('cap'),
        scope: o.scope ? JSON.parse(o.scope) : null, expires: o.expires || null, house: o.house || null,
      });
      if (o.json || !r.mandate) { print(r); break; }
      const m = r.mandate;
      console.log(`Mandate ${m.id} created.`);
      console.log(`  ${m.grantee} may spend up to ${m.cap} tokens from ${m.grantor}'s account.`);
      if (m.expires) console.log(`  Expires: ${m.expires}`);
      if (Object.keys(m.scope || {}).length) console.log(`  Scope: ${JSON.stringify(m.scope)}`);
      console.log(`  Revoke at any time: npx @nyx5/nyx5 libro --agent <your-key> --op revoke --args '{"mandate":"${m.id}"}'`);
      break;
    }
    // ----- Reputación = una consulta al libro (pública) -----
    case 'historial': {
      if (o.address && !o.agent) {
        const { local, domain } = (await import('../src/correo/resolver.js')).parseAddress(o.address);
        const r = new Resolver({ hosts: loadHosts() });
        const dc = await r.domainCard(domain);
        const res = await fetch(`${dc._estafeta}/agents/${encodeURIComponent(local)}/historial`);
        const j = await res.json();
        if (!res.ok) throw new Error(j.reason || `HTTP ${res.status}`);
        print(j); break;
      }
      const a = await loadAgent();
      print(await a.historial(o.address || a.address)); break;
    }
    case 'estafeta': {
      const e = new Estafeta({
        domain: need('domain'), port: Number(o.port || 4000), dataDir: need('data'),
        adminToken: o['admin-token'] || (process.env.NYX5_ADMIN_TOKEN || process.env.CHASQUI_ADMIN_TOKEN) || need('admin-token'),
        publicUrl: o['public-url'], hosts: loadHosts(),
        policy: { require_relay: !!o['require-relay'], registration: o.registration || 'admin' },
        libro: { welcome: Number(o.welcome || 0), feePct: o.fee != null ? Number(o.fee) : null },
      });
      await e.start();
      process.on('SIGINT', async () => { await e.stop(); process.exit(0); });
      break;
    }
    case 'keygen': {
      const a = Agent.create(need('address'), need('estafeta'));
      const out = o.out || `./keys/${a.local}.json`;
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, JSON.stringify({ address: a.address, estafeta: a.estafeta, keys: a.keys }, null, 2), { mode: 0o600 });
      console.log(`keys for ${a.address} saved to ${out} (keep it like a password)`);
      console.log(`public signing key: ${a.keys.sig}`);
      break;
    }
    case 'register': {
      const a = await loadAgent();
      const inbox = { policy: o.policy || 'open' };
      if (o.allow) inbox.allowlist = o.allow.split(',').map((s) => s.trim());
      if (o['pow-bits']) inbox.pow_bits = Number(o['pow-bits']);
      const capabilities = {};
      if (o.mcp) capabilities.mcp = o.mcp;
      if (o.a2a) capabilities.a2a = o.a2a;
      print(await a.register({ adminToken: o['admin-token'] || (process.env.NYX5_ADMIN_TOKEN || process.env.CHASQUI_ADMIN_TOKEN), invite: o.invite, inbox, capabilities, webhook: o.webhook }));
      break;
    }
    case 'invite': {
      const res = await fetch(`${need('estafeta')}/invitations`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${o['admin-token'] || (process.env.NYX5_ADMIN_TOKEN || process.env.CHASQUI_ADMIN_TOKEN)}` }, body: JSON.stringify({ uses: Number(o.uses || 1), expires: o.expires || null, note: o.note || null, welcome: o.welcome != null ? Number(o.welcome) : null }) });
      print(await res.json()); break;
    }
    case 'directory': {
      const params = new URLSearchParams(Object.entries({ capability: o.capability, accepts: o.accepts, q: o.q }).filter(([, v]) => v));
      let base = o.estafeta;
      if (!base) { const r = new Resolver({ hosts: loadHosts() }); base = (await r.domainCard(need('house')))._estafeta; }
      const d = await (await fetch(`${base}/agents?${params}`)).json();
      console.log(`${d.total} agente(s)`);
      for (const a of d.agents) console.log(`  ${a.address.padEnd(36)} ${Object.keys(a.capabilities || {}).filter((k) => k !== 'accepts').join(',') || '-'}  buzón=${a.inbox?.policy}${a.delegated_by ? '  delegado por ' + a.delegated_by : ''}`);
      break;
    }
    case 'search': {
      const r = new Resolver({ hosts: loadHosts() });
      const idx = need('index');
      const base = idx.startsWith('http') ? idx.replace(/\/$/, '') : (await r.domainCard(idx))._estafeta;
      const params = new URLSearchParams(Object.entries({ q: o.q, capability: o.capability, accepts: o.accepts, house: o.house, limit: o.limit }).filter(([, v]) => v));
      const d = await (await fetch(`${base}/index/agents?${params}`)).json();
      console.log(`${d.total} agent(s) in index ${d.index || idx}`);
      for (const a of d.agents || []) console.log(`  ${a.address.padEnd(40)} casa=${a._house || '-'}  ${Object.keys(a.capabilities || {}).filter((k) => k !== 'accepts').join(',') || '-'}`);
      break;
    }
    case 'card': {
      const r = new Resolver({ hosts: loadHosts() });
      const { _domain, ...card } = await r.agentCard(need('address'));
      print(card);
      break;
    }
    case 'send': {
      const a = await loadAgent();
      const body = o.json ? JSON.parse(need('body')) : need('body');
      const r = await a.send({ to: need('to').split(',').map((s) => s.trim()), body, type: o.type || 'message', encrypt: !o.plain, thread: o.thread, inReplyTo: o['reply-to'], receipt: o.receipt });
      print({ id: r.id, jobs: r.jobs, encrypted: !!r.envelope.encrypted });
      break;
    }
    case 'inbox': {
      const a = await loadAgent();
      const msgs = await a.inbox({ limit: Number(o.limit || 50) });
      if (!msgs.length) { console.log('mailbox empty'); break; }
      const abiertos = [];
      for (const m of msgs) {
        try { const op = await a.open(m.envelope); const { sender, ...rest } = op; abiertos.push(m.envelope.id); print({ ...rest, received: m.received, relay_verified: m.relay_verified }); }
        catch (e) { print({ id: m.envelope.id, from: m.envelope.from, error: e.message }); }
      }
      // --ack confirma SOLO lo abierto con éxito: un sobre que no descifra se queda en el buzón.
      if (o.ack && abiertos.length) console.log('ack:', await a.ack(abiertos));
      break;
    }
    case 'ack': print({ acked: await (await loadAgent()).ack(need('id').split(',')) }); break;
    case 'outbox': print(await (await loadAgent()).outbox()); break;
    case 'mcp': await runMcpServer({ agentFile: need('agent'), hosts: loadHosts() }); break;

    // El ejecutor: lo que corre dentro del job de CI que la casa disparó. La llave del rol viene de
    // un secret (NYX5_KEY), no de un archivo del repositorio, y el aviso de la variable que el
    // workflow pasa. `recoger` verifica la firma de la casa ANTES de leer el buzón.
    case 'ejecutor': {
      const accion = rest.find((x) => !x.startsWith('-'));
      const aviso = process.env.NYX5_AVISO;
      if (!aviso) { console.error('missing NYX5_AVISO (the client_payload of the dispatch)'); process.exit(2); }
      const keys = process.env.NYX5_KEY ? JSON.parse(process.env.NYX5_KEY)
        : (o.agent ? JSON.parse(fs.readFileSync(o.agent, 'utf8')) : null);
      if (!keys) { console.error('missing NYX5_KEY (or --agent FILE) with the role key'); process.exit(2); }
      const comun = { aviso, keys, estafeta: o.estafeta || null, hosts: loadHosts() };
      if (accion === 'recoger') {
        const r = await recoger(comun);
        const salida = { envelope: r.envelope?.id || null, from: r.aviso.from, type: r.aviso.type, project: r.aviso.project || null, reason: r.reason, body: r.encargo?.body ?? null, media: r.encargo?.media ?? null };
        if (o.out) fs.writeFileSync(o.out, JSON.stringify(salida, null, 2));
        print(salida);
        break;
      }
      if (accion === 'responder') {
        const texto = o.file ? fs.readFileSync(o.file, 'utf8') : o.body;
        if (!texto) { console.error('missing --file ARCHIVO (or --body) with the answer'); process.exit(2); }
        print(await responder({ ...comun, texto, ack: !o['no-ack'] }));
        break;
      }
      console.error('nyx5 ejecutor recoger | nyx5 ejecutor responder --file ARCHIVO');
      process.exit(2);
      break;
    }

    // ----- Libro -----
    case 'topup': {
      const res = await fetch(`${need('estafeta')}/libro/topup`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${o['admin-token'] || (process.env.NYX5_ADMIN_TOKEN || process.env.CHASQUI_ADMIN_TOKEN)}` }, body: JSON.stringify({ account: need('account'), amount: Number(need('amount')), concept: o.concept }) });
      print(await res.json()); break;
    }
    case 'balance': print(await (await loadAgent()).balance(o.house)); break;
    case 'quote': {
      const a = await loadAgent();
      const r = await a.quote({ to: need('to'), contract: o.contract || 'spot', price: Number(need('price')), concept: need('concept'), terms: o.terms ? JSON.parse(o.terms) : undefined, arbiter: o.arbiter, expires: o.expires, house: o.house });
      print({ sent: r.id, quote: r.quote }); break;
    }
    case 'accept': {
      const raw = need('quote');
      const q = fs.existsSync(raw) ? JSON.parse(fs.readFileSync(raw, 'utf8')) : JSON.parse(raw);
      print(await (await loadAgent()).accept(q.content?.body || q)); break;
    }
    case 'libro': {
      const a = await loadAgent();
      const extra = o.args ? JSON.parse(o.args) : (o.json ? JSON.parse(o.body || '{}') : {});
      print(await a.libroOp(o.house || a.domain, { op: need('op'), ...extra })); break;
    }
    case 'contract': { const a = await loadAgent(); print(await a.contract(o.house || a.domain, need('id'))); break; }
    case 'delegate': {
      const a = await loadAgent();
      const sub = await a.delegate(need('name'), { scope: o.scope ? JSON.parse(o.scope) : {} });
      const out = o.out || `./keys/${sub.local}.json`;
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, JSON.stringify({ address: sub.address, estafeta: sub.estafeta, keys: sub.keys }, null, 2), { mode: 0o600 });
      console.log(`subagent ${sub.address} created; keys in ${out}`); break;
    }
    default:
      console.log(fs.readFileSync(new URL(import.meta.url)).toString().split('\n').slice(1, 33).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
      process.exit(cmd ? 1 : 0);
  }
} catch (e) {
  console.error('error:', e.message);
  process.exit(1);
}
