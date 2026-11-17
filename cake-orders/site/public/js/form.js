import { call, isDemo } from './client.js';

const $ = (id) => document.getElementById(id);
let CONFIG;

function fillSelect(sel, options, placeholder) {
  sel.innerHTML = '';
  if (placeholder) sel.add(new Option(placeholder, ''));
  options.forEach((o) => sel.add(typeof o === 'string' ? new Option(o, o) : new Option(o.label, o.value)));
}
const unique = (arr) => [...new Set(arr)];

async function start() {
  if (isDemo) $('demoBanner').classList.remove('hidden');
  try { CONFIG = await call('GET', '/config'); }
  catch (e) { $('loadError').textContent = 'Sorry, the order form could not load. Please try again later. (' + e.message + ')'; $('loadError').classList.remove('hidden'); return; }
  document.title = CONFIG.businessName + ' – Order Form';
  $('biz').textContent = CONFIG.businessName;
  $('terms').textContent = CONFIG.terms;
  fillSelect($('eventType'), CONFIG.eventTypes, 'Choose…');
  fillSelect($('paymentMethod'), CONFIG.paymentMethods.map((m) =>
    ({ value: m, label: m === CONFIG.cardMethod && CONFIG.cardFeePct ? `${m} (+${CONFIG.cardFeePct}% card fee)` : m })), 'Choose…');
  $('eventDate').min = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  $('form').classList.remove('hidden');
  addItem();
  sizeCanvas();
}

// ── Items ──
function addItem() {
  const el = document.createElement('div');
  el.className = 'item';
  el.innerHTML =
    '<div class="num"></div><button type="button" class="remove">✕ Remove</button>' +
    '<div class="grid">' +
      '<div><label class="req">Item</label><select data-k="product"></select></div>' +
      '<div><label class="req">Size</label><select data-k="size"></select></div>' +
      '<div class="c1"><label></label><select data-k="choice1"></select></div>' +
      '<div class="c2"><label></label><select data-k="choice2"></select></div>' +
      '<div><label class="req">Quantity</label><input data-k="qty" type="number" min="1" value="1" inputmode="numeric"></div>' +
      '<div class="full"><label>Design details</label><textarea data-k="notes" placeholder="Colors, theme, wording, tiers…"></textarea></div>' +
    '</div>';
  $('items').appendChild(el);
  const q = (k) => el.querySelector(`[data-k="${k}"]`);
  fillSelect(q('product'), unique(CONFIG.products.map((p) => p.product)), 'Choose…');
  q('product').addEventListener('change', () => onProduct(el));
  q('size').addEventListener('change', () => onSize(el));
  el.querySelector('.remove').addEventListener('click', () => { el.remove(); renumber(); });
  onProduct(el);
  renumber();
}
function onProduct(el) {
  const product = el.querySelector('[data-k="product"]').value;
  fillSelect(el.querySelector('[data-k="size"]'), CONFIG.products.filter((p) => p.product === product).map((p) => p.size), product ? 'Choose…' : '—');
  onSize(el);
}
function onSize(el) {
  const product = el.querySelector('[data-k="product"]').value;
  const size = el.querySelector('[data-k="size"]').value;
  const row = CONFIG.products.find((p) => p.product === product && p.size === size) || CONFIG.products.find((p) => p.product === product) || {};
  [1, 2].forEach((n) => {
    const listName = row['choice' + n];
    const wrap = el.querySelector('.c' + n);
    wrap.classList.toggle('hidden', !listName);
    const lab = wrap.querySelector('label');
    lab.textContent = listName || '';
    lab.className = listName ? 'req' : '';
    fillSelect(wrap.querySelector('select'), listName ? (CONFIG.lists[listName] || []) : [], 'Choose…');
  });
}
function renumber() {
  const items = [...document.querySelectorAll('.item')];
  items.forEach((el, i) => {
    el.querySelector('.num').textContent = 'Item ' + (i + 1);
    el.querySelector('.remove').classList.toggle('hidden', items.length === 1);
  });
}
$('addItem').addEventListener('click', addItem);
$('fulfillment').addEventListener('change', () => $('addressWrap').classList.toggle('hidden', $('fulfillment').value !== 'Delivery'));

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

// ── Submit only after agree + initials + signature ──
function updateSubmit() {
  const ok = $('agree').checked && $('initials').value.trim() && signed;
  $('submit').disabled = !ok;
  $('submitHint').classList.toggle('hidden', !!ok);
}
$('agree').addEventListener('change', updateSubmit);
$('initials').addEventListener('input', updateSubmit);

function collect() {
  const v = (id) => $(id).value.trim();
  const items = [...document.querySelectorAll('.item')].map((el) => {
    const g = (k) => el.querySelector(`[data-k="${k}"]`).value.trim();
    return { product: g('product'), size: g('size'), choice1: g('choice1'), choice2: g('choice2'), qty: parseInt(g('qty'), 10) || 1, notes: g('notes') };
  });
  return {
    website: v('website'),
    name: v('name'), email: v('email'), phone: v('phone'),
    eventType: v('eventType'), eventDate: v('eventDate'), fulfillment: v('fulfillment'), time: v('time'), address: v('address'),
    items, allergies: v('allergies'), notes: v('notes'), paymentMethod: v('paymentMethod'),
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
  if (!d.paymentMethod) miss.push('how you will pay');
  const els = document.querySelectorAll('.item');
  d.items.forEach((it, i) => {
    const needs = ['product', 'size'].concat([1, 2].filter((n) => !els[i].querySelector('.c' + n).classList.contains('hidden')).map((n) => 'choice' + n));
    if (needs.some((k) => !it[k])) miss.push('all choices for item ' + (i + 1));
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
    err.textContent = 'Sorry, something went wrong: ' + e2.message + ' Please try again.';
    err.classList.remove('hidden');
    $('submit').disabled = false; $('submit').textContent = 'Submit order';
  }
});

start();
