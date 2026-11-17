// Shared business logic for the order system.
// Used by: the Cloudflare Worker (server), the in-browser demo, and mirrored in PHP (godaddy/lib/core.php).
// Pure functions only — no network, no storage.

export const STATUSES = ['New', 'Confirmed', 'Done', 'Cancelled'];
export const OPEN_STATUSES = ['New', 'Confirmed'];

/** Settings: key → [default value, label, help]. */
export const SETTINGS_DEFS = {
  business_name: ['Sweet Creations', 'Business name', 'Shown on the form and in emails'],
  owner_email: ['', 'Your email', 'Where new-order alerts and the Sunday shopping list go'],
  timezone: ['America/New_York', 'Time zone', 'Used for "this week" and calendar times'],
  event_types: ['Wedding, Bar/Bat Mitzvah, Birthday, Baby Shower, Bridal Shower, Corporate, Other', 'Event types', 'Dropdown on the form (comma-separated)'],
  payment_methods: ['Credit card, Venmo, Cash App, Zelle', 'Payment methods', 'Dropdown on the form (comma-separated)'],
  card_fee_method: ['Credit card', 'Card fee applies to', 'Which payment method gets the fee (must match one above)'],
  card_fee_pct: ['3.5', 'Card fee %', 'Added to the invoice when that method is chosen'],
  currency: ['USD', 'Currency', ''],
  invoice_due_days: ['7', 'Invoice due (days before event)', 'Due date on the draft Square invoice'],
  send_customer_copy: ['Yes', 'Email customer a copy', 'Yes = customer gets their signed form by email'],
  square_env: ['production', 'Square environment', 'production = real; sandbox = testing'],
  square_location_id: ['', 'Square location ID', 'Dashboard → Settings → "Test Square" shows it'],
  terms: [[
    'SAMPLE TERMS – REPLACE WITH YOUR OWN', '',
    '1. Deposit & payment: A non-refundable deposit of 50% secures your date. The balance is due 7 days before your event.',
    '2. Changes: Design changes may be made up to 14 days before the event and may change the price.',
    '3. Cancellations: Cancellations within 14 days of the event are not refundable.',
    '4. Allergies: Our kitchen handles wheat, dairy, eggs, soy and nuts. We cannot guarantee any item is allergen-free.',
    '5. Pickup & delivery: Once the order leaves our hands, we are not responsible for damage caused by transport, heat or handling.',
    '6. Design: Every item is handmade. Colors and details may vary slightly from inspiration photos.',
    '7. Rentals: Cake stands or other rentals must be returned within 3 days or a replacement fee applies.'
  ].join('\n'), 'Terms & conditions', 'Customers must tick "I agree" and sign. A copy is saved with every order.']
};

/** Editable tables and their columns (same in every backend). */
export const TABLES = {
  products: ['product', 'size', 'price', 'choice1', 'choice2'],
  choices: ['list', 'choice'],
  inventory: ['ingredient', 'unit', 'on_hand', 'keep_at_least'],
  recipes: ['recipe', 'size', 'ingredient', 'amount', 'notes']
};
export const NUMERIC = { price: 1, on_hand: 1, keep_at_least: 1, amount: 1 };

// ───────── helpers ─────────
export const norm = (v) => String(v ?? '').trim().toLowerCase().replace(/[“”″]/g, '"').replace(/\s+/g, ' ');
export const num = (v) => { const n = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, '')); return isNaN(n) ? 0 : n; };
export const r2 = (n) => Math.round(n * 100) / 100;
export const r3 = (n) => Math.round(n * 1000) / 1000;
export const list = (v) => String(v ?? '').split(',').map((x) => x.trim()).filter(Boolean);
export const yes = (v) => /^(y|yes|true|1)$/i.test(String(v ?? '').trim());
export const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const money = (n) => '$' + Number(n || 0).toFixed(2);
export const orderNo = (id) => 1000 + Number(id);

export function settingsWithDefaults(stored) {
  const out = {};
  for (const k of Object.keys(SETTINGS_DEFS)) out[k] = stored && stored[k] != null && stored[k] !== '' ? String(stored[k]) : SETTINGS_DEFS[k][0];
  return out;
}

