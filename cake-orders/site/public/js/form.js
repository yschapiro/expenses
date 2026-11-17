import { call, isDemo } from './client.js';
import * as C from './core.js';
import { installReportButton } from './report.js';

const $ = (id) => document.getElementById(id);
let CONFIG;
let PREP = null;          // the prepared order (from your private link), or null for the general form
let TOKEN = '';

function fillSelect(sel, options, placeholder, value) {
  sel.innerHTML = '';
  if (placeholder) sel.add(new Option(placeholder, ''));
  options.forEach((o) => sel.add(typeof o === 'string' ? new Option(o, o) : new Option(o.label, o.value)));
  if (value) sel.value = value;
}
const unique = (arr) => [...new Set(arr)];
const productRows = (product) => CONFIG.products.filter((p) => p.product === product);
const listsFor = (product, size) => {
  const row = CONFIG.products.find((p) => p.product === product && p.size === size) || productRows(product)[0] || {};
  return [row.choice1 || '', row.choice2 || ''];
};
const minPrice = (product, size) => (CONFIG.products.find((p) => p.product === product && p.size === size) || {}).price || 0;

function tokenFromUrl() {
  const q = new URLSearchParams(location.search).get('o');
  if (q) return q;
  const h = location.hash.match(/^#o-([A-Za-z0-9]{16,64})$/);
  return h ? h[1] : '';
}

async function start() {
  if (isDemo) $('demoBanner').classList.remove('hidden');
  TOKEN = tokenFromUrl();
  try {
    CONFIG = await call('GET', '/config');
    if (TOKEN) PREP = await call('GET', '/order/' + TOKEN);
  } catch (e) {
    $('loadError').textContent = TOKEN ? e.message : 'Sorry, the order form could not load. Please try again later. (' + e.message + ')';
    $('loadError').classList.remove('hidden');
    if (CONFIG) $('biz').textContent = CONFIG.businessName;
    return;
  }
  document.title = CONFIG.businessName + ' – Order Form';
  $('biz').textContent = CONFIG.businessName;
  if (PREP && PREP.submitted) {
    $('thanksText').innerHTML = `We already have your order <b>#${PREP.orderNo}</b>. To change anything, please contact us.`;
    $('thanks').classList.remove('hidden');
    return;
  }
  $('terms').textContent = CONFIG.terms;
  fillSelect($('eventType'), CONFIG.eventTypes, 'Choose…');
  fillSelect($('paymentMethod'), CONFIG.paymentMethods.map((m) =>
    ({ value: m, label: m === CONFIG.cardMethod && CONFIG.cardFeePct ? `${m} (+${CONFIG.cardFeePct}% card fee)` : m })), 'Choose…');
  fillSelect($('zone'), CONFIG.zones.map((z) => ({ value: z.zone, label: `${z.zone} – ${C.money(z.fee)}` })), 'Choose…');
  $('eventDate').min = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

  if (PREP) {
    for (const [id, k] of [['name', 'name'], ['email', 'email'], ['phone', 'phone'], ['eventDate', 'eventDate'], ['time', 'time']]) if (PREP[k]) $(id).value = PREP[k];
    if (PREP.eventType) $('eventType').value = PREP.eventType;
    if (PREP.fulfillment) $('fulfillment').value = PREP.fulfillment;
    if (PREP.designSummary || PREP.images.length) {
      $('designCard').classList.remove('hidden');
      $('designText').textContent = PREP.designSummary || '';
      for (const id of PREP.images) {
        call('GET', '/images/' + id).then((r) => {
          const img = new Image();
          img.src = r.data; img.alt = 'Design sketch or inspiration';
          img.addEventListener('click', () => lightbox(r.data));
          $('gallery').appendChild(img);
        }).catch(() => {});
      }
    }
    $('itemsHint').classList.remove('hidden');
    PREP.items.forEach((it) => addPreparedItem(it));
  } else {
    addOpenItem();
  }
  onFulfillment();
  $('form').classList.remove('hidden');
  sizeCanvas();
  updateTotals();
}

function lightbox(src) {
  const d = document.createElement('div');
  d.className = 'lightbox';
  d.innerHTML = `<img alt="" src="${C.esc(src)}">`;
  d.addEventListener('click', () => d.remove());
  document.body.appendChild(d);
}

// ── Choice dropdowns for one cake/tier ──
function choiceFields(product, size, preset = {}, prefix = '') {
  const [l1, l2] = listsFor(product, size);
  return [[1, l1], [2, l2]].filter(([, l]) => l).map(([n, l]) => {
    const fixed = preset['choice' + n];
    return `<div><label class="req">${prefix}${C.esc(l)}</label>` + (fixed
      ? `<div class="fixed" data-k="choice${n}" data-fixed="${C.esc(fixed)}">${C.esc(fixed)}</div>`
      : `<select data-k="choice${n}" data-list="${C.esc(l)}"></select>`) + '</div>';
  }).join('');
}
function fillChoiceSelects(el) {
  el.querySelectorAll('select[data-list]').forEach((sel) => fillSelect(sel, CONFIG.lists[sel.dataset.list] || [], 'Choose…'));
}

// ── Items you prepared (sizes, tiers and price locked) ──
function addPreparedItem(it) {
  const el = document.createElement('div');
  el.className = 'item';
  el.dataset.ref = it.ref;
  el.dataset.tiered = it.tiers ? '1' : '';
  const name = C.itemName(it);
  let body = `<div class="locked"><div class="num">${C.esc(it.tiers ? name : it.product)}</div><div class="price">${C.money(it.price * it.qty)}</div></div>`;
  if (it.notes) body += `<p class="hint" style="margin-top:0">${C.esc(it.notes)}</p>`;
  if (it.tiers) {
    body += it.tiers.map((t, k) => `<div class="tier" data-tier="${k}"><h4>Tier ${k + 1} · ${C.esc(t.size)}</h4><div class="grid">${choiceFields(it.product, t.size, t)}</div></div>`).join('');
  } else {
    body += `<div class="grid"><div><label>Size</label><div class="fixed">${C.esc(it.size)}</div></div>
      <div><label>Quantity</label><input data-k="qty" type="number" min="1" value="${it.qty}" inputmode="numeric" data-orig="${it.qty}" data-unit="${it.price}"></div>
      ${choiceFields(it.product, it.size, it)}</div>`;
  }
  body += `<details style="margin-top:10px"><summary class="hint" style="cursor:pointer">Add a note about this item</summary><textarea data-k="customerNotes" placeholder="Anything we should know?"></textarea></details>`;
  el.innerHTML = body;
  $('items').appendChild(el);
  fillChoiceSelects(el);
  const q = el.querySelector('[data-k="qty"]');
  if (q) q.addEventListener('input', () => {
    const changed = +q.value !== +q.dataset.orig;
    el.querySelector('.price').textContent = C.money(+q.dataset.unit * (+q.value || 1));
    let n = el.querySelector('.added-note');
    if (changed && !n) { n = document.createElement('div'); n.className = 'added-note'; n.textContent = 'Quantity changed – we\'ll confirm this with you.'; q.parentElement.appendChild(n); }
    if (!changed && n) n.remove();
    updateTotals();
  });
}

// ── Items the customer picks themselves (general form, or extras on a prepared link) ──
function addOpenItem() {
  const el = document.createElement('div');
  el.className = 'item open';
  el.innerHTML = '<div class="num"></div><button type="button" class="remove">✕ Remove</button>' +
    '<div class="grid"><div><label class="req">Item</label><select data-k="product"></select></div>' +
    '<div class="sizewrap"><label class="req">Size</label><select data-k="size"></select></div>' +
    '<div class="tierwrap hidden"><label class="req">Tiers</label><select data-k="tiercount"><option>1</option><option>2</option><option>3</option><option value="more">More than 3</option></select>' +
    '<input data-k="tiermore" type="number" min="4" max="12" value="4" class="hidden" style="margin-top:6px"></div>' +
    '<div><label class="req">Quantity</label><input data-k="qty" type="number" min="1" value="1" inputmode="numeric"></div></div>' +
    '<div class="tiers"></div><div class="grid choices" style="margin-top:12px"></div>' +
    '<div style="margin-top:12px"><label>Design details</label><textarea data-k="notes" placeholder="Colors, theme, wording…"></textarea></div>';
  $('items').appendChild(el);
  const q = (k) => el.querySelector(`[data-k="${k}"]`);
  const products = unique(CONFIG.products.filter((p) => !PREP || (p.addon && !p.tiered)).map((p) => p.product));
  fillSelect(q('product'), products, 'Choose…');
  q('product').addEventListener('change', () => onProduct(el));
  q('size').addEventListener('change', () => { drawChoices(el); updateTotals(); });
  q('qty').addEventListener('input', updateTotals);
  q('tiercount').addEventListener('change', () => { q('tiermore').classList.toggle('hidden', q('tiercount').value !== 'more'); drawTiers(el); });
  q('tiermore').addEventListener('input', () => drawTiers(el));
  el.querySelector('.remove').addEventListener('click', () => { el.remove(); renumber(); updateTotals(); });
  onProduct(el);
  renumber();
}
function onProduct(el) {
  const product = el.querySelector('[data-k="product"]').value;
  const tiered = productRows(product).some((p) => p.tiered);
  el.dataset.tiered = tiered ? '1' : '';
  el.querySelector('.sizewrap').classList.toggle('hidden', tiered);
  el.querySelector('.tierwrap').classList.toggle('hidden', !tiered);
  fillSelect(el.querySelector('[data-k="size"]'), productRows(product).map((p) => p.size), product ? 'Choose…' : '—');
  drawTiers(el);
  drawChoices(el);
  updateTotals();
}
function tierCount(el) {
  const v = el.querySelector('[data-k="tiercount"]').value;
  return v === 'more' ? Math.min(12, Math.max(4, +el.querySelector('[data-k="tiermore"]').value || 4)) : +v;
}
function drawTiers(el) {
  const wrap = el.querySelector('.tiers');
  if (!el.dataset.tiered) { wrap.innerHTML = ''; return; }
  const product = el.querySelector('[data-k="product"]').value;
  const sizes = productRows(product).map((p) => p.size);
  const n = tierCount(el);
  const old = [...wrap.querySelectorAll('.tier')].map((t) => ({ size: t.querySelector('[data-k="tsize"]').value }));
  wrap.innerHTML = Array.from({ length: n }, (_, k) => `<div class="tier" data-tier="${k}"><h4>Tier ${k + 1}${k === 0 ? ' (bottom)' : ''}</h4>
    <div class="grid"><div><label class="req">Size</label><select data-k="tsize"></select></div><div class="tc grid" style="display:contents"></div></div></div>`).join('');
  wrap.querySelectorAll('.tier').forEach((t, k) => {
    const sel = t.querySelector('[data-k="tsize"]');
    fillSelect(sel, sizes, 'Choose…', old[k] && old[k].size);
    const draw = () => { t.querySelector('.tc').innerHTML = choiceFields(product, sel.value); fillChoiceSelects(t); };
    sel.addEventListener('change', draw);
    draw();
  });
}
function drawChoices(el) {
  const box = el.querySelector('.choices');
  if (el.dataset.tiered) { box.innerHTML = ''; return; }
  const product = el.querySelector('[data-k="product"]').value;
  box.innerHTML = choiceFields(product, el.querySelector('[data-k="size"]').value);
  fillChoiceSelects(box);
}
function renumber() {
  const open = [...document.querySelectorAll('.item.open')];
  open.forEach((el, i) => {
    el.querySelector('.num').textContent = PREP ? 'Added item ' + (i + 1) : 'Item ' + (i + 1);
    el.querySelector('.remove').classList.toggle('hidden', !PREP && open.length === 1);
  });
  $('addHint').classList.toggle('hidden', !PREP || !open.length);
}
$('addItem').addEventListener('click', addOpenItem);

// ── Delivery area ──
function currentZone() {
  if ($('fulfillment').value !== 'Delivery' || !CONFIG.zones.length) return null;
  return C.matchZone($('zip').value, CONFIG.zones) || CONFIG.zones.find((z) => z.zone === $('zone').value) || null;
}
function onFulfillment() {
  const del = $('fulfillment').value === 'Delivery';
  document.querySelectorAll('.addr').forEach((e) => e.classList.toggle('hidden', !del));
  onZip();
}
function onZip() {
  const del = $('fulfillment').value === 'Delivery';
  const auto = del ? C.matchZone($('zip').value, CONFIG.zones) : null;
  const zipDone = /\d{5}/.test($('zip').value);
  $('zoneWrap').classList.toggle('hidden', !del || !CONFIG.zones.length || !!auto || !zipDone);
  $('zoneInfo').classList.toggle('hidden', !auto);
  if (auto) $('zoneInfo').innerHTML = `<div class="zone-ok">Delivery area: ${C.esc(auto.zone)} – ${C.money(auto.fee)}</div>`;
  updateTotals();
}
$('fulfillment').addEventListener('change', onFulfillment);
$('zip').addEventListener('input', onZip);
$('zone').addEventListener('change', updateTotals);
$('paymentMethod').addEventListener('change', updateTotals);

// ── Running total (prepared links only – the general form has no agreed prices yet) ──
function updateTotals() {
  if (!PREP) return;
  const items = collectItems();
  const lines = items.map((it) => {
    const prep = PREP.items.find((p) => p.ref === it.ref);
    return { label: C.itemName(prep || it), amount: (prep ? prep.price : minPrice(it.product, it.size)) * (it.qty || 1), added: !prep };
  }).filter((l) => l.label.trim());
  const zone = currentZone();
  const sub = lines.reduce((a, l) => a + l.amount, 0) + (zone ? zone.fee : 0);
  const card = $('paymentMethod').value && $('paymentMethod').value === CONFIG.cardMethod ? C.r2(sub * CONFIG.cardFeePct / 100) : 0;
  $('totals').innerHTML = lines.map((l) => `<tr><td>${C.esc(l.label)}${l.added ? ' <span class="muted">(from)</span>' : ''}</td><td>${C.money(l.amount)}</td></tr>`).join('') +
    (zone ? `<tr><td>Delivery – ${C.esc(zone.zone)}</td><td>${C.money(zone.fee)}</td></tr>` : '') +
    (card ? `<tr><td>Card fee (${CONFIG.cardFeePct}%)</td><td>${C.money(card)}</td></tr>` : '') +
    `<tr class="total"><td>Total${lines.some((l) => l.added) ? ' (estimate)' : ''}</td><td>${C.money(sub + card)}</td></tr>`;
  $('totals').classList.remove('hidden');
}

// ── Signature pad ──
const canvas = $('sig'), ctx = canvas.getContext('2d');
let drawing = false, signed = false, last = null;
function sizeCanvas() {
  const r = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  if (!r.width) return;
  const saved = signed ? canvas.toDataURL() : null;
  canvas.width = r.width * dpr; canvas.height = r.height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#1d1a22';
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, r.width, r.height);
  if (saved) { const img = new Image(); img.onload = () => ctx.drawImage(img, 0, 0, r.width, r.height); img.src = saved; }
}
const pos = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
canvas.addEventListener('pointerdown', (e) => { drawing = true; last = pos(e); canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointermove', (e) => {
  if (!drawing) return;
  const p = pos(e);
  ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
  last = p;
  if (!signed) { signed = true; updateSubmit(); }
});
['pointerup', 'pointercancel', 'pointerleave'].forEach((t) => canvas.addEventListener(t, () => { drawing = false; }));
$('clearSig').addEventListener('click', () => { signed = false; sizeCanvas(); updateSubmit(); });
window.addEventListener('resize', sizeCanvas);

