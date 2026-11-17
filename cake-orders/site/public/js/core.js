// Shared business logic for the order system.
// Used by: the Cloudflare Worker (server) and the in-browser demo.
// Pure functions only — no network, no storage.

// Draft = link prepared and sent, customer hasn't submitted yet.
export const STATUSES = ['Draft', 'New', 'Confirmed', 'Baked', 'Decorated', 'Done', 'Cancelled'];
/** Orders whose ingredients are reserved (submitted, not finished). */
export const OPEN_STATUSES = ['New', 'Confirmed', 'Baked', 'Decorated'];
export const PAYMENT_STATUSES = ['Unpaid', 'Deposit paid', 'Paid'];

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
  send_customer_copy: ['Yes', 'Email the customer', 'Yes = customer gets "received, pending review" and "confirmed" emails'],
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
  products: ['product', 'size', 'price', 'choice1', 'choice2', 'tiered', 'addon'],
  choices: ['list', 'choice'],
  zones: ['zone', 'fee', 'zips'],
  inventory: ['ingredient', 'unit', 'on_hand', 'keep_at_least'],
  recipes: ['recipe', 'size', 'ingredient', 'amount', 'notes']
};
export const NUMERIC = { price: 1, on_hand: 1, keep_at_least: 1, amount: 1, fee: 1 };

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
export function formConfig(settings, products, choices, zones = []) {
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
      choice1: String(p.choice1 || '').trim(), choice2: String(p.choice2 || '').trim(),
      tiered: yes(p.tiered), addon: yes(p.addon), price: num(p.price)
    })),
    zones: zones.filter((z) => z.zone).map((z) => ({ zone: String(z.zone).trim(), fee: num(z.fee), zips: String(z.zips || '') })),
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
    time: str(f.time, 5), address: str(f.address, 300), zip: str(f.zip, 10), zone: str(f.zone, 80),
    allergies: str(f.allergies, 500), notes: str(f.notes, 3000),
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
  // Items from a prepared link only carry a ref (+ the customer's choices); the server fills in the rest.
  o.items = items.map((it) => cleanItem(it)).filter((it) => it.ref || (it.product && (it.size || it.tiers)));
  if (!o.items.length) throw new Error('Please add at least one item.');
  return o;
}

const str_ = (v, max = 500) => String(v ?? '').trim().slice(0, max);
/** One order line. A tiered cake has tiers: [{size, choice1, choice2}] and no single size. */
export function cleanItem(it) {
  const out = {
    product: str_(it && it.product, 80), size: str_(it && it.size, 80),
    choice1: str_(it && it.choice1, 80), choice2: str_(it && it.choice2, 80),
    qty: Math.min(999, Math.max(1, Math.round(num(it && it.qty) || 1))),
    notes: str_(it && it.notes, 2000), customerNotes: str_(it && it.customerNotes, 1000),
    ref: str_(it && it.ref, 20)
  };
  if (it && it.price !== undefined && it.price !== null && it.price !== '') out.price = r2(num(it.price));
  if (it && Array.isArray(it.tiers) && it.tiers.length) {
    out.tiers = it.tiers.slice(0, 12).map((t) => ({ size: str_(t && t.size, 80), choice1: str_(t && t.choice1, 80), choice2: str_(t && t.choice2, 80) }));
    out.size = '';
  }
  if (it && it.added) out.added = true;
  return out;
}

// ───────── delivery zones ─────────
/** "10001-10282, 10451" → [[10001,10282],[10451,10451]] */
export function parseZips(text) {
  return String(text || '').split(/[,\s]+/).map((p) => p.trim()).filter(Boolean).map((p) => {
    const m = p.match(/^(\d{5})(?:-(\d{5}))?$/);
    return m ? [+m[1], +(m[2] || m[1])] : null;
  }).filter(Boolean);
}
export function matchZone(zip, zones) {
  const z = String(zip || '').match(/\d{5}/);
  if (!z) return null;
  const n = +z[0];
  return zones.find((zone) => parseZips(zone.zips).some(([a, b]) => n >= a && n <= b)) || null;
}

