import { call, isDemo } from './client.js';
import * as C from './core.js';

const $ = (id) => document.getElementById(id);
const esc = C.esc;
const KEY_STORE = 'orders-admin-key';
let adminKey = '';
let orders = [];
let info = {};

const storeGet = () => { try { return localStorage.getItem(KEY_STORE) || ''; } catch { return ''; } };
const storeSet = (v) => { try { v ? localStorage.setItem(KEY_STORE, v) : localStorage.removeItem(KEY_STORE); } catch { /* ignore */ } };
const api = (method, path, body) => call(method, path, body, adminKey).catch((e) => {
  if (e.status === 401) { storeSet(''); showLogin('Please sign in again.'); }
  throw e;
});

// ───────── sign in ─────────
function showLogin(msg) {
  $('app').classList.add('hidden');
  $('login').classList.remove('hidden');
  $('loginErr').textContent = msg || '';
  $('loginErr').classList.toggle('hidden', !msg);
  if (isDemo) $('pw').value = 'demo';
}
$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  adminKey = $('pw').value;
  try { info = await call('GET', '/admin/info', null, adminKey); storeSet(adminKey); enter(); }
  catch (err) { showLogin(err.status === 401 ? 'Wrong password.' : err.message); }
});
$('logout').addEventListener('click', () => { storeSet(''); adminKey = ''; showLogin(); });

async function boot() {
  if (isDemo) {
    $('demoBanner').classList.remove('hidden');
    $('outboxTab').classList.remove('hidden');
    $('resetDemo').addEventListener('click', async (e) => { e.preventDefault(); (await import('./demo.js')).demoReset(); location.reload(); });
  }
  adminKey = storeGet() || (isDemo ? 'demo' : '');
  if (!adminKey) return showLogin();
  try { info = await call('GET', '/admin/info', null, adminKey); enter(); }
  catch (e) { showLogin(e.status === 401 ? '' : e.message); }
}

async function enter() {
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  try { const cfg = await call('GET', '/config'); $('biz').textContent = cfg.businessName + ' · Orders'; document.title = cfg.businessName + ' – Dashboard'; } catch { /* ignore */ }
  route();
}

// ───────── tabs ─────────
const TABS = { orders: renderOrders, calendar: renderCalendar, inventory: renderInventory, recipes: renderRecipes, menu: renderMenu, settings: renderSettings, outbox: renderOutbox };
window.addEventListener('hashchange', route);
async function route() {
  const h = location.hash.slice(1) || 'orders';
  const m = h.match(/^order-(\d+)$/);
  const tab = m ? 'orders' : (TABS[h] ? h : 'orders');
  document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
  if (!m) closeModal();
  if (!m || !$('main').dataset.tab || $('main').dataset.tab !== 'orders') {
    $('main').dataset.tab = tab;
    $('main').innerHTML = '<p class="muted">Loading…</p>';
    try { await TABS[tab](); } catch (e) { $('main').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
  }
  if (m) openOrder(+m[1]);
}

async function loadOrders() {
  orders = await api('GET', '/admin/orders');
  const n = orders.filter((o) => o.status === 'New').length;
  $('newCount').textContent = n;
  $('newCount').classList.toggle('hidden', !n);
  return orders;
}
const today = () => C.todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone);