export function displayTime(t) {
  const m = String(t || '').match(/^(\d{1,2}):(\d{2})/);
  if (!m) return String(t || '');
  const h = +m[1];
  return ((h + 11) % 12 + 1) + ':' + m[2] + (h < 12 ? ' AM' : ' PM');
}

export function displayDate(d) {
  const m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return String(d || '');
  const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12));
  return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/** Today's date (YYYY-MM-DD) in the business's time zone. */
export function todayIn(tz) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
  catch { return new Date().toISOString().slice(0, 10); }
}
export function addDays(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

// ───────── form config ─────────
export function formConfig(settings, products, choices) {
  const s = settingsWithDefaults(settings);
  const lists = {};
  for (const c of choices) if (c.list && c.choice) (lists[String(c.list).trim()] ||= []).push(String(c.choice).trim());
  return {
    businessName: s.business_name,
    eventTypes: list(s.event_types),
    paymentMethods: list(s.payment_methods),
    cardMethod: s.card_fee_method.trim(),
    cardFeePct: num(s.card_fee_pct),
    terms: s.terms,
    products: products.filter((p) => p.product && p.size).map((p) => ({
      product: String(p.product).trim(), size: String(p.size).trim(),
      choice1: String(p.choice1 || '').trim(), choice2: String(p.choice2 || '').trim()
    })),
    lists
  };
}

// ───────── validation ─────────
/** Returns a cleaned order or throws Error with a customer-friendly message. */
export function cleanOrder(f) {
  if (!f || typeof f !== 'object') throw new Error('Empty form.');
  const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);
  const o = {
    name: str(f.name, 120), email: str(f.email, 200), phone: str(f.phone, 40),
    eventType: str(f.eventType, 80), eventDate: str(f.eventDate, 10), fulfillment: str(f.fulfillment, 20),
    time: str(f.time, 5), address: str(f.address, 300), allergies: str(f.allergies, 500), notes: str(f.notes, 3000),
    paymentMethod: str(f.paymentMethod, 60), initials: str(f.initials, 6), agreed: f.agreed === true,
    signature: String(f.signature || '')
  };
  const miss = [];
  if (!o.name) miss.push('name');
  if (!/^\S+@\S+\.\S+$/.test(o.email)) miss.push('a valid email');
  if (o.phone.replace(/\D/g, '').length < 7) miss.push('phone');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(o.eventDate)) miss.push('date');
  if (!o.fulfillment) miss.push('pickup or delivery');
  if (o.fulfillment === 'Delivery' && !o.address) miss.push('delivery address');
  if (!o.paymentMethod) miss.push('payment method');
  if (!o.initials) miss.push('initials');
  if (miss.length) throw new Error('Please fill in: ' + miss.join(', ') + '.');
  if (!o.agreed) throw new Error('You must agree to the terms and conditions.');
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(o.signature) || o.signature.length < 200) throw new Error('Please sign the form.');
  if (o.signature.length > 600000) throw new Error('Signature image is too large.');
  if (o.time && !/^\d{2}:\d{2}$/.test(o.time)) o.time = '';
  const items = Array.isArray(f.items) ? f.items.slice(0, 30) : [];
  o.items = items.map((it) => ({
    product: str(it.product, 80), size: str(it.size, 80), choice1: str(it.choice1, 80), choice2: str(it.choice2, 80),
    qty: Math.min(999, Math.max(1, Math.round(num(it.qty) || 1))), notes: str(it.notes, 2000)
  })).filter((it) => it.product && it.size);
  if (!o.items.length) throw new Error('Please add at least one item.');
  return o;
}

// ───────── pricing ─────────
export function priceOrder(items, products, paymentMethod, settings) {
  const s = settingsWithDefaults(settings);
  const lines = items.map((it) => {
    const p = products.find((x) => norm(x.product) === norm(it.product) && norm(x.size) === norm(it.size));
    const unit = p ? num(p.price) : 0;
    return { item: it, unitPrice: unit, amount: r2(unit * it.qty) };
  });
  const subtotal = r2(lines.reduce((a, l) => a + l.amount, 0));
  const isCard = !!s.card_fee_method && norm(paymentMethod) === norm(s.card_fee_method);
  const pct = isCard ? num(s.card_fee_pct) : 0;
  const fee = r2(subtotal * pct / 100);
  return { lines, subtotal, fee, feePct: pct, total: r2(subtotal + fee) };
}

