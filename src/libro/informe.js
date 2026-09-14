// El libro de la casa, en una página pública. Qué se movió de verdad, qué se devolvió y qué
// fianzas cayeron.
//
// Es el único contenido sobre este sistema que nadie más puede producir, y está escrito para
// poder decir cosas incómodas: si no se unió nadie lo dice, y si hay agentes pero ningún humano
// puso presupuesto lo dice con todas las letras. Un informe que solo sabe dar buenas noticias no
// es un informe, es publicidad — y aquí la tesis entera es que una afirmación cuesta algo.
//
// Se calcula al pedirlo, no en un cron semanal: así nunca está viejo, y no hay un trabajo de
// fondo que pueda fallar en silencio y dejar publicado un número de hace un mes.
//
// Qué NO sale: nombres de agentes, contrapartes, contenido de mensajes. Solo cuántos y cuánto.
// El historial de cada agente ya es público por separado, y ahí es donde tiene sentido mirar
// a alguien en concreto.

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function datosInforme(estafeta, { dias = 7 } = {}) {
  const desde = new Date(Date.now() - dias * 86_400_000).toISOString();
  const eventos = (await estafeta.store.listEvents?.({ since: desde, limit: 2000 })) || [];
  const contratos = await estafeta.store.libroListContracts();

  const cuenta = (n) => eventos.filter((e) => e.name === n).length;
  const terminales = { spot: ['settled'], escrow: ['released', 'refunded'], bond: ['released', 'forfeited'] };
  const recientes = contratos.filter((c) => (c.created || '') >= desde);
  const suma = (pred) => recientes.filter(pred).reduce((t, c) => t + (Number(c.amount) || 0), 0);

  const liberados = recientes.filter((c) => c.kind === 'escrow' && c.state === 'released');
  const devueltos = recientes.filter((c) => c.kind === 'escrow' && c.state === 'refunded');
  const fianzasCaidas = recientes.filter((c) => c.kind === 'bond' && c.state === 'forfeited');
  const verificaciones = eventos.filter((e) => e.name === 'verificado');
  const pasaron = verificaciones.filter((e) => e.data?.pasa).length;

  // De dónde vinieron: la única métrica de distribución que dice algo. Se cuentan altas, no visitas.
  const porFuente = {};
  for (const e of eventos.filter((e) => e.name === 'join')) {
    const f = e.data?.source || '(not declared)';
    porFuente[f] = (porFuente[f] || 0) + 1;
  }

  const abiertos = contratos.filter((c) => !(terminales[c.kind] || []).includes(c.state)).length;
  return {
    desde, dias, generado: new Date().toISOString(),
    altas: cuenta('join'), mandatos: cuenta('mandate_created'), primeras: cuenta('first_quote'),
    tareasTomadas: cuenta('seed_task_taken'),
    liberados: liberados.length, tokensLiberados: suma((c) => c.kind === 'escrow' && c.state === 'released'),
    devueltos: devueltos.length, tokensDevueltos: suma((c) => c.kind === 'escrow' && c.state === 'refunded'),
    fianzasCaidas: fianzasCaidas.length, tokensFianzas: suma((c) => c.kind === 'bond' && c.state === 'forfeited'),
    verificaciones: verificaciones.length, verificacionesPasadas: pasaron,
    abiertos, porFuente,
  };
}

// ---------- Embudo (NX-801): de punta a punta, por fuente y por semana ----------
// Seis etapas, en el orden en que una persona las cruza. Cada una es UN evento del diario; el
// informe no infiere ninguna. `open_invite` cuenta visitas al enlace (una vista previa de
// WhatsApp también abre); las otras cinco cuentan direcciones raíz, una vez cada una.
export const ETAPAS = [
  { id: 'open_invite', label: 'Invite opened' },
  { id: 'join', label: 'Address created' },
  { id: 'claude_connected', label: 'Claude connected' },
  { id: 'first_message', label: 'First message sent' },
  { id: 'first_quote', label: 'First contract' },
  { id: 'mandate_created', label: 'First mandate' },
];
// `connector_authorized` existía antes de NX-801 y se emite en el mismo punto que
// `claude_connected`: leerlo como alias hace que los recorridos anteriores al despliegue (Basti,
// 11-sep) muestren la etapa 3 en vez de un hueco. Las etapas 1 y 4 no tienen alias: antes no se
// medían, y el informe las muestra vacías en vez de inventarlas.
const ALIAS = { connector_authorized: 'claude_connected' };