// ───────── Orders ─────────
let filter = 'upcoming';
let search = '';
async function renderOrders() {
  await loadOrders();
  const chips = [['upcoming', 'Upcoming'], ['New', 'New'], ['Confirmed', 'Confirmed'], ['Done', 'Done'], ['Cancelled', 'Cancelled'], ['all', 'All']];
  $('main').innerHTML = `<div class="toolbar">${chips.map(([k, l]) => `<button class="chip ${filter === k ? 'on' : ''}" data-f="${k}">${l}</button>`).join('')}
    <input type="search" id="q" placeholder="Search name, item…" value="${esc(search)}"></div><div class="orders" id="olist"></div>`;
  $('main').querySelectorAll('[data-f]').forEach((b) => b.addEventListener('click', () => { filter = b.dataset.f; renderOrders(); }));
  $('q').addEventListener('input', (e) => { search = e.target.value; drawOrderList(); });
  drawOrderList();
}
function drawOrderList() {
  const t = today();
  const q = C.norm(search);
  let list = orders.filter((o) => filter === 'all' ? true : filter === 'upcoming' ? C.OPEN_STATUSES.includes(o.status) && o.event_date >= t : o.status === filter);
  if (q) list = list.filter((o) => C.norm([o.name, o.email, o.phone, o.event_type, C.itemsSummary(o.items), o.notes, o.orderNo].join(' ')).includes(q));
  if (filter === 'Done' || filter === 'all') list = list.slice().reverse();
  $('olist').innerHTML = list.length ? list.map((o) => `
    <button class="orow" data-id="${o.id}">
      <div class="odate"><b>${esc(C.displayDate(o.event_date).replace(/, \d{4}$/, ''))}</b><span>${esc(o.time ? C.displayTime(o.time) : 'Any time')} · ${esc(o.fulfillment)}</span></div>
      <div><div class="oname">${esc(o.name)} <span class="muted" style="font-weight:400">#${o.orderNo}</span></div>
        <div class="oitems">${esc(C.shortItems(o.items))}${o.event_type ? ' · ' + esc(o.event_type) : ''}</div>
        ${o.allergies ? `<div class="flag">⚠ Allergies: ${esc(o.allergies)}</div>` : ''}</div>
      <div class="oright"><span class="pill ${esc(o.status)}">${esc(o.status)}</span><div>${C.money(o.total)}</div><div class="muted">${esc(o.payment_method)}</div></div>
    </button>`).join('') : `<div class="card muted">No orders here yet.${isDemo ? ' <a href="index.html">Try the customer form →</a>' : ''}</div>`;
  $('olist').querySelectorAll('.orow').forEach((b) => b.addEventListener('click', () => { location.hash = 'order-' + b.dataset.id; }));
}

function closeModal() { $('modal').classList.add('hidden'); }
$('modal').addEventListener('click', (e) => { if (e.target === $('modal')) history.back(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('modal').classList.contains('hidden')) history.back(); });