// ───────── ingredients & inventory ─────────
/**
 * For each item, adds recipe rows for the product itself and each chosen option, at that size
 * (rows with a blank size apply to all sizes), times quantity.
 */
export function computeNeeds(items, recipes) {
  const index = {};
  for (const r of recipes) {
    if (!r.recipe || !r.ingredient) continue;
    const key = norm(r.recipe) + '|' + (norm(r.size) || '*');
    (index[key] ||= []).push(r);
  }
  const needs = {};
  const missing = [];
  for (const it of items) {
    const parts = [it.product, it.choice1, it.choice2].filter((x) => x && String(x).trim());
    parts.forEach((name, i) => {
      const rows = (index[norm(name) + '|' + norm(it.size)] || []).concat(index[norm(name) + '|*'] || []);
      if (!rows.length && i > 0) missing.push(`${name} (${it.size})`);
      for (const r of rows) {
        const ing = String(r.ingredient).trim();
        needs[ing] = r3((needs[ing] || 0) + num(r.amount) * (it.qty || 1));
      }
    });
  }
  return { needs, missing };
}

/** openOrders: [{items:[...]}]. Returns rows with reserved/left plus problems. */
export function inventoryStatus(inventory, openOrders, recipes) {
  const reserved = {};
  const missing = new Set();
  for (const o of openOrders) {
    const r = computeNeeds(o.items || [], recipes);
    for (const [k, v] of Object.entries(r.needs)) reserved[norm(k)] = r3((reserved[norm(k)] || 0) + v);
    r.missing.forEach((m) => missing.add(m));
  }
  const known = new Set();
  const rows = inventory.filter((i) => i.ingredient).map((i) => {
    known.add(norm(i.ingredient));
    const onHand = num(i.on_hand);
    const res = reserved[norm(i.ingredient)] || 0;
    const left = r3(onHand - res);
    const keep = num(i.keep_at_least);
    return { ingredient: i.ingredient, unit: i.unit || '', onHand, keepAtLeast: keep, reserved: res, left,
      state: left < 0 ? 'short' : (keep && left < keep ? 'low' : 'ok') };
  });
  const unknownIngredients = Object.keys(reserved).filter((k) => !known.has(k));
  return { rows, missingRecipes: [...missing], unknownIngredients };
}

export function shoppingList(rows) {
  return rows.map((r) => {
    const buy = r3(Math.max(r.keepAtLeast || 0, 0) - r.left);
    return buy > 0 ? { ingredient: r.ingredient, unit: r.unit, buy, left: r.left } : null;
  }).filter(Boolean);
}

export function shortagesForOrder(items, status, recipes) {
  const used = computeNeeds(items, recipes);
  const byName = Object.fromEntries(status.rows.map((r) => [norm(r.ingredient), r]));
  const out = { short: [], low: [], missingRecipes: used.missing, unknownIngredients: [] };
  for (const ing of Object.keys(used.needs)) {
    const r = byName[norm(ing)];
    if (!r) out.unknownIngredients.push(ing);
    else if (r.state === 'short') out.short.push(r);
    else if (r.state === 'low') out.low.push(r);
  }
  return out;
}

/** Ingredient amounts to subtract when an order is marked Done. */
export function deductions(items, recipes) { return computeNeeds(items, recipes).needs; }

// ───────── text summaries ─────────
export const itemLabel = (it) => `${it.qty} × ${it.size} ${it.product}` +
  (it.choice1 || it.choice2 ? ' – ' + [it.choice1, it.choice2].filter(Boolean).join(' / ') : '');
export const itemsSummary = (items) => items.map((it) => '• ' + itemLabel(it) + (it.notes ? ` (${it.notes})` : '')).join('\n');
export const shortItems = (items) => items.map((it) => (it.qty > 1 ? it.qty + '× ' : '') + it.size + ' ' + it.product).join(', ');

