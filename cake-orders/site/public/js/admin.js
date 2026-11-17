import { call, isDemo } from './client.js';
import * as C from './core.js';
import { installReportButton } from './report.js';

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
  if (!document.getElementById('reportBtn')) installReportButton({ always: true });
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  try { const cfg = await call('GET', '/config'); $('biz').textContent = cfg.businessName + ' · Orders'; document.title = cfg.businessName + ' – Dashboard'; } catch { /* ignore */ }
  route();
}

// ───────── tabs ─────────
const TABS = { orders: renderOrders, calendar: renderCalendar, inventory: renderInventory, recipes: renderRecipes, menu: renderMenu, settings: renderSettings, feedback: renderFeedback, outbox: renderOutbox };
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
  const nr = orders.filter((o) => o.status === 'New' && o.needs_review).length;
  $('newCount').title = nr ? nr + ' need review' : '';
  $('newCount').textContent = n;
  $('newCount').classList.toggle('hidden', !n);
  return orders;
}
const today = () => C.todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone);

// ───────── Orders ─────────
const IN_PROGRESS = ['Confirmed', 'Baked', 'Decorated'];
let filter = 'upcoming';
let search = '';
const customerLink = (token) => isDemo ? new URL('index.html#o-' + token, location.href).href : new URL('index.html?o=' + token, location.href).href;
const payPill = (o) => o.status === 'Draft' ? '' : `<span class="pill pay-${esc((o.payment_status || 'Unpaid').replace(/\s/g, ''))}">${esc(o.payment_status || 'Unpaid')}</span>`;

async function renderOrders() {
  await loadOrders();
  const count = (f) => orders.filter(f).length;
  const chips = [['upcoming', 'Upcoming'], ['review', `Needs review (${count((o) => o.needs_review && o.status === 'New')})`], ['Draft', `Links sent (${count((o) => o.status === 'Draft')})`],
    ['New', 'New'], ['progress', 'In progress'], ['unpaid', 'Unpaid'], ['Done', 'Done'], ['Cancelled', 'Cancelled'], ['all', 'All']];
  $('main').innerHTML = `<div class="toolbar"><button class="btn btn-main" id="prepBtn">+ Prepare order link</button>
    <input type="search" id="q" placeholder="Search name, item…" value="${esc(search)}"></div>
    <div class="toolbar">${chips.map(([k, l]) => `<button class="chip ${filter === k ? 'on' : ''}" data-f="${k}">${l}</button>`).join('')}</div>
    <div class="orders" id="olist"></div>`;
  $('main').querySelectorAll('[data-f]').forEach((b) => b.addEventListener('click', () => { filter = b.dataset.f; renderOrders(); }));
  $('q').addEventListener('input', (e) => { search = e.target.value; drawOrderList(); });
  $('prepBtn').addEventListener('click', () => openPrepare());
  drawOrderList();
}
function drawOrderList() {
  const t = today();
  const q = C.norm(search);
  const f = {
    upcoming: (o) => C.OPEN_STATUSES.includes(o.status) && o.event_date >= t,
    review: (o) => o.status === 'New' && o.needs_review,
    progress: (o) => IN_PROGRESS.includes(o.status),
    unpaid: (o) => !['Draft', 'Cancelled'].includes(o.status) && (o.payment_status || 'Unpaid') !== 'Paid',
    all: () => true
  }[filter] || ((o) => o.status === filter);
  let list = orders.filter(f);
  if (q) list = list.filter((o) => C.norm([o.name, o.email, o.phone, o.event_type, C.itemsSummary(o.items), o.notes, o.orderNo].join(' ')).includes(q));
  if (filter === 'Done' || filter === 'all') list = list.slice().reverse();
  $('olist').innerHTML = list.length ? list.map((o) => `
    <button class="orow" data-id="${o.id}">
      <div class="odate"><b>${esc(o.event_date ? C.displayDate(o.event_date).replace(/, \d{4}$/, '') : 'No date yet')}</b><span>${esc(o.time ? C.displayTime(o.time) : 'Any time')}${o.fulfillment ? ' · ' + esc(o.fulfillment) : ''}</span></div>
      <div><div class="oname">${esc(o.name || '(no name yet)')} <span class="muted" style="font-weight:400">#${o.orderNo}</span></div>
        <div class="oitems">${esc(C.shortItems(o.items))}${o.event_type ? ' · ' + esc(o.event_type) : ''}</div>
        ${o.status === 'New' && o.needs_review ? '<div class="flag warnflag">✋ Customer made changes – review</div>' : ''}
        ${o.allergies ? `<div class="flag">⚠ Allergies: ${esc(o.allergies)}</div>` : ''}</div>
      <div class="oright"><span class="pill ${esc(o.status)}">${o.status === 'Draft' ? 'Link sent' : esc(o.status)}</span> ${payPill(o)}<div>${C.money(o.total)}</div><div class="muted">${esc(o.payment_method || '')}</div></div>
    </button>`).join('') : `<div class="card muted">Nothing here.${isDemo ? ' <a href="index.html">Try the customer form →</a>' : ''}</div>`;
  $('olist').querySelectorAll('.orow').forEach((b) => b.addEventListener('click', () => { location.hash = 'order-' + b.dataset.id; }));
}