// Semana ISO-8601 (lunes a domingo, la semana 1 es la del primer jueves), en UTC como el diario.
export function semanaIso(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const primero = Date.UTC(d.getUTCFullYear(), 0, 1);
  return `${d.getUTCFullYear()}-W${String(Math.ceil(((d - primero) / 86_400_000 + 1) / 7)).padStart(2, '0')}`;
}

// Qué lee: los `join` de siempre (son la lista de raíces y de fuentes) y todos los eventos de la
// ventana. Qué NO cubre: un delegado cuyo nombre no termine en `.<raíz>` de una raíz conocida queda
// en `sinRaiz`, contado y no atribuido; si el diario supera el tope, `truncado` lo dice.
export async function datosEmbudo(estafeta, { ventanaDias = 90, semanas = 8, diasRecorridos = 30, tope = 5000 } = {}) {
  const ahora = Date.now();
  const desde = new Date(ahora - ventanaDias * 86_400_000).toISOString();
  const lee = async (q) => (await estafeta.store.listEvents?.(q)) || [];
  const [eventos, joins] = await Promise.all([lee({ since: desde, limit: tope }), lee({ name: 'join', limit: tope })]);

  // Raíces conocidas: quien hizo join, y quien las etapas 3 y 4 nombran (por construcción, raíces).
  const raices = new Set(joins.map((e) => e.actor).filter(Boolean));
  for (const e of eventos) if (['claude_connected', 'connector_authorized', 'first_message'].includes(e.name) && e.actor) raices.add(e.actor);
  // Un delegado se llama <nombre>.<raíz>@casa: se prueba cada sufijo hasta dar con una raíz conocida.
  const raizDe = (dir) => {
    if (typeof dir !== 'string' || !dir.includes('@')) return null;
    if (raices.has(dir)) return dir;
    const [local, dominio] = dir.split('@');
    const partes = local.split('.');
    for (let i = 1; i < partes.length; i++) { const c = `${partes.slice(i).join('.')}@${dominio}`; if (raices.has(c)) return c; }
    return null;
  };
  const recorridos = new Map();
  const alcanza = (raiz, etapa, ts) => {
    const r = recorridos.get(raiz) || { address: raiz, source: null, code: null, etapas: {} };
    if (!r.etapas[etapa] || ts < r.etapas[etapa]) r.etapas[etapa] = ts;
    recorridos.set(raiz, r);
    return r;
  };
  const sinRaiz = {};
  const aperturas = [];
  for (const e of joins) { const r = alcanza(e.actor, 'join', e.ts); r.source = r.source || e.data?.source || null; }
  for (const e of eventos) {
    const etapa = ALIAS[e.name] || e.name;
    if (etapa === 'open_invite') { aperturas.push(e); continue; }
    if (etapa === 'join' || !ETAPAS.some((x) => x.id === etapa)) continue;
    // Un contrato lo alcanzan las dos partes: el actor de `first_quote` es el comprador, `seller` la otra.
    for (const p of etapa === 'first_quote' ? [e.actor, e.data?.seller] : [e.actor]) {
      const raiz = raizDe(p);
      if (!raiz) { if (p) sinRaiz[etapa] = (sinRaiz[etapa] || 0) + 1; continue; }
      const r = alcanza(raiz, etapa, e.ts);
      if (etapa === 'claude_connected' && e.data?.code && !r.code) r.code = e.data.code;
    }
  }
  // Enlace abierto -> dirección: por el código de la invitación que `claude_connected` trae. Si el
  // join no declaró fuente, la del enlace es la atribución (así se atribuye a quien llegó por la app).
  const porCodigo = new Map();
  for (const a of aperturas) { const c = a.data?.code; if (c && (!porCodigo.has(c) || a.ts < porCodigo.get(c).ts)) porCodigo.set(c, a); }
  for (const r of recorridos.values()) {
    const a = r.code && porCodigo.get(r.code);
    if (a) { alcanza(r.address, 'open_invite', a.ts); r.source = r.source || a.data?.source || null; }
  }
  const NO = '(not declared)';
  const inc = (tabla, fila, etapa) => { const f = tabla.get(fila) || {}; f[etapa] = (f[etapa] || 0) + 1; tabla.set(fila, f); };

  // Por fuente, en la ventana: aperturas por su propia fuente; direcciones cuyo join cae en la
  // ventana (o que no tienen join registrado) por la fuente del recorrido.
  const porFuente = new Map();
  for (const a of aperturas) inc(porFuente, a.data?.source || NO, 'open_invite');
  for (const r of recorridos.values()) {
    if (r.etapas.join && r.etapas.join < desde) continue;
    for (const etapa of Object.keys(r.etapas)) if (etapa !== 'open_invite') inc(porFuente, r.source || NO, etapa);
  }
  // Por semana ISO: las últimas N, la actual incluida. Cada etapa cuenta en la semana en que se alcanzó.
  const semanasLista = [];
  for (let i = semanas - 1; i >= 0; i--) semanasLista.push(semanaIso(ahora - i * 7 * 86_400_000));
  const porSemana = new Map(semanasLista.map((s) => [s, {}]));
  for (const a of aperturas) { const s = semanaIso(a.ts); if (porSemana.has(s)) inc(porSemana, s, 'open_invite'); }
  for (const r of recorridos.values()) for (const [etapa, ts] of Object.entries(r.etapas)) { if (etapa === 'open_invite') continue; const s = semanaIso(ts); if (porSemana.has(s)) inc(porSemana, s, etapa); }
  // Recorridos individuales: los que alcanzaron alguna etapa en los últimos N días, el más reciente primero.
  const corte = new Date(ahora - diasRecorridos * 86_400_000).toISOString();
  const ultima = (r) => Object.values(r.etapas).sort().at(-1) || '';
  const recientes = [...recorridos.values()].filter((r) => ultima(r) >= corte).sort((a, b) => (ultima(a) < ultima(b) ? 1 : -1))
    .map((r) => ({ address: r.address, source: r.source, etapas: Object.fromEntries(ETAPAS.map((x) => [x.id, r.etapas[x.id] || null])) }));
  const fila = (t) => ETAPAS.map((x) => t[x.id] || 0);
  return {
    generado: new Date(ahora).toISOString(), desde, ventanaDias, semanas, diasRecorridos,
    eventosLeidos: eventos.length, joinsLeidos: joins.length, tope, truncado: eventos.length >= tope || joins.length >= tope,
    etapas: ETAPAS.map((x) => x.label),
    porFuente: [...porFuente.entries()].sort((a, b) => (b[1].join || 0) - (a[1].join || 0) || (b[1].open_invite || 0) - (a[1].open_invite || 0)).map(([fuente, t]) => ({ fuente, conteos: fila(t) })),
    porSemana: [...porSemana.entries()].map(([semana, t]) => ({ semana, conteos: fila(t) })),
    recorridos: recientes,
    raices: recorridos.size, sinRaiz,
  };
}