async function openOrder(id) {
  $('modal').classList.remove('hidden');
  $('panel').innerHTML = '<p class="muted">Loading…</p>';
  let o, recipes;
  try { [o, recipes] = await Promise.all([api('GET', '/admin/orders/' + id), api('GET', '/admin/tables/recipes')]); }
  catch (e) { $('panel').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; return; }
  const needs = C.computeNeeds(o.items, recipes);
  const kv = (k, v) => v ? `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>` : '';
  const invLink = o.square_invoice_url
    ? `<a class="btn btn-ghost btn-small" target="_blank" rel="noopener" href="${esc(isDemo ? '#' : o.square_invoice_url)}" id="sqLink">💳 Open draft invoice in Square</a>`
    : `<button class="btn btn-ghost btn-small" id="mkInv">💳 Create Square draft invoice</button>`;
  $('panel').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
      <div><div class="muted">Order #${o.orderNo} · received ${esc(new Date(o.created_at).toLocaleString())}</div><h2>${esc(o.name)}</h2></div>
      <button class="x noprint" style="font-size:22px" onclick="history.back()" aria-label="Close">✕</button></div>
    <div class="toolbar noprint" style="margin-top:12px">
      <label style="margin:0">Status</label>
      <select id="status" style="width:auto">${C.STATUSES.map((s) => `<option ${s === o.status ? 'selected' : ''}>${s}</option>`).join('')}</select>
      <span id="statusMsg" class="muted"></span></div>
    <div class="actions">${invLink}
      <a class="btn btn-ghost btn-small" href="mailto:${esc(o.email)}?subject=${encodeURIComponent('Your order #' + o.orderNo)}">✉️ Email</a>
      <a class="btn btn-ghost btn-small" href="sms:${esc(o.phone)}">💬 Text</a>
      <button class="btn btn-ghost btn-small" id="printSigned">🖨️ Signed copy</button></div>
    <dl class="kv">
      ${kv('Event', [o.event_type, C.displayDate(o.event_date)].filter(Boolean).join(' · '))}
      ${kv(o.fulfillment || 'Pickup', (o.time ? C.displayTime(o.time) : 'Time not given') + (o.address ? ' · ' + o.address : ''))}
      ${kv('Phone', o.phone)}${kv('Email', o.email)}${kv('Payment', o.payment_method)}
      ${kv('Price', C.money(o.subtotal) + (o.fee ? ` + ${C.money(o.fee)} card fee = ${C.money(o.total)}` : ''))}
    </dl>
    ${o.allergies ? `<div class="msg err"><b>Allergies:</b> ${esc(o.allergies)}</div>` : ''}
    <h3>Items</h3><ol class="items">${o.items.map((it) => `<li><b>${esc(C.itemLabel(it))}</b>${it.notes ? `<br><span class="muted">${esc(it.notes)}</span>` : ''}</li>`).join('')}</ol>
    ${o.notes ? `<h3>Notes</h3><p style="white-space:pre-wrap">${esc(o.notes)}</p>` : ''}
    <details><summary><b>Ingredients this order uses</b></summary>
      <table class="t" style="margin-top:8px">${Object.entries(needs.needs).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${v}</td></tr>`).join('') || '<tr><td class="muted">No recipes match this order yet.</td></tr>'}</table>
      ${needs.missing.length ? `<p class="msg warn">No recipe on file for: ${esc(needs.missing.join(', '))}</p>` : ''}</details>
    <h3>Terms &amp; signature</h3>
    <p class="muted" style="margin:0 0 6px">Agreed ${esc(new Date(o.terms_accepted_at).toLocaleString())} · Initials <b>${esc(o.initials)}</b></p>
    <div class="terms-box">${esc(o.terms_text)}</div>
    ${o.signature ? `<p><img class="sigimg" alt="Customer signature" src="${esc(o.signature)}"></p>` : '<p class="muted">(Example order – no signature.)</p>'}
  `;
  $('status').addEventListener('change', async (e) => {
    const s = e.target.value;
    $('statusMsg').textContent = 'Saving…';
    try {
      const r = await api('POST', `/admin/orders/${id}/status`, { status: s });
      $('statusMsg').textContent = r.deducted ? '✓ Saved – ingredients taken out of inventory' : '✓ Saved';
      await loadOrders();
    } catch (err) { $('statusMsg').textContent = '⚠ ' + err.message; }
  });
  if ($('mkInv')) $('mkInv').addEventListener('click', async () => {
    $('mkInv').textContent = 'Creating…';
    try { await api('POST', `/admin/orders/${id}/invoice`); openOrder(id); }
    catch (err) { $('mkInv').textContent = '⚠ ' + err.message; }
  });
  if (isDemo && $('sqLink')) $('sqLink').addEventListener('click', (e) => {
    e.preventDefault();
    $('statusMsg').textContent = 'Demo: on the real site this opens the draft invoice in Square, already filled in, ready for you to check and press Send.';
  });
  $('printSigned').addEventListener('click', () => printSigned(o));
}

function printSigned(o) {
  const w = window.open('', '_blank');
  if (!w) {
    $('panel').innerHTML = `<div class="actions noprint"><button class="btn btn-ghost btn-small" id="backToOrder">← Back to order</button></div>` +
      C.orderHtml(o) + C.signedBlockHtml(o);
    $('backToOrder').addEventListener('click', () => openOrder(o.id));
    return;
  }
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Signed order #${o.orderNo}</title></head>
    <body style="font-family:Arial;max-width:720px;margin:24px auto;padding:0 16px">${C.orderHtml(o)}${C.signedBlockHtml(o)}
    <p style="color:#888;font-size:11px">Submitted online ${esc(o.created_at)} · ${esc(o.client_info || '')}</p></body></html>`);
  w.document.close();
  setTimeout(() => w.print(), 300);
}

// ───────── Calendar ─────────
async function renderCalendar() {
  await loadOrders();
  const t = today();
  const upcoming = orders.filter((o) => o.status !== 'Cancelled' && o.event_date >= t);
  const groups = {};
  for (const o of upcoming) (groups[o.event_date] ||= []).push(o);
  const cal = isDemo ? '' : info.calendarUrl;
  $('main').innerHTML = `
    <div class="card">
      <h2>📅 See orders in your phone's calendar</h2>
      ${cal ? `<p>Add this link once, and every order shows up in your calendar by itself (⏳ = not confirmed yet).</p>
      <div class="copy"><input readonly id="calUrl" value="${esc(cal)}"><button class="btn btn-main btn-small" id="copyCal">Copy</button></div>
      <p class="hint"><b>Google Calendar:</b> on a computer, Other calendars <b>+</b> → From URL → paste.<br>
      <b>iPhone:</b> Settings → Calendar → Accounts → Add Account → Other → Add Subscribed Calendar → paste.<br>
      Calendar apps re-check the link every few hours. Each new-order email also has an "add to calendar" attachment for right away.</p>`
      : isDemo ? `<p>On the real site you get a private link here. Add it once to Google Calendar or your iPhone and every order appears there by itself
        (⏳ = not confirmed yet, ✅ = done). Here is how the entries will look:</p><ul id="calPreview" class="hint" style="font-size:14px"></ul>`
      : '<p class="muted">The calendar link appears here once the site is online.</p>'}
    </div>
    <div class="card"><h2>Coming up</h2>${Object.keys(groups).length ? Object.entries(groups).map(([d, list]) => `
      <div class="daygroup"><h3>${esc(C.displayDate(d))}</h3>${list.map((o) => `
        <div style="padding:6px 0;border-bottom:1px solid #f0eaf0"><a href="#order-${o.id}"><b>${esc(o.time ? C.displayTime(o.time) : 'Any time')}</b> · ${esc(o.fulfillment)} · ${esc(o.name)}</a>
        <span class="pill ${esc(o.status)}">${esc(o.status)}</span><div class="muted" style="font-size:14px">${esc(C.shortItems(o.items))}</div></div>`).join('')}</div>`).join('')
      : '<p class="muted">Nothing coming up.</p>'}</div>`;
  if ($('calPreview')) {
    const ics = C.buildIcs(upcoming.slice(0, 5), {});
    $('calPreview').innerHTML = [...ics.replace(/\r\n /g, '').matchAll(/^SUMMARY:(.*)$/gm)]
      .map((m) => `<li>${esc(m[1].replace(/\\([,;\\])/g, '$1'))}</li>`).join('') || '<li>No upcoming orders.</li>';
  }
  if ($('copyCal')) $('copyCal').addEventListener('click', () => { $('calUrl').select(); navigator.clipboard?.writeText($('calUrl').value); $('copyCal').textContent = 'Copied ✓'; });
}

// ───────── Inventory ─────────
async function renderInventory() {
  const [st, inv] = await Promise.all([api('GET', '/admin/inventory'), api('GET', '/admin/tables/inventory')]);
  const byName = Object.fromEntries(st.rows.map((r) => [C.norm(r.ingredient), r]));
  const warn = [
    st.missingRecipes.length ? `No recipe on file for: <b>${esc(st.missingRecipes.join(', '))}</b> – those weren't counted. Add them on the Recipes tab.` : '',
    st.unknownIngredients.length ? `Recipes use ingredients that aren't listed below: <b>${esc(st.unknownIngredients.join(', '))}</b>` : ''
  ].filter(Boolean);
  $('main').innerHTML = `
    <div class="two">
      <div class="card"><h2>🛒 Shopping list</h2>
        ${st.shopping.length ? `<table class="t">${st.shopping.map((r) => `<tr><td>☐</td><td class="num"><b>${r.buy}</b> ${esc(r.unit)}</td><td>${esc(r.ingredient)}</td></tr>`).join('')}</table>`
          : '<p>Nothing to buy – you have enough for every open order. 🎉</p>'}
        <div class="actions"><button class="btn btn-ghost btn-small" id="mailList">✉️ Email it to me now</button><button class="btn btn-ghost btn-small" onclick="window.print()">🖨️ Print</button></div>
        <p class="hint">Buys enough to cover every New + Confirmed order and get back to your "keep at least" amount. Emailed to you every Sunday morning.</p>
        <div id="mailMsg"></div></div>
      <div class="card"><h2>How it works</h2><p class="hint" style="font-size:14px">
        <b>On hand</b> = what's on your shelf. Update it after you shop.<br>
        <b>Needed</b> = what all open orders will use (from your recipes).<br>
        <b>Left</b> = on hand − needed. <span style="background:#fdecea">Red</span> = not enough. <span style="background:#fff4dc">Orange</span> = below your "keep at least".<br>
        When you mark an order <b>Done</b>, its ingredients come off "on hand" automatically.</p></div>
    </div>
    ${warn.map((w) => `<div class="msg warn">${w}</div>`).join('')}
    <div class="card"><div class="toolbar"><h2 style="margin:0;flex:1">📦 Inventory</h2>
      <button class="btn btn-ghost btn-small" id="addIng">+ Add ingredient</button><button class="btn btn-main btn-small" id="saveInv">Save changes</button></div>
      <div id="invMsg"></div>
      <div class="scroll"><table class="t" id="invTable"><thead><tr><th>Ingredient</th><th>Unit</th><th>On hand</th><th>Keep at least</th><th class="num">Needed</th><th class="num">Left</th><th></th></tr></thead><tbody></tbody></table></div></div>`;
  const tbody = $('invTable').querySelector('tbody');
  const addRow = (r = {}) => {
    const s = byName[C.norm(r.ingredient)] || {};
    const tr = document.createElement('tr');
    tr.className = s.state && s.state !== 'ok' ? s.state : '';
    tr.innerHTML = `<td><input data-k="ingredient" value="${esc(r.ingredient ?? '')}"></td><td><input data-k="unit" value="${esc(r.unit ?? '')}" style="width:80px"></td>
      <td><input data-k="on_hand" type="number" step="any" value="${esc(r.on_hand ?? '')}" style="width:90px"></td>
      <td><input data-k="keep_at_least" type="number" step="any" value="${esc(r.keep_at_least ?? '')}" style="width:90px"></td>
      <td class="num">${s.reserved ?? ''}</td><td class="num"><b>${s.left ?? ''}</b></td><td><button class="x" title="Remove">✕</button></td>`;
    tr.querySelector('.x').addEventListener('click', () => tr.remove());
    tbody.appendChild(tr);
    return tr;
  };
  inv.forEach((r) => addRow(r));
  $('addIng').addEventListener('click', () => addRow().querySelector('input').focus());
  $('saveInv').addEventListener('click', async () => {
    const rows = [...tbody.querySelectorAll('tr')].map((tr) => Object.fromEntries([...tr.querySelectorAll('input')].map((i) => [i.dataset.k, i.value])));
    try { await api('PUT', '/admin/tables/inventory', rows); renderInventory(); }
    catch (e) { $('invMsg').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
  });
  $('mailList').addEventListener('click', async () => {
    try {
      const r = await api('POST', '/admin/weekly-email');
      $('mailMsg').innerHTML = r.sent ? '<div class="msg ok">Sent ✓ – check your inbox.</div>' : `<div class="msg warn">Not sent: ${esc(r.reason)}</div>`;
    } catch (e) { $('mailMsg').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
  });
}

// ───────── Generic table editor (recipes, menu) ─────────
function tableEditor(el, { title, help, table, cols, filterable }) {
  el.innerHTML = `<div class="card"><div class="toolbar"><h2 style="margin:0;flex:1">${title}</h2>
      ${filterable ? '<input type="search" class="flt" placeholder="Filter…" style="max-width:200px;padding:7px 12px">' : ''}
      <button class="btn btn-ghost btn-small add">+ Add row</button><button class="btn btn-main btn-small save">Save changes</button></div>
    ${help ? `<p class="hint" style="margin-top:0">${help}</p>` : ''}<div class="m"></div>
    <div class="scroll"><table class="t"><thead><tr>${cols.map((c) => `<th>${esc(c.label)}</th>`).join('')}<th></th></tr></thead><tbody></tbody></table></div></div>`;
  const tbody = el.querySelector('tbody');
  const addRow = (r = {}, top = false) => {
    const tr = document.createElement('tr');
    tr.innerHTML = cols.map((c) => `<td><input data-k="${c.key}" ${c.num ? 'type="number" step="any"' : ''} value="${esc(r[c.key] ?? '')}" ${c.list ? `list="${c.list}"` : ''} style="${c.w ? 'width:' + c.w : ''}"></td>`).join('') +
      '<td><button class="x" title="Remove">✕</button></td>';
    tr.querySelector('.x').addEventListener('click', () => tr.remove());
    top ? tbody.prepend(tr) : tbody.appendChild(tr);
    return tr;
  };
  const load = async () => { tbody.innerHTML = ''; (await api('GET', '/admin/tables/' + table)).forEach((r) => addRow(r)); };
  el.querySelector('.add').addEventListener('click', () => {
    const f = el.querySelector('.flt');
    if (f) { f.value = ''; tbody.querySelectorAll('tr').forEach((tr) => { tr.style.display = ''; }); }
    addRow({}, true).querySelector('input').focus();
  });
  el.querySelector('.save').addEventListener('click', async () => {
    const rows = [...tbody.querySelectorAll('tr')].map((tr) => Object.fromEntries([...tr.querySelectorAll('input')].map((i) => [i.dataset.k, i.value])));
    try { const r = await api('PUT', '/admin/tables/' + table, rows); el.querySelector('.m').innerHTML = `<div class="msg ok">Saved ✓ (${r.count} rows)</div>`; await load(); }
    catch (e) { el.querySelector('.m').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
  });
  const flt = el.querySelector('.flt');
  if (flt) flt.addEventListener('input', () => {
    const q = C.norm(flt.value);
    tbody.querySelectorAll('tr').forEach((tr) => { tr.style.display = !q || C.norm([...tr.querySelectorAll('input')].map((i) => i.value).join(' ')).includes(q) ? '' : 'none'; });
  });
  return load();
}

async function datalists() {
  const [inv, products, choices] = await Promise.all([api('GET', '/admin/tables/inventory'), api('GET', '/admin/tables/products'), api('GET', '/admin/tables/choices')]);
  const opts = (arr) => [...new Set(arr.filter(Boolean))].map((v) => `<option value="${esc(v)}">`).join('');
  return `<datalist id="dl-ing">${opts(inv.map((r) => r.ingredient))}</datalist>
    <datalist id="dl-recipe">${opts(products.map((p) => p.product).concat(choices.map((c) => c.choice)))}</datalist>
    <datalist id="dl-size">${opts(products.map((p) => p.size))}</datalist>
    <datalist id="dl-list">${opts(choices.map((c) => c.list))}</datalist>`;
}

async function renderRecipes() {
  $('main').innerHTML = (await datalists()) + '<div id="rec"></div>';
  await tableEditor($('rec'), {
    title: '🧁 Recipes', table: 'recipes', filterable: true,
    help: 'One row per ingredient. <b>Recipe</b> is a product (e.g. "Cake" – boards, boxes, outside icing) or a flavor/filling/coating a customer can pick (e.g. "Chocolate"). ' +
      '<b>Size</b> must match the Menu exactly (e.g. <i>8" round</i>, <i>1 dozen</i>); leave blank to use for every size. Amounts are for <b>one</b> item of that size – the system multiplies by quantity.',
    cols: [{ key: 'recipe', label: 'Recipe', list: 'dl-recipe' }, { key: 'size', label: 'Size', list: 'dl-size', w: '120px' },
      { key: 'ingredient', label: 'Ingredient', list: 'dl-ing' }, { key: 'amount', label: 'Amount', num: true, w: '90px' }, { key: 'notes', label: 'Notes' }]
  });
}

async function renderMenu() {
  $('main').innerHTML = (await datalists()) + '<div id="prod"></div><div id="cho"></div>';
  await tableEditor($('prod'), {
    title: '🎂 Products & sizes', table: 'products',
    help: 'What customers can pick on the form. <b>Starting price</b> goes on the draft invoice (you can change it in Square before sending). ' +
      '<b>Choice 1 / Choice 2</b> name a list from below (e.g. "Cake Flavor", "Filling") – leave blank for none.',
    cols: [{ key: 'product', label: 'Product' }, { key: 'size', label: 'Size / option', w: '130px' }, { key: 'price', label: 'Starting price', num: true, w: '100px' },
      { key: 'choice1', label: 'Choice 1 list', list: 'dl-list' }, { key: 'choice2', label: 'Choice 2 list', list: 'dl-list' }]
  });
  await tableEditor($('cho'), {
    title: '🍫 Flavors, fillings & other choices', table: 'choices', filterable: true,
    help: 'Each row is one option in a dropdown. The <b>List</b> name connects it to the products above.',
    cols: [{ key: 'list', label: 'List', list: 'dl-list' }, { key: 'choice', label: 'Choice' }]
  });
}

// ───────── Settings ─────────
async function renderSettings() {
  const rows = await api('GET', '/admin/settings');
  $('main').innerHTML = `<div class="card"><h2>⚙️ Settings</h2><div id="setMsg"></div><div class="grid">${rows.map((r) => `
      <div class="${r.key === 'terms' ? 'full' : ''}"><label for="s-${r.key}">${esc(r.label)}</label>
      ${r.key === 'terms' ? `<textarea id="s-${r.key}" style="min-height:260px">${esc(r.value)}</textarea>` : `<input id="s-${r.key}" value="${esc(r.value)}">`}
      <div class="hint">${esc(r.help)}</div></div>`).join('')}</div>
      <div class="actions"><button class="btn btn-main" id="saveSet">Save settings</button></div></div>
    <div class="card"><h2>Connections</h2>
      <p>Email: ${info.emailConfigured ? '✅ on' : '⚪ off – see setup guide'}<br>Square: ${info.squareConfigured ? '✅ connected' : '⚪ not connected – see setup guide'}<br>
      <span class="muted">Running on: ${esc(info.backend || '')}</span></p>
      <button class="btn btn-ghost btn-small" id="sqTest">Test Square / show my location ID</button><div id="sqMsg" style="margin-top:8px"></div></div>`;
  $('saveSet').addEventListener('click', async () => {
    const body = Object.fromEntries(rows.map((r) => [r.key, $('s-' + r.key).value]));
    try { await api('PUT', '/admin/settings', body); $('setMsg').innerHTML = '<div class="msg ok">Saved ✓</div>'; }
    catch (e) { $('setMsg').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
    window.scrollTo(0, 0);
  });
  $('sqTest').addEventListener('click', async () => {
    try { const locs = await api('GET', '/admin/square-test'); $('sqMsg').innerHTML = '<div class="msg ok">Connected ✓<br>' + locs.map((l) => `${esc(l.name)} → <b>${esc(l.id)}</b>`).join('<br>') + '</div>'; }
    catch (e) { $('sqMsg').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
  });
}

// ───────── Demo: emails that would have been sent ─────────
async function renderOutbox() {
  const { demoOutbox } = await import('./demo.js');
  const mails = demoOutbox();
  $('main').innerHTML = `<p class="muted">In the real system these go to your inbox (and the customer's). Newest first.</p>` +
    (mails.length ? mails.map((m, i) => `<details class="mail" ${i === 0 ? 'open' : ''}><summary><b>${esc(m.subject)}</b><br><span class="muted">To ${esc(m.to)} · ${esc(new Date(m.at).toLocaleString())}${m.attachments.length ? ' · 📎 ' + esc(m.attachments.join(', ')) : ''}</span></summary>
      <iframe sandbox="" data-i="${i}"></iframe></details>`).join('') : '<div class="card muted">No emails yet – submit the customer form to see them.</div>');
  $('main').querySelectorAll('iframe').forEach((f) => { f.srcdoc = `<body style="font-family:Arial;padding:12px">${mails[+f.dataset.i].html}</body>`; });
}

boot();