function closeModal() { $('modal').classList.add('hidden'); }
$('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closePanel(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('modal').classList.contains('hidden')) closePanel(); });
function closePanel() { if (/^#order-/.test(location.hash)) history.back(); else closeModal(); }

async function imageTags(ids) {
  const out = [];
  for (const id of ids || []) { try { out.push((await api('GET', '/images/' + id)).data); } catch { /* skip */ } }
  return out.map((src) => `<img src="${esc(src)}" alt="Design image">`).join('');
}

async function openOrder(id) {
  $('modal').classList.remove('hidden');
  $('panel').innerHTML = '<p class="muted">Loading…</p>';
  let o, recipes;
  try { [o, recipes] = await Promise.all([api('GET', '/admin/orders/' + id), api('GET', '/admin/tables/recipes')]); }
  catch (e) { $('panel').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; return; }
  if (o.status === 'Draft') return openDraft(o);
  const needs = C.computeNeeds(o.items, recipes);
  const kv = (k, v) => v ? `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>` : '';
  const invLink = o.square_invoice_url
    ? `<a class="btn btn-ghost btn-small" target="_blank" rel="noopener" href="${esc(isDemo ? '#' : o.square_invoice_url)}" id="sqLink">💳 Open draft invoice in Square</a>`
    : `<button class="btn btn-ghost btn-small" id="mkInv">💳 Create Square draft invoice</button>`;
  $('panel').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
      <div><div class="muted">Order #${o.orderNo} · submitted ${esc(new Date(o.submitted_at || o.created_at).toLocaleString())}</div><h2>${esc(o.name)}</h2></div>
      <button class="x noprint" style="font-size:22px" id="closeP" aria-label="Close">✕</button></div>
    ${o.needs_review ? `<div class="msg warn" id="reviewBox">${C.changesHtml(o.changes).replace(/^<div[^>]*>/, '').replace(/<\/div>$/, '')}
      <button class="btn btn-main btn-small" id="reviewed">✓ Changes reviewed</button> <span class="hint">Adjust the price in Square if needed, then confirm the order.</span></div>` : ''}
    <div class="toolbar noprint" style="margin-top:12px">
      <label style="margin:0">Status</label>
      <select id="status" style="width:auto">${C.STATUSES.filter((s) => s !== 'Draft').map((s) => `<option ${s === o.status ? 'selected' : ''}>${s}</option>`).join('')}</select>
      <label style="margin:0 0 0 8px">Payment</label>
      <select id="payment" style="width:auto">${C.PAYMENT_STATUSES.map((s) => `<option ${s === (o.payment_status || 'Unpaid') ? 'selected' : ''}>${s}</option>`).join('')}</select>
    </div>
    <div id="statusMsg" class="hint"></div>
    <div class="actions">${invLink}
      <a class="btn btn-ghost btn-small" href="mailto:${esc(o.email)}?subject=${encodeURIComponent('Your order #' + o.orderNo)}">✉️ Email</a>
      <a class="btn btn-ghost btn-small" href="sms:${esc(o.phone)}">💬 Text</a>
      <button class="btn btn-ghost btn-small" id="printSigned">🖨️ Signed copy</button>
      <label class="hint" style="display:flex;gap:6px;align-items:center;margin:0"><input type="checkbox" id="withTerms" style="width:auto"> include terms</label></div>
    <dl class="kv">
      ${kv('Event', [o.event_type, C.displayDate(o.event_date)].filter(Boolean).join(' · '))}
      ${kv(o.fulfillment || 'Pickup', (o.time ? C.displayTime(o.time) : 'Time not given') + (o.address ? ' · ' + o.address + (o.zip ? ' ' + o.zip : '') : ''))}
      ${kv('Phone', o.phone)}${kv('Email', o.email)}${kv('Payment', o.payment_method)}
      ${kv('Price', C.money(o.subtotal) + (o.delivery_fee ? ` + ${C.money(o.delivery_fee)} delivery${o.delivery_zone ? ' (' + o.delivery_zone + ')' : ''}` : '') + (o.fee ? ` + ${C.money(o.fee)} card fee` : '') + ` = ${C.money(o.total)}`)}
    </dl>
    ${o.allergies ? `<div class="msg err"><b>Allergies:</b> ${esc(o.allergies)}</div>` : ''}
    ${o.design_summary ? `<h3>Design</h3><p style="white-space:pre-wrap">${esc(o.design_summary)}</p>` : ''}
    <div class="thumbs" id="thumbs"></div>
    <h3>Items</h3><ol class="items">${o.items.map((it) => `<li><b>${esc(C.itemLabel(it))}</b>${it.price !== undefined ? ` · ${C.money(it.price)}${it.qty > 1 ? ' each' : ''}` : ''}${it.added ? ' <span class="pill warnpill">added by customer</span>' : ''}
      ${it.notes ? `<br><span class="muted">${esc(it.notes)}</span>` : ''}${it.customerNotes ? `<br><span style="color:var(--warn)">Customer: ${esc(it.customerNotes)}</span>` : ''}</li>`).join('')}</ol>
    ${o.notes ? `<h3>Notes</h3><p style="white-space:pre-wrap">${esc(o.notes)}</p>` : ''}
    <details><summary><b>Ingredients this order uses</b></summary>
      <table class="t" style="margin-top:8px">${Object.entries(needs.needs).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${v}</td></tr>`).join('') || '<tr><td class="muted">No recipes match this order yet.</td></tr>'}</table>
      ${needs.missing.length ? `<p class="msg warn">No recipe on file for: ${esc(needs.missing.join(', '))}</p>` : ''}</details>
    <details style="margin-top:10px"><summary><b>Terms &amp; signature</b> <span class="muted">· agreed ${esc(new Date(o.terms_accepted_at).toLocaleString())} · initials ${esc(o.initials)}</span></summary>
      <div class="terms-box" style="margin-top:8px">${esc(o.terms_text)}</div>
      ${o.signature ? `<p><img class="sigimg" alt="Customer signature" src="${esc(o.signature)}"></p>` : '<p class="muted">(Example order – no signature.)</p>'}</details>
  `;
  imageTags(o.images).then((h) => { if ($('thumbs')) $('thumbs').innerHTML = h; });
  $('closeP').addEventListener('click', closePanel);
  $('status').addEventListener('change', async (e) => {
    const s = e.target.value;
    $('statusMsg').textContent = 'Saving…';
    try {
      const r = await api('POST', `/admin/orders/${id}/status`, { status: s });
      $('statusMsg').textContent = '✓ Saved' + (r.deducted ? ' – ingredients taken out of inventory' : '') + (r.emailed ? ' – confirmation emailed to the customer' : '');
      await loadOrders();
    } catch (err) { $('statusMsg').textContent = '⚠ ' + err.message; e.target.value = o.status; }
  });
  $('payment').addEventListener('change', async (e) => {
    try { await api('POST', `/admin/orders/${id}/payment`, { payment_status: e.target.value }); $('statusMsg').textContent = '✓ Payment saved'; await loadOrders(); }
    catch (err) { $('statusMsg').textContent = '⚠ ' + err.message; }
  });
  if ($('reviewed')) $('reviewed').addEventListener('click', async () => { await api('POST', `/admin/orders/${id}/reviewed`); await loadOrders(); openOrder(id); });
  if ($('mkInv')) $('mkInv').addEventListener('click', async () => {
    $('mkInv').textContent = 'Creating…';
    try { await api('POST', `/admin/orders/${id}/invoice`); openOrder(id); }
    catch (err) { $('mkInv').textContent = '⚠ ' + err.message; }
  });
  if (isDemo && $('sqLink')) $('sqLink').addEventListener('click', (e) => {
    e.preventDefault();
    $('statusMsg').textContent = 'Demo: on the real site this opens the draft invoice in Square, already filled in, ready for you to check and press Send.';
  });
  $('printSigned').addEventListener('click', () => printSigned(o, $('withTerms').checked));
}

function printSigned(o, withTerms) {
  const body = C.orderHtml(o) + (withTerms ? C.signedBlockHtml(o)
    : `<p><b>Agreed to terms:</b> ✔ · <b>Initials:</b> ${esc(o.initials)} · ${esc(o.terms_accepted_at)}</p>` +
      (o.signature ? `<p><img alt="signature" src="${o.signature}" style="height:80px;border-bottom:1px solid #999"></p>` : ''));
  const w = window.open('', '_blank');
  if (!w) {
    $('panel').innerHTML = `<div class="actions noprint"><button class="btn btn-ghost btn-small" id="backToOrder">← Back to order</button></div>` + body;
    $('backToOrder').addEventListener('click', () => openOrder(o.id));
    return;
  }
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Order #${o.orderNo}</title></head>
    <body style="font-family:Arial;max-width:720px;margin:24px auto;padding:0 16px">${body}
    <p style="color:#888;font-size:11px">Submitted online ${esc(o.submitted_at || o.created_at)} · ${esc(o.client_info || '')}</p></body></html>`);
  w.document.close();
  setTimeout(() => w.print(), 300);
}

// ───────── Prepare a private order link ─────────
function openDraft(o) {
  const link = customerLink(o.token);
  $('panel').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
      <div><div class="muted">Order #${o.orderNo} · link prepared ${esc(new Date(o.created_at).toLocaleString())}</div><h2>${esc(o.name || 'Order link')}</h2></div>
      <button class="x" style="font-size:22px" id="closeP" aria-label="Close">✕</button></div>
    <div class="msg ok" style="margin-top:12px"><b>Waiting for the customer.</b> Send them this private link:</div>
    <div class="copy"><input readonly id="custLink" value="${esc(link)}"><button class="btn btn-main btn-small" id="copyLink">Copy</button></div>
    <div class="actions"><a class="btn btn-ghost btn-small" href="${esc(link)}" ${isDemo ? '' : 'target="_blank" rel="noopener"'}>👀 Open as the customer</a>
      <button class="btn btn-ghost btn-small" id="editDraft">✏️ Edit</button>
      <button class="btn btn-danger btn-small" id="cancelDraft">Cancel this link</button></div>
    ${o.design_summary ? `<h3>Design</h3><p style="white-space:pre-wrap">${esc(o.design_summary)}</p>` : ''}<div class="thumbs" id="thumbs"></div>
    <h3>Items</h3><ol class="items">${o.items.map((it) => `<li><b>${esc(C.itemLabel(it))}</b> · ${C.money(it.price)}${it.qty > 1 ? ' each' : ''}${it.notes ? `<br><span class="muted">${esc(it.notes)}</span>` : ''}</li>`).join('')}</ol>
    <p><b>Total so far:</b> ${C.money(o.total)} <span class="muted">(+ delivery and card fee once the customer chooses)</span></p>`;
  imageTags(o.images).then((h) => { if ($('thumbs')) $('thumbs').innerHTML = h; });
  $('closeP').addEventListener('click', closePanel);
  $('copyLink').addEventListener('click', () => copyText($('custLink'), $('copyLink')));
  $('editDraft').addEventListener('click', () => openPrepare(o));
  $('cancelDraft').addEventListener('click', async () => {
    if ($('cancelDraft').dataset.sure !== '1') { $('cancelDraft').dataset.sure = '1'; $('cancelDraft').textContent = 'Tap again to cancel the link'; return; }
    await api('POST', `/admin/orders/${o.id}/status`, { status: 'Cancelled' }); await loadOrders(); closePanel(); renderOrders();
  });
}

function copyText(input, btn) {
  input.select();
  const done = () => { btn.textContent = 'Copied ✓'; };
  try { navigator.clipboard.writeText(input.value).then(done, done); } catch { done(); }
}

/** Shrink a photo to max 1400px JPEG so it uploads quickly. */
function shrinkImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const max = 1400, k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/jpeg', isDemo ? 0.6 : 0.82));
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => reject(new Error('Could not read that image.'));
    img.src = URL.createObjectURL(file);
  });
}

async function openPrepare(existing) {
  const cfg = await call('GET', '/config');
  const products = [...new Set(cfg.products.map((p) => p.product))];
  const ex = existing || {};
  let images = [...(ex.images || [])];
  $('modal').classList.remove('hidden');
  $('panel').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
      <div><h2>${existing ? 'Edit order link' : 'Prepare an order link'}</h2><p class="hint" style="margin:4px 0 0">Fill in what you agreed. Whatever you leave empty, the customer fills in. Sizes, tiers and prices you set here are locked for them.</p></div>
      <button class="x" style="font-size:22px" id="closeP" aria-label="Close">✕</button></div>
    <div id="prepErr"></div>
    <h3>Customer</h3>
    <div class="grid">
      <div class="full"><label for="pName">Name</label><input id="pName" value="${esc(ex.name || '')}"></div>
      <div><label for="pEmail">Email</label><input id="pEmail" type="email" value="${esc(ex.email || '')}"></div>
      <div><label for="pPhone">Phone</label><input id="pPhone" value="${esc(ex.phone || '')}"></div>
      <div><label for="pType">Event</label><select id="pType"><option value="">–</option>${cfg.eventTypes.map((t) => `<option ${t === ex.event_type ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></div>
      <div><label for="pDate">Date</label><input id="pDate" type="date" value="${esc(ex.event_date || '')}"></div>
    </div>
    <h3>Design you agreed on</h3>
    <textarea id="pDesign" style="min-height:110px" placeholder="e.g. 2-tier, navy & gold, gold drip on top tier, &quot;Mazel Tov Eli&quot; in gold script…">${esc(ex.design_summary || '')}</textarea>
    <div class="thumbs" id="pThumbs"></div>
    <label class="btn btn-ghost btn-small" style="margin-top:8px">📎 Add sketch or photo<input type="file" id="pFile" accept="image/*" multiple hidden></label>
    <h3>Items</h3>
    <div id="pItems"></div>
    <button class="btn btn-ghost btn-small" id="pAdd">+ Add item</button>
    <div class="actions" style="margin-top:20px"><button class="btn btn-main" id="pSave">${existing ? 'Save changes' : 'Create link'}</button></div>`;
  $('closeP').addEventListener('click', () => existing ? openOrder(existing.id) : closeModal());

  const drawThumbs = async () => {
    $('pThumbs').innerHTML = '';
    for (const id of images) {
      const r = await api('GET', '/images/' + id).catch(() => null);
      if (!r) continue;
      const d = document.createElement('div');
      d.className = 'thumb';
      d.innerHTML = `<img src="${esc(r.data)}" alt=""><button class="x" title="Remove">✕</button>`;
      d.querySelector('button').addEventListener('click', () => { images = images.filter((x) => x !== id); drawThumbs(); });
      $('pThumbs').appendChild(d);
    }
  };
  drawThumbs();
  $('pFile').addEventListener('change', async (e) => {
    for (const f of e.target.files) {
      try { const data = await shrinkImage(f); const r = await api('POST', '/admin/images', { data }); images.push(r.id); }
      catch (err) { $('prepErr').innerHTML = `<div class="msg err">${esc(err.message)}</div>`; }
    }
    e.target.value = '';
    drawThumbs();
  });

  const sizesOf = (p) => cfg.products.filter((x) => x.product === p).map((x) => x.size);
  const tieredP = (p) => cfg.products.some((x) => x.product === p && x.tiered);
  const listsOf = (p, size) => { const r = cfg.products.find((x) => x.product === p && x.size === size) || cfg.products.find((x) => x.product === p) || {}; return [r.choice1, r.choice2]; };
  const choiceSel = (p, size, preset, n) => {
    const l = listsOf(p, size)[n - 1];
    if (!l) return '';
    return `<div><label>${esc(l)}</label><select data-k="choice${n}"><option value="">Customer chooses</option>${(cfg.lists[l] || []).map((c) => `<option ${c === preset ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>`;
  };
  const addRow = (it = {}) => {
    const el = document.createElement('div');
    el.className = 'prep-item';
    el.innerHTML = `<button class="x" title="Remove" style="float:right">✕</button>
      <div class="grid"><div><label>Item</label><select data-k="product"><option value="">Choose…</option>${products.map((p) => `<option ${p === it.product ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select></div>
      <div class="pSize"></div>
      <div><label>Price${''} (each)</label><input data-k="price" type="number" step="0.01" min="0" value="${esc(it.price ?? '')}"></div>
      <div><label>Quantity</label><input data-k="qty" type="number" min="1" value="${esc(it.qty || 1)}"></div></div>
      <div class="pTiers"></div><div class="grid pChoices" style="margin-top:8px"></div>
      <div style="margin-top:8px"><label>Design notes for this item</label><input data-k="notes" value="${esc(it.notes || '')}"></div>`;
    $('pItems').appendChild(el);
    const prod = el.querySelector('[data-k="product"]');
    const draw = (seed) => {
      const p = prod.value;
      const tiered = tieredP(p);
      el.dataset.tiered = tiered ? '1' : '';
      el.querySelector('.pSize').innerHTML = !p ? '' : tiered
        ? `<label>Tiers</label><input data-k="tiers" type="number" min="1" max="12" value="${seed && seed.tiers ? seed.tiers.length : 1}">`
        : `<label>Size</label><select data-k="size">${sizesOf(p).map((s) => `<option ${seed && s === seed.size ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>`;
      const drawTiers = (tseed) => {
        const n = tiered ? Math.max(1, Math.min(12, +el.querySelector('[data-k="tiers"]').value || 1)) : 0;
        const old = [...el.querySelectorAll('.ptier')].map((t) => ({ size: t.querySelector('[data-k="tsize"]').value, choice1: (t.querySelector('[data-k="choice1"]') || {}).value, choice2: (t.querySelector('[data-k="choice2"]') || {}).value }));
        const src = tseed || old;
        el.querySelector('.pTiers').innerHTML = Array.from({ length: n }, (_, k) => {
          const t = src[k] || {};
          const size = t.size || sizesOf(p)[Math.max(0, sizesOf(p).length - 1 - k)] || '';
          return `<div class="ptier grid"><div><label>Tier ${k + 1}${k === 0 ? ' (bottom)' : ''} size</label><select data-k="tsize">${sizesOf(p).map((s) => `<option ${s === size ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></div>
            ${choiceSel(p, size, t.choice1, 1)}${choiceSel(p, size, t.choice2, 2)}</div>`;
        }).join('');
      };
      drawTiers(seed && seed.tiers);
      if (tiered) el.querySelector('[data-k="tiers"]').addEventListener('input', () => drawTiers());
      const sz = el.querySelector('[data-k="size"]');
      const drawChoices = (cs) => { el.querySelector('.pChoices').innerHTML = tiered || !p ? '' : choiceSel(p, sz.value, cs && cs.choice1, 1) + choiceSel(p, sz.value, cs && cs.choice2, 2); };
      drawChoices(seed);
      if (sz) sz.addEventListener('change', () => drawChoices());
    };
    prod.addEventListener('change', () => draw());
    draw(it);
    el.querySelector('.x').addEventListener('click', () => el.remove());
  };
  (ex.items && ex.items.length ? ex.items : [{}]).forEach(addRow);
  $('pAdd').addEventListener('click', () => addRow());

  $('pSave').addEventListener('click', async () => {
    const v = (el, k) => { const f = el.querySelector(`[data-k="${k}"]`); return f ? f.value.trim() : ''; };
    const items = [...$('pItems').querySelectorAll('.prep-item')].map((el) => {
      const it = { product: v(el, 'product'), qty: +v(el, 'qty') || 1, price: v(el, 'price'), notes: v(el, 'notes') };
      if (el.dataset.tiered) it.tiers = [...el.querySelectorAll('.ptier')].map((t) => ({ size: v(t, 'tsize'), choice1: v(t, 'choice1'), choice2: v(t, 'choice2') }));
      else Object.assign(it, { size: v(el, 'size'), choice1: v(el.querySelector('.pChoices'), 'choice1'), choice2: v(el.querySelector('.pChoices'), 'choice2') });
      return it;
    }).filter((it) => it.product);
    if (items.some((it) => it.price === '')) { $('prepErr').innerHTML = '<div class="msg err">Please enter the agreed price for every item.</div>'; $('panel').scrollTop = 0; return; }
    const body = { name: $('pName').value, email: $('pEmail').value, phone: $('pPhone').value, eventType: $('pType').value, eventDate: $('pDate').value,
      designSummary: $('pDesign').value, images, items };
    try {
      const r = existing ? await api('PUT', `/admin/drafts/${existing.id}`, body) : await api('POST', '/admin/drafts', body);
      await loadOrders();
      if ($('main').dataset.tab === 'orders') { filter = 'Draft'; renderOrders(); }
      location.hash = 'order-' + r.id;
      if (existing) openOrder(r.id);
    } catch (err) { $('prepErr').innerHTML = `<div class="msg err">${esc(err.message)}</div>`; $('panel').scrollTop = 0; }
  });
}

// ───────── Calendar ─────────
async function renderCalendar() {
  await loadOrders();
  const t = today();
  const upcoming = orders.filter((o) => !['Cancelled', 'Draft'].includes(o.status) && o.event_date >= t);
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

// ───────── Recipes: one recipe at a time, ingredients × sizes ─────────
let currentRecipe = '';
async function renderRecipes() {
  const [rows, products, choices, inv] = await Promise.all([api('GET', '/admin/tables/recipes'), api('GET', '/admin/tables/products'),
    api('GET', '/admin/tables/choices'), api('GET', '/admin/tables/inventory')]);
  // Group: each product (packaging, outside icing…) and each choice list (flavors, fillings…)
  const groups = [['Products (boards, boxes, outside icing, sticks…)', [...new Set(products.map((p) => p.product))]]];
  for (const l of [...new Set(choices.map((c) => c.list))]) groups.push([l, choices.filter((c) => c.list === l).map((c) => c.choice)]);
  const known = new Set(groups.flatMap((g) => g[1]).map(C.norm));
  const other = [...new Set(rows.map((r) => r.recipe))].filter((r) => !known.has(C.norm(r)));
  if (other.length) groups.push(['Other', other]);
  const count = (name) => rows.filter((r) => C.norm(r.recipe) === C.norm(name)).length;
  if (!currentRecipe) currentRecipe = groups[0][1][0] || '';
  $('main').innerHTML = `<div class="recipes">
    <nav class="rlist card">${groups.map(([g, names]) => `<div class="rgroup">${esc(g)}</div>` + names.map((n) =>
      `<button class="rname ${C.norm(n) === C.norm(currentRecipe) ? 'on' : ''}" data-r="${esc(n)}">${esc(n)}<span class="${count(n) ? 'muted' : 'missing'}">${count(n) || 'no recipe'}</span></button>`).join('')).join('')}</nav>
    <div class="card" id="rEdit"></div></div>
    <datalist id="dl-ing">${inv.map((i) => `<option value="${esc(i.ingredient)}">`).join('')}</datalist>`;
  $('main').querySelectorAll('.rname').forEach((b) => b.addEventListener('click', () => { currentRecipe = b.dataset.r; renderRecipes(); }));
  editRecipe(currentRecipe, rows, products, inv);
}

function editRecipe(name, rows, products, inv) {
  const mine = rows.filter((r) => C.norm(r.recipe) === C.norm(name));
  const allSizes = [...new Set(products.map((p) => p.size))];
  const usedSizes = [...new Set(mine.map((r) => r.size || ''))];
  let sizes = usedSizes.length ? usedSizes : (products.some((p) => C.norm(p.product) === C.norm(name)) ? products.filter((p) => C.norm(p.product) === C.norm(name)).map((p) => p.size) : allSizes.slice(0, 3));
  const ings = [...new Set(mine.map((r) => r.ingredient))];
  const unitOf = (i) => (inv.find((x) => C.norm(x.ingredient) === C.norm(i)) || {}).unit || '';
  const amount = (i, s) => { const r = mine.find((x) => C.norm(x.ingredient) === C.norm(i) && C.norm(x.size || '') === C.norm(s)); return r ? r.amount : ''; };
  const draw = () => {
    $('rEdit').innerHTML = `<div class="toolbar"><h2 style="margin:0;flex:1">${esc(name)}</h2>
        <select id="addSize" style="width:auto"><option value="">+ Add size…</option>${allSizes.filter((s) => !sizes.includes(s)).map((s) => `<option>${esc(s)}</option>`).join('')}${sizes.includes('') ? '' : '<option value="__all">Every size (same amount)</option>'}</select>
        <button class="btn btn-main btn-small" id="saveRec">Save recipe</button></div>
      <p class="hint" style="margin-top:0">How much goes into <b>one</b> ${esc(name)} of each size. Leave a box empty if that size doesn't use it.</p>
      <div id="recMsg"></div>
      <div class="scroll"><table class="t" id="recT"><thead><tr><th>Ingredient</th>${sizes.map((s) => `<th class="num">${esc(s || 'Every size')} <button class="x rmSize" data-s="${esc(s)}" title="Remove size">✕</button></th>`).join('')}<th></th></tr></thead>
      <tbody>${ings.map((i) => rowHtml(i)).join('')}</tbody></table></div>
      <button class="btn btn-ghost btn-small" id="addIng" style="margin-top:10px">+ Add ingredient</button>`;
    $('recT').querySelectorAll('tbody tr').forEach(bindRow);
    $('addIng').addEventListener('click', () => { const tb = $('recT').querySelector('tbody'); tb.insertAdjacentHTML('beforeend', rowHtml('')); bindRow(tb.lastElementChild); tb.lastElementChild.querySelector('input').focus(); });
    $('addSize').addEventListener('change', (e) => { const v = e.target.value === '__all' ? '' : e.target.value; snapshot(); sizes.push(v); draw(); });
    $('rEdit').querySelectorAll('.rmSize').forEach((b) => b.addEventListener('click', () => { snapshot(); sizes = sizes.filter((s) => s !== b.dataset.s); draw(); }));
    $('saveRec').addEventListener('click', save);
  };
  let cache = null; // keeps typed values when columns change
  const rowHtml = (i) => `<tr><td><input data-k="ingredient" list="dl-ing" value="${esc(i)}" placeholder="Ingredient"><span class="hint unit">${esc(unitOf(i))}</span></td>` +
    sizes.map((s) => `<td><input data-s="${esc(s)}" type="number" step="any" min="0" style="width:90px" value="${esc(cache ? (cache[i] || {})[s] ?? '' : amount(i, s))}"></td>`).join('') +
    '<td><button class="x" title="Remove">✕</button></td></tr>';
  const bindRow = (tr) => {
    tr.querySelector('.x').addEventListener('click', () => tr.remove());
    const ing = tr.querySelector('[data-k="ingredient"]');
    ing.addEventListener('input', () => { tr.querySelector('.unit').textContent = unitOf(ing.value); });
  };
  const snapshot = () => {
    cache = {};
    ings.length = 0;
    $('recT').querySelectorAll('tbody tr').forEach((tr) => {
      const i = tr.querySelector('[data-k="ingredient"]').value.trim();
      ings.push(i);
      cache[i] = Object.fromEntries([...tr.querySelectorAll('[data-s]')].map((x) => [x.dataset.s, x.value]));
    });
  };
  const save = async () => {
    snapshot();
    const others = rows.filter((r) => C.norm(r.recipe) !== C.norm(name));
    const mineNew = [];
    for (const i of ings) if (i) for (const s of sizes) { const a = (cache[i] || {})[s]; if (a !== '' && a != null) mineNew.push({ recipe: name, size: s, ingredient: i, amount: a, notes: '' }); }
    try {
      await api('PUT', '/admin/tables/recipes', others.concat(mineNew));
      const unknown = ings.filter((i) => i && !inv.some((x) => C.norm(x.ingredient) === C.norm(i)));
      $('recMsg').innerHTML = '<div class="msg ok">Saved ✓</div>' + (unknown.length ? `<div class="msg warn">Not on your inventory yet: <b>${esc(unknown.join(', '))}</b>. Add them on the Inventory tab so they get counted.</div>` : '');
      rows = others.concat(mineNew);
    } catch (e) { $('recMsg').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
  };
  draw();
}

async function renderMenu() {
  $('main').innerHTML = '<div id="prod"></div><div id="cho"></div><div id="zon"></div>' +
    '<datalist id="dl-list"></datalist><datalist id="dl-yes"><option value="yes"></datalist>';
  const choices = await api('GET', '/admin/tables/choices');
  $('main').querySelector('#dl-list').innerHTML = [...new Set(choices.map((c) => c.list))].map((l) => `<option value="${esc(l)}">`).join('');
  await tableEditor($('prod'), {
    title: '🎂 Products & sizes', table: 'products',
    help: '<b>Tiered</b> = "yes" for cakes that can have tiers (each size row is a tier size). <b>Add-on</b> = "yes" if customers may add it themselves on the form; ' +
      '<b>Min. price</b> is what such an add-on starts at. Orders you prepare use the price you type in.',
    cols: [{ key: 'product', label: 'Product' }, { key: 'size', label: 'Size / option', w: '120px' }, { key: 'price', label: 'Min. price', num: true, w: '90px' },
      { key: 'choice1', label: 'Choice 1 list', list: 'dl-list' }, { key: 'choice2', label: 'Choice 2 list', list: 'dl-list' },
      { key: 'tiered', label: 'Tiered', list: 'dl-yes', w: '70px' }, { key: 'addon', label: 'Add-on', list: 'dl-yes', w: '70px' }]
  });
  await tableEditor($('cho'), {
    title: '🍫 Flavors, fillings & other choices', table: 'choices', filterable: true,
    help: 'Each row is one option in a dropdown. The <b>List</b> name connects it to the products above.',
    cols: [{ key: 'list', label: 'List', list: 'dl-list' }, { key: 'choice', label: 'Choice' }]
  });
  await tableEditor($('zon'), {
    title: '🚚 Delivery zones', table: 'zones',
    help: 'The customer types their zip code and the zone (and fee) is picked automatically. If their zip isn\'t listed, they choose a zone from the list. ' +
      'Zip codes: single ones or ranges, separated by commas, e.g. <i>10001-10282, 10451</i>.',
    cols: [{ key: 'zone', label: 'Zone', w: '160px' }, { key: 'fee', label: 'Fee', num: true, w: '80px' }, { key: 'zips', label: 'Zip codes' }]
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

// ───────── Requests & bugs (during development) ─────────
async function renderFeedback() {
  const list = await api('GET', '/admin/feedback');
  $('main').innerHTML = `<div class="card"><h2>🐞 Requests &amp; issues</h2><p class="hint" style="margin-top:0">Everything you sent with the <b>Report an issue</b> button.
    Claude reads these, works on them, and updates the status.</p></div>` +
    (list.length ? list.map((f) => `<div class="card fb" data-id="${f.id}">
      <div class="toolbar" style="margin:0"><span class="pill fb-${esc(f.status.replace(/\W/g, ''))}">${esc(f.status)}</span>
        <span class="muted" style="flex:1">#${f.id} · ${esc(new Date(f.created_at).toLocaleString())} · ${esc(f.page)}</span>
        <select class="fbStatus" style="width:auto">${['New', 'In progress', 'Fixed', "Won't do"].map((s) => `<option ${s === f.status ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></div>
      <p style="white-space:pre-wrap;margin:10px 0">${esc(f.note)}</p>
      ${f.reply ? `<div class="msg ok"><b>Reply:</b> ${esc(f.reply)}</div>` : ''}
      ${f.hasScreenshot ? '<button class="btn btn-ghost btn-small showShot">🖼️ Show screenshot</button><div class="shot"></div>' : ''}
    </div>`).join('') : '<div class="card muted">Nothing reported yet. Use the <b>Report an issue</b> button at the bottom right of any page.</div>');
  $('main').querySelectorAll('.fb').forEach((card) => {
    const id = card.dataset.id;
    card.querySelector('.fbStatus').addEventListener('change', async (e) => { await api('POST', '/admin/feedback/' + id, { status: e.target.value }); renderFeedback(); });
    const b = card.querySelector('.showShot');
    if (b) b.addEventListener('click', async () => { const f = await api('GET', '/admin/feedback/' + id); card.querySelector('.shot').innerHTML = `<img src="${esc(f.screenshot)}" alt="Screenshot" style="max-width:100%;border:1px solid var(--line);border-radius:8px;margin-top:8px">`; b.remove(); });
  });
}

// ───────── Install as an app ─────────
if ('serviceWorker' in navigator && !isDemo && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

boot();
