// Request handlers shared by the Cloudflare Worker and the in-browser demo.
// The PHP version (godaddy/) implements the same routes and responses.
//
// handle(req, ctx) where
//   req = { method, path, query, body, adminKey }
//   ctx = {
//     db:  { getSettings, saveSettings, getTable, replaceTable, insertOrder, updateOrder, getOrder, listOrders, adjustInventory,
//            findOrderByToken, insertImage, getImage, insertFeedback, listFeedback, updateFeedback },
//     adminPassword,            // string; admin routes require req.adminKey === adminPassword
//     sendEmail?(to, subject, html, attachments?) // optional
//     squareToken?,             // optional
//     fetch?,                   // for Square
//     uuid(), nowIso(), publicUrl
//   }
import * as C from './core.js';

const ok = (data, status = 200) => ({ status, data });
const fail = (status, message) => ({ status, data: { error: message } });

export async function handle(req, ctx) {
  const { method, path } = req;
  try {
    let pm;
    if (method === 'GET' && path === '/config') return ok(await getConfig(ctx));
    if (method === 'POST' && path === '/orders') return ok(await submitOrder(req.body, ctx, req));
    if (method === 'GET' && (pm = path.match(/^\/order\/([A-Za-z0-9]{16,64})$/))) return await preparedOrder(pm[1], ctx);
    if (method === 'GET' && (pm = path.match(/^\/images\/([A-Za-z0-9]{16,64})$/))) {
      const data = await ctx.db.getImage(pm[1]);
      return data ? ok({ data }) : fail(404, 'Image not found');
    }
    if (method === 'GET' && path === '/calendar.ics') return await calendarFeed(req, ctx);

    if (path.startsWith('/admin/')) {
      if (!ctx.adminPassword) return fail(500, 'Admin password is not configured on the server.');
      if (!safeEqual(String(req.adminKey || ''), String(ctx.adminPassword))) return fail(401, 'Wrong password.');
      return await admin(req, ctx);
    }
    return fail(404, 'Not found');
  } catch (e) {
    if (e && e.userFacing) return fail(400, e.message);
    console.error(e);
    return fail(500, 'Server error: ' + (e && e.message || e));
  }
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function getConfig(ctx) {
  const [s, products, choices, zones] = await Promise.all([ctx.db.getSettings(), ctx.db.getTable('products'), ctx.db.getTable('choices'), ctx.db.getTable('zones')]);
  return C.formConfig(s, products, choices, zones);
}

// ───────── prepared order link (what the customer opens) ─────────
async function preparedOrder(token, ctx) {
  const o = await ctx.db.findOrderByToken(token);
  if (!o) return fail(404, 'This order link is not valid. Please contact us for a new one.');
  if (o.status !== 'Draft') return ok({ submitted: true, orderNo: C.orderNo(o.id), name: o.name });
  return ok({
    submitted: false, orderNo: C.orderNo(o.id),
    name: o.name, email: o.email, phone: o.phone, eventType: o.event_type, eventDate: o.event_date, time: o.time,
    fulfillment: o.fulfillment, designSummary: o.design_summary, images: o.images || [], items: o.prefill_items || []
  });
}

const userError = (msg) => Object.assign(new Error(msg), { userFacing: true });

// ───────── new order ─────────
async function submitOrder(body, ctx, req) {
  if (body && body.website) return { orderNo: 0 }; // honeypot: bots fill hidden fields
  let f;
  try { f = C.cleanOrder(body); } catch (e) { e.userFacing = true; throw e; }

  const [settings, products, recipes, zones] = await Promise.all([ctx.db.getSettings(), ctx.db.getTable('products'), ctx.db.getTable('recipes'), ctx.db.getTable('zones')]);
  const s = C.settingsWithDefaults(settings);

  // Prepared link: lock in what you agreed; take the customer's flavors, quantities and extras.
  let draft = null;
  let changes = [];
  if (body.token) {
    draft = await ctx.db.findOrderByToken(String(body.token));
    if (!draft) throw userError('This order link is not valid. Please contact us for a new one.');
    if (draft.status !== 'Draft') throw userError('This order was already submitted. Please contact us to make changes.');
    const merged = C.mergeCustomerItems(draft.prefill_items || [], f.items, products);
    f.items = merged.items;
    changes = merged.changes;
  } else {
    f.items = f.items.filter((it) => it.product).map(({ ref, price, added, ...it }) => it); // the general form can't set prices
  }
  if (!f.items.length) throw userError('Please add at least one item.');
  const missing = C.missingChoices(f.items, products);
  if (missing) throw userError(missing);

  // Delivery zone and fee
  let zone = null;
  if (f.fulfillment === 'Delivery' && zones.length) {
    zone = C.matchZone(f.zip, zones) || zones.find((z) => C.norm(z.zone) === C.norm(f.zone));
    if (!zone) throw userError('Please choose your delivery area.');
  }
  const pricing = C.priceOrder(f.items, products, f.paymentMethod, settings, zone ? zone.fee : 0);

  const row = {
    status: 'New', submitted_at: ctx.nowIso(),
    name: f.name, email: f.email, phone: f.phone, event_type: f.eventType, event_date: f.eventDate,
    fulfillment: f.fulfillment, time: f.time, address: f.address, zip: f.zip, delivery_zone: zone ? zone.zone : '', delivery_fee: pricing.delivery,
    items: f.items, allergies: f.allergies, notes: f.notes,
    payment_method: f.paymentMethod, payment_status: 'Unpaid', subtotal: pricing.subtotal, fee: pricing.fee, total: pricing.total,
    initials: f.initials, terms_text: s.terms, terms_accepted_at: ctx.nowIso(), signature: f.signature,
    client_info: String(req.clientInfo || '').slice(0, 300), changes, needs_review: changes.length ? 1 : 0
  };
  if (draft) {
    await ctx.db.updateOrder(draft.id, row);
    Object.assign(row, { id: draft.id, design_summary: draft.design_summary, images: draft.images, token: draft.token });
  } else {
    Object.assign(row, { created_at: ctx.nowIso(), square_invoice_id: '', square_invoice_url: '', deducted_at: '', token: '', design_summary: '', images: [], prefill_items: [] });
    row.id = await ctx.db.insertOrder(row);
  }

  const problems = [];
  const links = {};
  // Square draft invoice
  if (ctx.squareToken) {
    try {
      const inv = await createSquareInvoice(row, pricing, settings, ctx);
      await ctx.db.updateOrder(row.id, { square_invoice_id: inv.id, square_invoice_url: inv.url });
      links['Review draft invoice in Square'] = inv.url;
    } catch (e) { problems.push('Square invoice: ' + e.message); }
  } else problems.push('Square is not connected yet, so no draft invoice was made.');

  // Inventory check
  let shortages = null;
  try {
    const status = await currentInventory(ctx, recipes);
    shortages = C.shortagesForOrder(f.items, status, recipes);
  } catch (e) { problems.push('Inventory: ' + e.message); }

  links['Open dashboard'] = ctx.publicUrl ? ctx.publicUrl + 'admin.html#order-' + row.id : '';

  if (ctx.sendEmail) {
    const ownerTo = s.owner_email;
    if (ownerTo) {
      try {
        const m = C.ownerEmail(row, { shortages, links, problems });
        await ctx.sendEmail(ownerTo, m.subject, m.html, [{ filename: `order-${C.orderNo(row.id)}.ics`, content: C.buildIcs([row], settings, { method: 'PUBLISH' }), type: 'text/calendar' }], f.email);
      } catch (e) { console.error('owner email', e); }
    }
    if (C.yes(s.send_customer_copy)) {
      try { const m = C.customerEmail(row, settings, 'received'); await ctx.sendEmail(f.email, m.subject, m.html, [], ownerTo); }
      catch (e) { console.error('customer email', e); }
    }
  }
  return { orderNo: C.orderNo(row.id), id: row.id, shortages, problems, needsReview: !!changes.length };
}

async function currentInventory(ctx, recipes) {
  const [inventory, orders] = await Promise.all([ctx.db.getTable('inventory'), ctx.db.listOrders()]);
  const open = orders.filter((o) => C.OPEN_STATUSES.includes(o.status));
  return C.inventoryStatus(inventory, open, recipes || await ctx.db.getTable('recipes'));
}

// ───────── Square ─────────
function squareBase(settings) {
  return /sandbox/i.test(C.settingsWithDefaults(settings).square_env) ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com';
}
async function square(ctx, settings, method, path, body) {
  const res = await ctx.fetch(squareBase(settings) + path, {
    method, headers: { Authorization: 'Bearer ' + ctx.squareToken, 'Square-Version': '2024-10-17', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Square said: ' + ((json.errors || []).map((e) => e.detail || e.code).join('; ') || res.status));
  return json;
}
async function createSquareInvoice(o, pricing, settings, ctx) {
  const s = C.settingsWithDefaults(settings);
  if (!s.square_location_id) throw new Error('Add your Square location ID in Settings.');
  const found = await square(ctx, settings, 'POST', '/v2/customers/search', { query: { filter: { email_address: { exact: o.email } } }, limit: 1 });
  const customerId = found.customers && found.customers.length ? found.customers[0].id
    : (await square(ctx, settings, 'POST', '/v2/customers', C.squareCustomerBody(o, ctx.uuid()))).customer.id;
  const so = await square(ctx, settings, 'POST', '/v2/orders', C.squareOrderBody(o, pricing, s.square_location_id, customerId, settings, ctx.uuid()));
  const inv = await square(ctx, settings, 'POST', '/v2/invoices', C.squareInvoiceBody(o, s.square_location_id, customerId, so.order.id, settings, ctx.uuid()));
  const dash = /sandbox/i.test(s.square_env) ? 'https://app.squareupsandbox.com' : 'https://app.squareup.com';
  return { id: inv.invoice.id, url: `${dash}/dashboard/invoices/${inv.invoice.id}` };
}

// ───────── calendar feed ─────────
async function calendarFeed(req, ctx) {
  const settings = await ctx.db.getSettings();
  if (!settings._calendar_key || !safeEqual(String(req.query.key || ''), settings._calendar_key)) return fail(403, 'Bad calendar key');
  const orders = (await ctx.db.listOrders()).filter((o) => o.status !== 'Cancelled' && o.status !== 'Draft');
  return { status: 200, raw: C.buildIcs(orders, settings), contentType: 'text/calendar; charset=utf-8' };
}
async function ensureCalendarKey(ctx) {
  const s = await ctx.db.getSettings();
  if (s._calendar_key) return s._calendar_key;
  const key = ctx.uuid().replace(/-/g, '');
  await ctx.db.saveSettings({ ...s, _calendar_key: key });
  return key;
}

// ───────── admin ─────────
async function admin(req, ctx) {
  const { method, path, body } = req;
  let m;
  if (method === 'GET' && path === '/admin/info') {
    const key = await ensureCalendarKey(ctx);
    return ok({
      calendarUrl: ctx.publicUrl ? ctx.publicUrl + 'calendar.ics?key=' + key : '',
      emailConfigured: !!ctx.sendEmail, squareConfigured: !!ctx.squareToken, backend: ctx.backendName || ''
    });
  }
  if (method === 'GET' && path === '/admin/orders') {
    const orders = await ctx.db.listOrders();
    return ok(orders.map(({ signature, terms_text, prefill_items, ...o }) => ({ ...o, orderNo: C.orderNo(o.id) })));
  }
  // Prepare a private order link after your design conversation
  if (method === 'POST' && path === '/admin/drafts') return ok(await saveDraft(null, body, ctx));
  if ((m = path.match(/^\/admin\/drafts\/(\d+)$/)) && method === 'PUT') return ok(await saveDraft(+m[1], body, ctx));
  if (method === 'POST' && path === '/admin/images') {
    const data = String(body && body.data || '');
    if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(data)) return fail(400, 'Please upload a JPG, PNG or WebP image.');
    if (data.length > 1_400_000) return fail(400, 'That image is too large.');
    const id = ctx.uuid().replace(/-/g, '');
    await ctx.db.insertImage(id, data);
    return ok({ id });
  }
  if ((m = path.match(/^\/admin\/orders\/(\d+)\/reviewed$/)) && method === 'POST') {
    await ctx.db.updateOrder(+m[1], { needs_review: 0 });
    return ok({ ok: true });
  }
  if ((m = path.match(/^\/admin\/orders\/(\d+)\/payment$/)) && method === 'POST') {
    const ps = String(body && body.payment_status || '');
    if (!C.PAYMENT_STATUSES.includes(ps)) return fail(400, 'Bad payment status');
    await ctx.db.updateOrder(+m[1], { payment_status: ps });
    return ok({ ok: true });
  }
  // Report-an-issue notes (during development)
  if (path === '/admin/feedback' && method === 'POST') {
    const note = String(body && body.note || '').trim().slice(0, 5000);
    if (!note) return fail(400, 'Please write what you noticed.');
    const shot = String(body && body.screenshot || '');
    const id = await ctx.db.insertFeedback({ created_at: ctx.nowIso(), page: String(body.page || '').slice(0, 300), note,
      screenshot: /^data:image\/(jpeg|png);base64,/.test(shot) && shot.length < 1_500_000 ? shot : '', status: 'New', reply: '' });
    return ok({ id });
  }
  if (path === '/admin/feedback' && method === 'GET') {
    const list = await ctx.db.listFeedback();
    return ok(req.query && req.query.full ? list : list.map(({ screenshot, ...f }) => ({ ...f, hasScreenshot: !!screenshot })));
  }
  if ((m = path.match(/^\/admin\/feedback\/(\d+)$/))) {
    if (method === 'GET') { const f = (await ctx.db.listFeedback()).find((x) => x.id === +m[1]); return f ? ok(f) : fail(404, 'Not found'); }
    if (method === 'POST') {
      const patch = {};
      if (body && FEEDBACK_STATUSES.includes(body.status)) patch.status = body.status;
      if (body && body.reply != null) patch.reply = String(body.reply).slice(0, 5000);
      await ctx.db.updateFeedback(+m[1], patch);
      return ok({ ok: true });
    }
  }
  if ((m = path.match(/^\/admin\/orders\/(\d+)$/)) && method === 'GET') {
    const o = await ctx.db.getOrder(+m[1]);
    return o ? ok({ ...o, orderNo: C.orderNo(o.id) }) : fail(404, 'No such order');
  }
  if ((m = path.match(/^\/admin\/orders\/(\d+)\/status$/)) && method === 'POST') {
    const id = +m[1];
    const status = String(body && body.status || '');
    if (!C.STATUSES.includes(status)) return fail(400, 'Bad status');
    const o = await ctx.db.getOrder(id);
    if (!o) return fail(404, 'No such order');
    if (status === 'Confirmed' && o.needs_review) return fail(400, 'The customer changed or added something. Review it and press "Changes reviewed" before confirming.');
    const patch = { status };
    if (status === 'Confirmed' && o.status !== 'Confirmed' && !o.confirmed_email_at && ctx.sendEmail) {
      const settings = await ctx.db.getSettings();
      if (C.yes(C.settingsWithDefaults(settings).send_customer_copy)) {
        try { const em = C.customerEmail(o, settings, 'confirmed'); await ctx.sendEmail(o.email, em.subject, em.html, [], C.settingsWithDefaults(settings).owner_email); patch.confirmed_email_at = ctx.nowIso(); }
        catch (e) { console.error('confirm email', e); }
      }
    }
    if (status === 'Done' && !o.deducted_at) {
      const used = C.deductions(o.items, await ctx.db.getTable('recipes'));
      for (const [ing, amt] of Object.entries(used)) await ctx.db.adjustInventory(ing, -amt);
      patch.deducted_at = ctx.nowIso();
    }
    await ctx.db.updateOrder(id, patch);
    return ok({ ok: true, deducted: !!patch.deducted_at, emailed: !!patch.confirmed_email_at });
  }
  if ((m = path.match(/^\/admin\/orders\/(\d+)\/invoice$/)) && method === 'POST') {
    if (!ctx.squareToken) return fail(400, 'Square is not connected.');
    const o = await ctx.db.getOrder(+m[1]);
    const settings = await ctx.db.getSettings();
    const pricing = C.priceOrder(o.items, await ctx.db.getTable('products'), o.payment_method, settings, o.delivery_fee);
    const inv = await createSquareInvoice(o, pricing, settings, ctx);
    await ctx.db.updateOrder(o.id, { square_invoice_id: inv.id, square_invoice_url: inv.url });
    return ok(inv);
  }
  if (method === 'GET' && path === '/admin/inventory') {
    const status = await currentInventory(ctx);
    return ok({ ...status, shopping: C.shoppingList(status.rows) });
  }
  if ((m = path.match(/^\/admin\/tables\/(\w+)$/))) {
    const name = m[1];
    if (!C.TABLES[name]) return fail(404, 'No such table');
    if (method === 'GET') return ok(await ctx.db.getTable(name));
    if (method === 'PUT') {
      const cols = C.TABLES[name];
      const rows = (Array.isArray(body) ? body : []).map((r) => Object.fromEntries(cols.map((c) => [c, C.NUMERIC[c] ? C.num(r[c]) : String(r[c] ?? '').trim()])))
        .filter((r) => String(r[cols[0]]).trim());
      await ctx.db.replaceTable(name, rows);
      return ok({ ok: true, count: rows.length });
    }
  }
  if (path === '/admin/settings') {
    if (method === 'GET') {
      const s = await ctx.db.getSettings();
      return ok(Object.entries(C.SETTINGS_DEFS).map(([key, [def, label, help]]) => ({ key, label, help, value: s[key] ?? def })));
    }
    if (method === 'PUT') {
      const cur = await ctx.db.getSettings();
      const next = { ...cur };
      for (const k of Object.keys(C.SETTINGS_DEFS)) if (body && body[k] != null) next[k] = String(body[k]);
      await ctx.db.saveSettings(next);
      return ok({ ok: true });
    }
  }
  if (method === 'POST' && path === '/admin/weekly-email') return ok(await weeklyEmail(ctx));
  if (method === 'GET' && path === '/admin/square-test') {
    if (!ctx.squareToken) return fail(400, 'Square is not connected (no access token on the server).');
    const r = await square(ctx, await ctx.db.getSettings(), 'GET', '/v2/locations');
    return ok((r.locations || []).map((l) => ({ id: l.id, name: l.name })));
  }
  return fail(404, 'Not found');
}

export const FEEDBACK_STATUSES = ['New', 'In progress', 'Fixed', 'Won\'t do'];

async function saveDraft(id, body, ctx) {
  const b = body || {};
  const str = (v, max) => String(v ?? '').trim().slice(0, max);
  const items = (Array.isArray(b.items) ? b.items.slice(0, 30) : []).map((it, i) => ({ ...C.cleanItem(it), ref: 'p' + i }))
    .filter((it) => it.product && (it.size || it.tiers));
  if (!items.length) throw userError('Add at least one item.');
  const fields = {
    name: str(b.name, 120), email: str(b.email, 200), phone: str(b.phone, 40), event_type: str(b.eventType, 80),
    event_date: /^\d{4}-\d{2}-\d{2}$/.test(b.eventDate || '') ? b.eventDate : '', time: /^\d{2}:\d{2}$/.test(b.time || '') ? b.time : '',
    fulfillment: ['Pickup', 'Delivery'].includes(b.fulfillment) ? b.fulfillment : '',
    design_summary: str(b.designSummary, 5000),
    images: (Array.isArray(b.images) ? b.images : []).filter((x) => /^[A-Za-z0-9]{16,64}$/.test(x)).slice(0, 12),
    prefill_items: items, items
  };
  const products = await ctx.db.getTable('products');
  const pricing = C.priceOrder(items, products, '', {}, 0);
  Object.assign(fields, { subtotal: pricing.subtotal, total: pricing.total, fee: 0 });
  if (id) {
    const o = await ctx.db.getOrder(id);
    if (!o) throw userError('No such order.');
    if (o.status !== 'Draft') throw userError('The customer already submitted this order, so the link can no longer be changed.');
    await ctx.db.updateOrder(id, fields);
    return { id, token: o.token, orderNo: C.orderNo(id) };
  }
  const token = (ctx.uuid() + ctx.uuid()).replace(/-/g, '').slice(0, 32);
  const row = { ...fields, token, status: 'Draft', created_at: ctx.nowIso(), payment_status: 'Unpaid', changes: [], needs_review: 0,
    square_invoice_id: '', square_invoice_url: '', deducted_at: '', signature: '', terms_text: '', initials: '' };
  const newId = await ctx.db.insertOrder(row);
  return { id: newId, token, orderNo: C.orderNo(newId) };
}

export async function weeklyEmail(ctx) {
  const settings = await ctx.db.getSettings();
  const s = C.settingsWithDefaults(settings);
  const status = await currentInventory(ctx);
  const today = C.todayIn(s.timezone);
  const end = C.addDays(today, 8);
  const orders = (await ctx.db.listOrders()).filter((o) => C.OPEN_STATUSES.includes(o.status) && o.event_date >= today && o.event_date < end)
    .sort((a, b) => (a.event_date + a.time).localeCompare(b.event_date + b.time));
  const m = C.weeklyEmail(status, orders);
  if (!ctx.sendEmail) return { sent: false, reason: 'Email is not set up on the server.', html: m.html };
  if (!s.owner_email) return { sent: false, reason: 'Add your email in Settings.', html: m.html };
  await ctx.sendEmail(s.owner_email, m.subject, m.html, []);
  return { sent: true, html: m.html };
}