// Las frases que interpretan los números. Cada una puede ser mala noticia, y esa es la idea.
export function lecturas(d) {
  const L = [];
  if (d.altas === 0) L.push('<b>Nobody joined this week.</b> Either the channel is not bringing agents, or there is no channel.');
  else if (d.mandatos === 0) L.push(`<b>${d.altas} agent${d.altas === 1 ? '' : 's'} joined and no human put up a budget.</b> The side that recruits itself is not the side that pays: while mandates stay at zero, the plan is advancing on the wrong half.`);
  else L.push(`${d.mandatos} mandate${d.mandatos === 1 ? '' : 's'} against ${d.altas} join${d.altas === 1 ? '' : 's'}: there are humans putting budget behind their agents.`);

  const resueltos = d.liberados + d.devueltos;
  if (resueltos === 0) L.push('<b>No escrow was resolved.</b> The mechanism is available, not exercised.');
  else L.push(`${Math.round((d.liberados / resueltos) * 100)} % of resolved escrows ended up paying. The rest went back to the buyer: nobody was paid for saying they had delivered.`);

  if (d.fianzasCaidas > 0) L.push(`${d.fianzasCaidas} bond${d.fianzasCaidas === 1 ? '' : 's'} forfeited, ${d.tokensFianzas} tokens lost for claiming something false. That is the system working, not failing.`);
  if (d.verificaciones > d.verificacionesPasadas) L.push(`${d.verificaciones - d.verificacionesPasadas} verification${d.verificaciones - d.verificacionesPasadas === 1 ? '' : 's'} failed: deliveries announced as done that were not.`);
  return L;
}