// ───────── pricing ─────────
/** Line price = the price you agreed (item.price), or the menu's minimum price for items the customer added. */
export function priceOrder(items, products, paymentMethod, settings, deliveryFee = 0) {
  const s = settingsWithDefaults(settings);
  const lines = items.map((it) => {
    let unit = it.price;
    if (unit === undefined) {
      const p = products.find((x) => norm(x.product) === norm(it.product) && norm(x.size) === norm(it.size));
      unit = p ? num(p.price) : 0;
    }
    return { item: it, unitPrice: unit, amount: r2(unit * it.qty) };
  });
  const subtotal = r2(lines.reduce((a, l) => a + l.amount, 0));
  const delivery = r2(num(deliveryFee));
  const isCard = !!s.card_fee_method && norm(paymentMethod) === norm(s.card_fee_method);
  const pct = isCard ? num(s.card_fee_pct) : 0;
  const fee = r2((subtotal + delivery) * pct / 100);
  return { lines, subtotal, delivery, fee, feePct: pct, total: r2(subtotal + delivery + fee) };
}

/** Which choice lists an item needs (e.g. ["Cake Flavor", "Filling"]), from the menu. */
export function choiceLists(products, product, size) {
  const p = products.find((x) => norm(x.product) === norm(product) && (!size || norm(x.size) === norm(size))) ||
    products.find((x) => norm(x.product) === norm(product));
  return p ? [String(p.choice1 || '').trim(), String(p.choice2 || '').trim()] : ['', ''];
}
export const isTiered = (products, product) => products.some((p) => norm(p.product) === norm(product) && yes(p.tiered));

/**
 * Combine what you prepared (locked) with what the customer submitted.
 * - Prepared items keep their product, sizes/tiers and price. Flavors you left open come from the customer.
 * - Quantity can change on non-tiered items (cookies, pops…); a change is flagged.
 * - Extra items the customer added get the menu's minimum price and are flagged.
 * Returns { items, changes[] } or throws a customer-facing Error.
 */
export function mergeCustomerItems(prepared, submitted, products) {
  const changes = [];
  const items = [];
  const byRef = Object.fromEntries((submitted || []).filter((s) => s.ref).map((s) => [s.ref, s]));
  prepared.forEach((p, i) => {
    const sub = byRef[p.ref || 'p' + i] || {};
    const it = JSON.parse(JSON.stringify(p));
    delete it.added;
    if (it.tiers) {
      it.tiers.forEach((t, k) => {
        const st = (sub.tiers || [])[k] || {};
        if (!t.choice1) t.choice1 = st.choice1 || '';
        if (!t.choice2) t.choice2 = st.choice2 || '';
      });
    } else {
      if (!it.choice1) it.choice1 = sub.choice1 || '';
      if (!it.choice2) it.choice2 = sub.choice2 || '';
      if (sub.qty && sub.qty !== it.qty) {
        changes.push(`Changed quantity of ${it.size} ${it.product} from ${it.qty} to ${sub.qty}`);
        it.qty = sub.qty;
      }
    }
    if (sub.customerNotes) { it.customerNotes = sub.customerNotes; changes.push(`Note on ${itemName(it)}: "${sub.customerNotes}"`); }
    items.push(it);
  });
  for (const s of submitted || []) {
    if (s.ref && prepared.some((p, i) => (p.ref || 'p' + i) === s.ref)) continue;
    const menu = products.find((x) => norm(x.product) === norm(s.product) && norm(x.size) === norm(s.size));
    if (!menu || !yes(menu.addon) || yes(menu.tiered)) throw Object.assign(new Error(`"${s.size} ${s.product}" can't be added on this form. Please contact us about it.`), { userFacing: true });
    const it = cleanItem({ ...s, tiers: undefined, ref: '', price: num(menu.price), added: true });
    items.push(it);
    changes.push(`Added: ${itemLabel(it)} (minimum price ${money(num(menu.price))} each)`);
  }
  return { items, changes };
}