/** order: row shape {id, name, email, phone, event_type, event_date, time, fulfillment, address, items, allergies, notes, payment_method, subtotal, fee, total} */
export function orderHtml(o, { forCustomer = false } = {}) {
  const row = (k, v) => v ? `<tr><td style="color:#666;padding:3px 12px 3px 0;vertical-align:top">${esc(k)}</td><td style="padding:3px 0"><b>${esc(v)}</b></td></tr>` : '';
  const items = '<ol style="margin:4px 0 0 18px;padding:0">' + o.items.map((it) =>
    `<li style="margin-bottom:6px"><b>${esc(itemLabel(it))}</b>${it.notes ? `<br><span style="color:#555">${esc(it.notes)}</span>` : ''}</li>`).join('') + '</ol>';
  const pay = forCustomer ? '' : row('Starting price', money(o.subtotal)) + (o.fee ? row('Card fee', money(o.fee)) : '') + row('Total', money(o.total));
  return `<h3 style="margin:0 0 6px">Order #${orderNo(o.id)} – ${esc(o.name)}</h3><table style="font-size:14px">` +
    row('Event', [o.event_type, displayDate(o.event_date), displayTime(o.time)].filter(Boolean).join(' · ')) +
    row(o.fulfillment === 'Delivery' ? 'Deliver to' : 'Pickup / delivery', o.fulfillment === 'Delivery' ? o.address : (o.fulfillment || 'Pickup')) + row('Phone', o.phone) + row('Email', o.email) + row('Payment', o.payment_method) + pay +
    row('Allergies', o.allergies) + row('Notes', o.notes) + `</table><div style="margin-top:8px"><b>Items</b>${items}</div>`;
}

export function shortageHtml(sh) {
  if (!sh) return '';
  let h = '';
  if (sh.short.length) h += `<div style="background:#fde8e8;border:1px solid #e0a0a0;padding:12px;border-radius:8px;margin-bottom:14px"><b>⚠️ You don't have enough for all your open orders. Buy:</b><ul>` +
    sh.short.map((r) => `<li><b>${r2(-r.left)} ${esc(r.unit)}</b> ${esc(r.ingredient)}</li>`).join('') + '</ul></div>';
  if (sh.low.length) h += '<p>🔸 Running low: ' + sh.low.map((r) => `${esc(r.ingredient)} (${r2(r.left)} ${esc(r.unit)} left)`).join(', ') + '</p>';
  if (sh.missingRecipes.length || sh.unknownIngredients.length) h += `<p style="color:#8a5a00">ℹ️ Couldn't count everything: ` +
    (sh.missingRecipes.length ? 'no recipe for ' + esc(sh.missingRecipes.join(', ')) + '. ' : '') +
    (sh.unknownIngredients.length ? 'Not on inventory: ' + esc(sh.unknownIngredients.join(', ')) + '.' : '') + '</p>';
  return h;
}

export function ownerEmail(o, { shortages, links = {}, problems = [] }) {
  const linkHtml = Object.entries(links).filter(([, u]) => u).map(([k, u]) => `<a href="${esc(u)}">${esc(k)}</a>`).join(' · ');
  return {
    subject: (shortages && shortages.short.length ? '⚠️ SHORT ON INGREDIENTS – ' : '') + `New order #${orderNo(o.id)}: ${o.name} – ${displayDate(o.event_date)}`,
    html: shortageHtml(shortages) + (linkHtml ? `<p>${linkHtml}</p>` : '') + orderHtml(o) +
      (problems.length ? `<p style="color:#b00"><b>Needs your attention:</b><br>${problems.map(esc).join('<br>')}</p>` : '')
  };
}

export function customerEmail(o, settings) {
  const s = settingsWithDefaults(settings);
  return {
    subject: `${s.business_name} – we received your order form (#${orderNo(o.id)})`,
    html: `<p>Hi ${esc(o.name.split(' ')[0])},</p><p>Thank you! We received your order form. We'll review it and send your invoice shortly.</p>` +
      orderHtml(o, { forCustomer: true }) + signedBlockHtml(o) + `<p>– ${esc(s.business_name)}</p>`
  };
}

/** Terms snapshot + initials + signature, for the signed copy and the customer email. */
export function signedBlockHtml(o) {
  return `<h3>Terms &amp; Conditions agreed to</h3><div style="white-space:pre-wrap;font-size:12px;border:1px solid #ddd;padding:10px;border-radius:6px">${esc(o.terms_text)}</div>` +
    `<p><b>I agree:</b> ✔ &nbsp; <b>Initials:</b> ${esc(o.initials)} &nbsp; <b>Signed:</b> ${esc(o.terms_accepted_at)}</p>` +
    (o.signature ? `<p><b>Signature:</b><br><img alt="signature" src="${o.signature}" style="height:90px;border-bottom:1px solid #999"></p>` : '');
}