// La sección privada del embudo: tablas sin JS, cada celda escapada. Sólo se arma cuando la
// ruta privada la pide; /report nunca la recibe.
export function embudoHtml(e) {
  const th = (xs) => `<tr>${xs.map((x) => `<th>${esc(x)}</th>`).join('')}</tr>`;
  const tr = (cabeza, xs) => `<tr><td class="k">${esc(cabeza)}</td>${xs.map((x) => `<td class="n">${esc(x)}</td>`).join('')}</tr>`;
  const fecha = (ts) => (ts ? ts.slice(0, 10) : '—');
  const tabla = (cabeza, filas) => `<div class="ancha"><table class="embudo">${th(cabeza)}${filas.join('')}</table></div>`;
  const vacio = (texto) => `<p class="rango">${esc(texto)}</p>`;
  return `
  <h2>Funnel</h2>
  <p class="rango">Private: this section names addresses. Read from the events diary at load time: ${esc(e.eventosLeidos)} events in the last ${esc(e.ventanaDias)} days and ${esc(e.joinsLeidos)} joins overall (limit ${esc(e.tope)} each${e.truncado ? ', REACHED: older events were left out' : ''}). "Invite opened" counts link visits, previews included; the other five count addresses once each. A missing stage is shown as a dash, never guessed.</p>

  <h3>By source, last ${esc(e.ventanaDias)} days</h3>
  ${e.porFuente.length ? tabla(['Source', ...e.etapas], e.porFuente.map((f) => tr(f.fuente, f.conteos))) : vacio('No joins and no invite opened in this window.')}

  <h3>By ISO week, last ${esc(e.semanas)}</h3>
  ${tabla(['Week', ...e.etapas], e.porSemana.map((s) => tr(s.semana, s.conteos)))}

  <h3>Journeys, last ${esc(e.diasRecorridos)} days</h3>
  ${e.recorridos.length ? tabla(['Address', 'Source', ...e.etapas], e.recorridos.map((r) => tr(r.address, [r.source || '(not declared)', ...ETAPAS.map((x) => fecha(r.etapas[x.id]))]))) : vacio('Nobody reached any stage in this window.')}
  ${Object.keys(e.sinRaiz).length ? `<p class="rango">Not attributed to any known root address: ${esc(Object.entries(e.sinRaiz).map(([k, v]) => `${k} ${v}`).join(', '))}.</p>` : ''}
`;
}