/** Every item (and every tier) has the flavors its menu row asks for. Returns the first problem or ''. */
export function missingChoices(items, products) {
  for (const [i, it] of items.entries()) {
    const parts = it.tiers ? it.tiers.map((t, k) => ({ ...t, label: `tier ${k + 1} of item ${i + 1}` })) : [{ ...it, label: `item ${i + 1}` }];
    for (const part of parts) {
      const [l1, l2] = choiceLists(products, it.product, part.size);
      if (l1 && !part.choice1) return `Please choose the ${l1.toLowerCase()} for ${part.label}.`;
      if (l2 && !part.choice2) return `Please choose the ${l2.toLowerCase()} for ${part.label}.`;
    }
  }
  return '';
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
  for (const whole of items) {
   for (const it of expandTiers(whole)) {
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
  }
  return { needs, missing };
}

/** A tiered cake counts as one cake per tier (each with its own size and flavors). */
export function expandTiers(it) {
  return it.tiers ? it.tiers.map((t) => ({ product: it.product, size: t.size, choice1: t.choice1, choice2: t.choice2, qty: it.qty || 1 })) : [it];
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
const flav = (x) => [x.choice1, x.choice2].filter(Boolean).join(' / ');
export const itemName = (it) => it.tiers ? `${it.tiers.length}-tier ${it.product}` : `${it.size} ${it.product}`;
export const itemLabel = (it) => it.tiers
  ? `${it.qty} × ${it.tiers.length}-tier ${it.product} (` + it.tiers.map((t) => t.size + (flav(t) ? ' ' + flav(t) : '')).join(' · ') + ')'
  : `${it.qty} × ${it.size} ${it.product}` + (flav(it) ? ' – ' + flav(it) : '');
export const itemsSummary = (items) => items.map((it) => '• ' + itemLabel(it) + (it.notes ? ` (${it.notes})` : '') + (it.customerNotes ? ` [customer: ${it.customerNotes}]` : '')).join('\n');
export const shortItems = (items) => items.map((it) => (it.qty > 1 ? it.qty + '× ' : '') + itemName(it)).join(', ');

/** order: row shape {id, name, email, phone, event_type, event_date, time, fulfillment, address, items, allergies, notes, payment_method, subtotal, fee, total} */
export function orderHtml(o, { forCustomer = false } = {}) {
  const row = (k, v) => v ? `<tr><td style="color:#666;padding:3px 12px 3px 0;vertical-align:top">${esc(k)}</td><td style="padding:3px 0"><b>${esc(v)}</b></td></tr>` : '';
  const items = '<ol style="margin:4px 0 0 18px;padding:0">' + o.items.map((it) =>
    `<li style="margin-bottom:6px"><b>${esc(itemLabel(it))}</b>${it.added ? ' <i style="color:#8a5a00">(added by customer)</i>' : ''}` +
    (it.notes ? `<br><span style="color:#555">${esc(it.notes)}</span>` : '') +
    (it.customerNotes ? `<br><span style="color:#8a5a00">Customer note: ${esc(it.customerNotes)}</span>` : '') + '</li>').join('') + '</ol>';
  const pay = row('Items', money(o.subtotal)) + (o.delivery_fee ? row('Delivery' + (o.delivery_zone ? ' (' + o.delivery_zone + ')' : ''), money(o.delivery_fee)) : '') +
    (o.fee ? row('Card fee', money(o.fee)) : '') + row(forCustomer ? 'Total' : 'Total', money(o.total));
  return `<h3 style="margin:0 0 6px">Order #${orderNo(o.id)} – ${esc(o.name)}</h3><table style="font-size:14px">` +
    row('Event', [o.event_type, displayDate(o.event_date), displayTime(o.time)].filter(Boolean).join(' · ')) +
    row(o.fulfillment === 'Delivery' ? 'Deliver to' : 'Pickup / delivery', o.fulfillment === 'Delivery' ? o.address : (o.fulfillment || 'Pickup')) + row('Phone', o.phone) + row('Email', o.email) + row('Payment', o.payment_method) + pay +
    row('Allergies', o.allergies) + row('Notes', o.notes) + `</table>` +
    (o.design_summary ? `<div style="margin-top:8px"><b>Design</b><div style="white-space:pre-wrap">${esc(o.design_summary)}</div></div>` : '') +
    `<div style="margin-top:8px"><b>Items</b>${items}</div>`;
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
    html: shortageHtml(shortages) + changesHtml(o.changes) + (linkHtml ? `<p>${linkHtml}</p>` : '') + orderHtml(o) +
      (problems.length ? `<p style="color:#b00"><b>Needs your attention:</b><br>${problems.map(esc).join('<br>')}</p>` : '')
  };
}

export function changesHtml(changes) {
  return changes && changes.length ? `<div style="background:#fff4dc;border:1px solid #e8c77a;padding:12px;border-radius:8px;margin-bottom:14px"><b>✋ The customer changed or added something – review before confirming:</b><ul>` +
    changes.map((c) => `<li>${esc(c)}</li>`).join('') + '</ul></div>' : '';
}

/** kind: 'received' (on submit) or 'confirmed' (when you confirm). */
export function customerEmail(o, settings, kind = 'received') {
  const s = settingsWithDefaults(settings);
  const first = esc(o.name.split(' ')[0]);
  if (kind === 'confirmed') return {
    subject: `${s.business_name} – your order is confirmed (#${orderNo(o.id)})`,
    html: `<p>Hi ${first},</p><p>Good news – your order is <b>confirmed</b>. Here are the details for your records.</p>` +
      orderHtml(o, { forCustomer: true }) + `<p>– ${esc(s.business_name)}</p>`
  };
  return {
    subject: `${s.business_name} – order received, pending final review (#${orderNo(o.id)})`,
    html: `<p>Hi ${first},</p><p>Thank you! We received your order. It is <b>pending our final review</b>` +
      (o.changes && o.changes.length ? ' (we\'ll look over the changes you made)' : '') +
      ` and payment. We'll email you again once it's confirmed.</p>` +
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
        if (it.tiers) li.name = itemLabel({ ...it, qty: 1 }).replace(/^1 × /, '');
        return li;
      })
    }
  };
  if (pricing.delivery > 0) body.order.line_items.push({ name: 'Delivery' + (o.delivery_zone ? ' – ' + o.delivery_zone : ''), quantity: '1',
    base_price_money: { amount: Math.round(pricing.delivery * 100), currency: s.currency } });
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
  // price = minimum price, used only when a customer adds the item themselves. Prepared orders use the price you set.
  const products = [
    ['Cake', '6" round', 85, 'Cake Flavor', 'Filling', 'yes', ''], ['Cake', '8" round', 120, 'Cake Flavor', 'Filling', 'yes', ''],
    ['Cake', '10" round', 165, 'Cake Flavor', 'Filling', 'yes', ''],
    ['Cookies', '1 dozen', 48, 'Cookie Flavor', '', '', 'yes'], ['Cake Pops', '1 dozen', 72, 'Cake Flavor', 'Coating', '', 'yes'],
    ['Rice Krispie Pops', '1 dozen', 60, '', 'Coating', '', 'yes'], ['Dessert Cups', '1 dozen', 54, 'Cake Flavor', 'Filling', '', 'yes']
  ].map(([product, size, price, choice1, choice2, tiered, addon]) => ({ product, size, price, choice1, choice2, tiered, addon }));
  // SAMPLE zones and fees – replace with your own.
  const zones = [
    ['Brooklyn', 40, '11201-11256'], ['Manhattan', 85, '10001-10282'], ['Queens', 55, '11004-11109, 11351-11697'],
    ['Bronx', 60, '10451-10475'], ['Staten Island', 65, '10301-10314'], ['Long Island', 75, '11501-11980'], ['New Jersey', 90, '07001-08989']
  ].map(([zone, fee, zips]) => ({ zone, fee, zips }));
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
  return { products, choices, zones, inventory, recipes: R };
}