export function weeklyEmail(status, weekOrders) {
  const list = shoppingList(status.rows);
  let h = '<h2>🛒 Shopping list</h2>' + (list.length
    ? '<table cellpadding="6" style="border-collapse:collapse">' + list.map((r) => `<tr><td>☐</td><td><b>${r.buy} ${esc(r.unit)}</b></td><td>${esc(r.ingredient)}</td></tr>`).join('') + '</table>'
    : '<p>Nothing to buy – you have enough for all open orders. 🎉</p>');
  h += `<h2>📅 This week's orders (${weekOrders.length})</h2>` + (weekOrders.length ? '<ul>' + weekOrders.map((o) =>
    `<li><b>${esc(displayDate(o.event_date))}${o.time ? ' ' + esc(displayTime(o.time)) : ''}</b> – ${esc(o.name)} (${esc(o.status)}): ${esc(shortItems(o.items))}</li>`).join('') + '</ul>' : '<p>No orders this week.</p>');
  h += '<h2>📦 Inventory</h2><table cellpadding="4" style="border-collapse:collapse;font-size:13px"><tr style="background:#f3f3f3"><th align="left">Ingredient</th><th>Have</th><th>For orders</th><th>Left after</th></tr>' +
    status.rows.map((r) => `<tr><td>${esc(r.ingredient)}</td><td align="center">${r.onHand} ${esc(r.unit)}</td><td align="center">${r.reserved}</td><td align="center" style="color:${r.state === 'short' ? '#c00' : r.state === 'low' ? '#b36b00' : '#222'}"><b>${r.left}</b></td></tr>`).join('') + '</table>';
  if (status.missingRecipes.length) h += `<p style="color:#8a5a00">ℹ️ No recipe on file for: ${esc(status.missingRecipes.join(', '))}</p>`;
  if (status.unknownIngredients.length) h += `<p style="color:#8a5a00">ℹ️ Not on inventory: ${esc(status.unknownIngredients.join(', '))}</p>`;
  return { subject: '🛒 Weekly shopping list & orders', html: h };
}

// ───────── Square ─────────
export function squareOrderBody(o, pricing, locationId, customerId, settings, uuid) {
  const s = settingsWithDefaults(settings);
  const body = {
    idempotency_key: uuid,
    order: {
      location_id: locationId, customer_id: customerId, reference_id: String(orderNo(o.id)),
      line_items: pricing.lines.map((l) => {
        const it = l.item;
        const li = { name: `${it.size} ${it.product}` + (it.choice1 || it.choice2 ? ' – ' + [it.choice1, it.choice2].filter(Boolean).join(' / ') : ''),
          quantity: String(it.qty), base_price_money: { amount: Math.round(l.unitPrice * 100), currency: s.currency } };
        if (it.notes) li.note = it.notes.slice(0, 2000);
        return li;
      })
    }
  };
  if (pricing.fee > 0) body.order.service_charges = [{ name: `Credit card fee (${pricing.feePct}%)`, percentage: String(pricing.feePct), calculation_phase: 'SUBTOTAL_PHASE' }];
  return body;
}

export function squareInvoiceBody(o, locationId, customerId, squareOrderId, settings, uuid) {
  const s = settingsWithDefaults(settings);
  const today = todayIn(s.timezone);
  let due = addDays(o.event_date, -num(s.invoice_due_days));
  if (due < today) due = today;
  return {
    idempotency_key: uuid,
    invoice: {
      location_id: locationId, order_id: squareOrderId, primary_recipient: { customer_id: customerId },
      payment_requests: [{ request_type: 'BALANCE', due_date: due }], delivery_method: 'EMAIL',
      accepted_payment_methods: { card: true, square_gift_card: false, bank_account: false, buy_now_pay_later: false, cash_app_pay: false },
      invoice_number: String(orderNo(o.id)),
      title: (o.event_type ? o.event_type + ' – ' : '') + 'Order #' + orderNo(o.id),
      description: `Event date: ${displayDate(o.event_date)}${o.time ? ' ' + displayTime(o.time) : ''} (${o.fulfillment})\nPayment method chosen: ${o.payment_method}`
    }
  };
}