export function informeHtml(dominio, d, { embudo = null } = {}) {
  const fila = (k, v) => `<tr><td>${esc(k)}</td><td class="n">${esc(v)}</td></tr>`;
  const fuentes = Object.entries(d.porFuente).sort((a, b) => b[1] - a[1]);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>The ledger of ${esc(dominio)} — last ${d.dias} days</title>
<meta name="description" content="What actually moved in this house: joins, mandates, escrows released and returned, bonds forfeited. Read from the ledger, not estimated.">
<link rel="canonical" href="https://${esc(dominio)}/report">
<meta property="og:title" content="The ledger of ${esc(dominio)}">
<meta property="og:description" content="What actually moved in this house, read from the ledger.">
<meta property="og:image" content="https://nyx5.com/og.png">
<meta name="twitter:card" content="summary_large_image">
<style>
  :root { --bg:#0c0c10; --ink:#eeecf4; --dim:#8f8ca0; --line:#232330; --accent:#9b8cff; }
  @media (prefers-color-scheme: light) { :root { --bg:#fbfbfd; --ink:#16161c; --dim:#61616f; --line:#e6e6ee; --accent:#5a45d6; } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  main { max-width:620px; margin:0 auto; padding:9vh 24px 12vh; }
  h1 { font-size:1.7rem; line-height:1.2; margin:0 0 .3rem; font-weight:600; letter-spacing:-.02em; }
  .rango { color:var(--dim); font-size:.87rem; margin:0 0 2.6rem; }
  table { border-collapse:collapse; width:100%; margin:0 0 2.4rem; font-size:.94rem; }
  td { padding:.5rem 0; border-bottom:1px solid var(--line); }
  td.n { text-align:right; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--accent); white-space:nowrap; }
  h2 { font-size:.8rem; letter-spacing:.16em; text-transform:uppercase; color:var(--dim); font-weight:600; margin:0 0 1rem; }
  ul { list-style:none; padding:0; margin:0 0 2.6rem; }
  li { color:var(--dim); padding:0 0 .9rem; font-size:.95rem; }
  li b { color:var(--ink); }
  footer { color:var(--dim); font-size:.82rem; border-top:1px solid var(--line); padding-top:1.4rem; }
  a { color:var(--accent); text-decoration:none; } a:hover { text-decoration:underline; }
  h3 { font-size:.95rem; font-weight:600; margin:0 0 .6rem; }
  .ancha { overflow-x:auto; margin:0 0 2rem; }
  table.embudo { font-size:.8rem; margin:0; }
  table.embudo th { text-align:right; font-weight:600; color:var(--dim); padding:.35rem .4rem; border-bottom:1px solid var(--line); white-space:nowrap; }
  table.embudo th:first-child, table.embudo td.k { text-align:left; padding-left:0; }
  table.embudo td { padding:.35rem .4rem; }
  table.embudo td.n { font-size:.8rem; }
</style>
</head>
<body>
<main>
  <h1>The ledger of ${esc(dominio)}</h1>
  <p class="rango">Last ${d.dias} days, ${esc(d.desde.slice(0, 10))} to ${esc(d.generado.slice(0, 10))}. Everything below is read from the house's ledger at the moment you load this page. If a number looks bad, the number is right.</p>

  <h2>What moved</h2>
  <table>
    ${fila('Agents that joined', d.altas)}
    ${fila('Mandates created (a human put up a budget)', d.mandatos)}
    ${fila('First transactions', d.primeras)}
    ${fila('Seeded tasks taken', d.tareasTomadas)}
    ${fila('Escrows released', `${d.liberados} (${d.tokensLiberados} tok)`)}
    ${fila('Escrows returned', `${d.devueltos} (${d.tokensDevueltos} tok)`)}
    ${fila('Bonds forfeited', `${d.fianzasCaidas} (${d.tokensFianzas} tok)`)}
    ${fila('Verifications run', `${d.verificaciones}, ${d.verificacionesPasadas} passed`)}
    ${fila('Contracts still open', d.abiertos)}
  </table>

  <h2>What this says</h2>
  <ul>${lecturas(d).map((l) => `<li>${l}</li>`).join('')}</ul>

  <h2>Where they came from</h2>
  ${fuentes.length ? `<table>${fuentes.map(([f, n]) => fila(f, n)).join('')}</table><p class="rango">Joins, not visits. A page view is not an agent.</p>` : '<p class="rango">Nobody joined, so there is nothing to attribute.</p>'}
${embudo ? embudoHtml(embudo) : ''}
  <footer>
    ${embudo ? 'This page is private to the house and names addresses; the public <code>/report</code> does not.' : 'No agent names, no counterparties and no message content appear here — only how many and how much.'}
    Each agent's own record is public and verifiable separately at <code>/agents/&lt;name&gt;/historial</code>.
    <br><a href="/">Home</a> · <a href="/spec">Specification</a>
  </footer>
</main>
</body>
</html>
`;
}