function updateSubmit() {
  const ok = $('agree').checked && $('initials').value.trim() && signed;
  $('submit').disabled = !ok;
  $('submitHint').classList.toggle('hidden', !!ok);
}
$('agree').addEventListener('change', updateSubmit);
$('initials').addEventListener('input', updateSubmit);

// ── Collect & check ──
const val = (el, k) => { const f = el.querySelector(`[data-k="${k}"]`); return f ? (f.dataset.fixed ?? f.value ?? '').trim() : ''; };
function collectItems() {
  return [...document.querySelectorAll('.item')].map((el) => {
    if (el.dataset.ref) {
      const it = { ref: el.dataset.ref, customerNotes: val(el, 'customerNotes') };
      if (el.dataset.tiered) it.tiers = [...el.querySelectorAll('.tier')].map((t) => ({ choice1: val(t, 'choice1'), choice2: val(t, 'choice2') }));
      else Object.assign(it, { qty: parseInt(val(el, 'qty'), 10) || 1, choice1: val(el, 'choice1'), choice2: val(el, 'choice2') });
      return it;
    }
    const it = { product: val(el, 'product'), qty: parseInt(val(el, 'qty'), 10) || 1, notes: val(el, 'notes') };
    if (el.dataset.tiered) it.tiers = [...el.querySelectorAll('.tier')].map((t) => ({ size: val(t, 'tsize'), choice1: val(t, 'choice1'), choice2: val(t, 'choice2') }));
    else Object.assign(it, { size: val(el, 'size'), choice1: val(el, 'choice1'), choice2: val(el, 'choice2') });
    return it;
  });
}
function collect() {
  const v = (id) => $(id).value.trim();
  const zone = currentZone();
  return {
    token: TOKEN || undefined, website: v('website'),
    name: v('name'), email: v('email'), phone: v('phone'),
    eventType: v('eventType'), eventDate: v('eventDate'), fulfillment: v('fulfillment'), time: v('time'),
    address: v('address'), zip: v('zip'), zone: zone ? zone.zone : v('zone'),
    items: collectItems(), allergies: v('allergies'), notes: v('notes'), paymentMethod: v('paymentMethod'),
    agreed: $('agree').checked, initials: v('initials'), signature: canvas.toDataURL('image/png')
  };
}
function check(d) {
  const miss = [];
  if (!d.name) miss.push('your name');
  if (!/^\S+@\S+\.\S+$/.test(d.email)) miss.push('a valid email');
  if (d.phone.replace(/\D/g, '').length < 7) miss.push('your phone number');
  if (!d.eventDate) miss.push('the date');
  if (!d.fulfillment) miss.push('pickup or delivery');
  if (d.fulfillment === 'Delivery' && !d.address) miss.push('the delivery address');
  if (d.fulfillment === 'Delivery' && CONFIG.zones.length && !currentZone()) miss.push('your zip code or delivery area');
  if (!d.paymentMethod) miss.push('how you will pay');
  document.querySelectorAll('.item').forEach((el, i) => {
    const empty = [...el.querySelectorAll('select')].filter((s) => !s.closest('.hidden') && !s.value);
    if (empty.length) miss.push('all choices for item ' + (i + 1));
  });
  return miss;
}

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const d = collect();
  const miss = check(d);
  const err = $('error');
  if (miss.length) { err.textContent = 'Please add ' + miss.join(', ') + '.'; err.classList.remove('hidden'); err.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
  err.classList.add('hidden');
  $('submit').disabled = true; $('submit').textContent = 'Sending…';
  try {
    const res = await call('POST', '/orders', d);
    $('form').classList.add('hidden');
    $('orderNo').textContent = res && res.orderNo ? ` (order #${res.orderNo})` : '';
    $('thanks').classList.remove('hidden');
    window.scrollTo(0, 0);
  } catch (e2) {
    err.textContent = e2.message;
    err.classList.remove('hidden');
    err.scrollIntoView({ behavior: 'smooth', block: 'center' });
    $('submit').disabled = false; $('submit').textContent = 'Submit order';
  }
});

start();
installReportButton({ always: isDemo });