export function squareCustomerBody(o, uuid) {
  const parts = o.name.trim().split(/\s+/);
  const body = { idempotency_key: uuid, given_name: parts[0], family_name: parts.slice(1).join(' '), email_address: o.email };
  const d = o.phone.replace(/\D/g, '');
  if (d.length === 10) body.phone_number = '+1' + d;
  else if (d.length === 11 && d[0] === '1') body.phone_number = '+' + d;
  return body;
}

// ───────── Calendar (.ics) ─────────
const icsEsc = (v) => String(v ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const fold = (line) => { const out = []; while (line.length > 74) { out.push(line.slice(0, 74)); line = ' ' + line.slice(74); } out.push(line); return out.join('\r\n'); };

/** One calendar with an event per order (floating local times = your own time zone). */
export function buildIcs(orders, settings, { method } = {}) {
  const s = settingsWithDefaults(settings);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Order System//EN', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${icsEsc(s.business_name)} Orders`, 'X-PUBLISHED-TTL:PT1H'];
  if (method) lines.push('METHOD:' + method);
  for (const o of orders) {
    const d = o.event_date.replace(/-/g, '');
    const pre = o.status === 'Cancelled' ? '❌ CANCELLED – ' : o.status === 'New' ? '⏳ ' : o.status === 'Done' ? '✅ ' : '';
    lines.push('BEGIN:VEVENT', `UID:order-${o.id}@orders`, `DTSTAMP:${stamp}`);
    if (o.time) {
      const [h, m] = o.time.split(':').map(Number);
      const end = h * 60 + m + 30;
      lines.push(`DTSTART:${d}T${o.time.replace(':', '')}00`, `DTEND:${d}T${String(Math.floor(end / 60) % 24).padStart(2, '0')}${String(end % 60).padStart(2, '0')}00`);
    } else {
      lines.push(`DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${addDays(o.event_date, 1).replace(/-/g, '')}`);
    }
    lines.push(`SUMMARY:${icsEsc(pre + (o.fulfillment || 'Pickup') + ': ' + o.name + ' – ' + shortItems(o.items))}`,
      `DESCRIPTION:${icsEsc(`Order #${orderNo(o.id)} (${o.status})\n${o.name} · ${o.phone} · ${o.email}\nPayment: ${o.payment_method}\n\n${itemsSummary(o.items)}${o.allergies ? '\n\nALLERGIES: ' + o.allergies : ''}${o.notes ? '\n\nNotes: ' + o.notes : ''}`)}`);
    if (o.address) lines.push(`LOCATION:${icsEsc(o.address)}`);
    if (o.status === 'Cancelled') lines.push('STATUS:CANCELLED');
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

// ───────── Sample data (first run) ─────────
export function sampleData() {
  const products = [
    ['Cake', '6" round', 85, 'Cake Flavor', 'Filling'], ['Cake', '8" round', 120, 'Cake Flavor', 'Filling'], ['Cake', '10" round', 165, 'Cake Flavor', 'Filling'],
    ['Cookies', '1 dozen', 48, 'Cookie Flavor', ''], ['Cake Pops', '1 dozen', 42, 'Cake Flavor', 'Coating'],
    ['Rice Krispie Pops', '1 dozen', 40, '', 'Coating'], ['Dessert Cups', '1 dozen', 45, 'Cake Flavor', 'Filling']
  ].map(([product, size, price, choice1, choice2]) => ({ product, size, price, choice1, choice2 }));
  const choices = [
    ['Cake Flavor', 'Vanilla'], ['Cake Flavor', 'Chocolate'], ['Cake Flavor', 'Red Velvet'], ['Cake Flavor', 'Funfetti'],
    ['Filling', 'Vanilla Buttercream'], ['Filling', 'Chocolate Ganache'], ['Filling', 'Raspberry'], ['Filling', 'Cookies & Cream'],
    ['Cookie Flavor', 'Vanilla Sugar Cookie'], ['Cookie Flavor', 'Chocolate Sugar Cookie'], ['Coating', 'White Chocolate'], ['Coating', 'Milk Chocolate']
  ].map(([l, choice]) => ({ list: l, choice }));
  const inventory = [
    ['Flour', 'cups', 40, 10], ['Sugar', 'cups', 30, 8], ['Eggs', 'each', 36, 12], ['Butter', 'sticks', 24, 8], ['Milk', 'cups', 12, 4],
    ['Cocoa powder', 'cups', 6, 2], ['Powdered sugar', 'cups', 30, 10], ['Heavy cream', 'cups', 8, 2], ['Chocolate chips', 'cups', 10, 3],
    ['Raspberry jam', 'cups', 4, 1], ['Oreo cookies', 'packs', 2, 1], ['Red food coloring', 'oz', 4, 1], ['Sprinkles', 'cups', 3, 1],
    ['Candy melts', 'lbs', 6, 2], ['Rice Krispies cereal', 'cups', 24, 6], ['Marshmallows', 'bags', 4, 2], ['Lollipop sticks', 'each', 150, 50],
    ['Treat bags', 'each', 150, 50], ['Cake boards', 'each', 10, 4], ['Cake boxes', 'each', 10, 4]
  ].map(([ingredient, unit, on_hand, keep_at_least]) => ({ ingredient, unit, on_hand, keep_at_least }));
  const sizes = { '6" round': 0.6, '8" round': 1, '10" round': 1.6 };
  const cakes = {
    Vanilla: [['Flour', 2.5], ['Sugar', 2], ['Eggs', 4], ['Butter', 2], ['Milk', 1]],
    Chocolate: [['Flour', 2], ['Sugar', 2], ['Eggs', 3], ['Cocoa powder', 0.75], ['Milk', 1], ['Butter', 1]],
    'Red Velvet': [['Flour', 2.5], ['Sugar', 2], ['Eggs', 3], ['Cocoa powder', 0.25], ['Red food coloring', 1], ['Butter', 2]],
    Funfetti: [['Flour', 2.5], ['Sugar', 2], ['Eggs', 4], ['Butter', 2], ['Milk', 1], ['Sprinkles', 0.5]]
  };
  const fillings = {
    'Vanilla Buttercream': [['Butter', 2], ['Powdered sugar', 4]], 'Chocolate Ganache': [['Chocolate chips', 1.5], ['Heavy cream', 1]],
    Raspberry: [['Raspberry jam', 0.75]], 'Cookies & Cream': [['Butter', 2], ['Powdered sugar', 3], ['Oreo cookies', 0.5]]
  };
  const R = [];
  const add = (recipe, size, ingredient, amount, notes = '') => R.push({ recipe, size, ingredient, amount: r2(amount), notes });
  for (const [size, m] of Object.entries(sizes)) {
    add('Cake', size, 'Cake boards', 1, 'Every cake'); add('Cake', size, 'Cake boxes', 1, 'Every cake');
    add('Cake', size, 'Butter', 4 * m, 'Outside buttercream'); add('Cake', size, 'Powdered sugar', 8 * m, 'Outside buttercream');
    for (const g of [cakes, fillings]) for (const [name, ings] of Object.entries(g)) for (const [i, a] of ings) add(name, size, i, a * m);
  }
  const dz = '1 dozen';
  add('Cookies', dz, 'Treat bags', 12);
  for (const [n, extra] of [['Vanilla Sugar Cookie', []], ['Chocolate Sugar Cookie', [['Cocoa powder', 0.5]]]]) {
    for (const [i, a] of [['Flour', n.startsWith('Choc') ? 2.5 : 3], ['Sugar', 1], ['Butter', 2], ['Eggs', 1], ...extra]) add(n, dz, i, a);
    add(n, dz, 'Powdered sugar', 2, 'Royal icing');
  }
  add('Cake Pops', dz, 'Lollipop sticks', 12); add('Cake Pops', dz, 'Treat bags', 12);
  for (const [i, a] of [['Rice Krispies cereal', 6], ['Marshmallows', 1], ['Butter', 1], ['Lollipop sticks', 12], ['Treat bags', 12]]) add('Rice Krispie Pops', dz, i, a);
  add('White Chocolate', dz, 'Candy melts', 0.75, 'Coating'); add('Milk Chocolate', dz, 'Candy melts', 0.75, 'Coating');
  for (const [name, ings] of Object.entries(cakes)) for (const [i, a] of ings) add(name, dz, i, a * 0.4, 'Cake pops / dessert cups');
  for (const [name, ings] of Object.entries(fillings)) for (const [i, a] of ings) add(name, dz, i, a * 0.5, 'Dessert cups');
  return { products, choices, inventory, recipes: R };
}
