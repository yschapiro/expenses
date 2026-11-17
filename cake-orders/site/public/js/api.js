// Request handlers shared by the Cloudflare Worker and the in-browser demo.
// The PHP version (godaddy/) implements the same routes and responses.
//
// handle(req, ctx) where
//   req = { method, path, query, body, adminKey }
//   ctx = {
//     db:  { getSettings, saveSettings, getTable, replaceTable, insertOrder, updateOrder, getOrder, listOrders, adjustInventory },
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
    if (method === 'GET' && path === '/config') return ok(await getConfig(ctx));
    if (method === 'POST' && path === '/orders') return ok(await submitOrder(req.body, ctx, req));
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
  const [s, products, choices] = await Promise.all([ctx.db.getSettings(), ctx.db.getTable('products'), ctx.db.getTable('choices')]);
  return C.formConfig(s, products, choices);
}

// ───────── new order ─────────
async function submitOrder(body, ctx, req) {
  if (body && body.website) return { orderNo: 0 }; // honeypot: bots fill hidden fields
  let f;
  try { f = C.cleanOrder(body); } catch (e) { e.userFacing = true; throw e; }

  const [settings, products, recipes] = await Promise.all([ctx.db.getSettings(), ctx.db.getTable('products'), ctx.db.getTable('recipes')]);
  const s = C.settingsWithDefaults(settings);
  const pricing = C.priceOrder(f.items, products, f.paymentMethod, settings);

  const row = {
    created_at: ctx.nowIso(), status: 'New',
    name: f.name, email: f.email, phone: f.phone, event_type: f.eventType, event_date: f.eventDate,
    fulfillment: f.fulfillment, time: f.time, address: f.address, items: f.items, allergies: f.allergies, notes: f.notes,
    payment_method: f.paymentMethod, subtotal: pricing.subtotal, fee: pricing.fee, total: pricing.total,
    initials: f.initials, terms_text: s.terms, terms_accepted_at: ctx.nowIso(), signature: f.signature,
    client_info: String(req.clientInfo || '').slice(0, 300), square_invoice_id: '', square_invoice_url: '', deducted_at: ''
  };
  row.id = await ctx.db.insertOrder(row);

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
      try { const m = C.customerEmail(row, settings); await ctx.sendEmail(f.email, m.subject, m.html, [], ownerTo); }
      catch (e) { console.error('customer email', e); }
    }
  }
  return { orderNo: C.orderNo(row.id), id: row.id, shortages, problems };
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
  const orders = (await ctx.db.listOrders()).filter((o) => o.status !== 'Cancelled');
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
    return ok(orders.map(({ signature, terms_text, ...o }) => ({ ...o, orderNo: C.orderNo(o.id) })));
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
    const patch = { status };
    if (status === 'Done' && !o.deducted_at) {
      const used = C.deductions(o.items, await ctx.db.getTable('recipes'));
      for (const [ing, amt] of Object.entries(used)) await ctx.db.adjustInventory(ing, -amt);
      patch.deducted_at = ctx.nowIso();
    }
    await ctx.db.updateOrder(id, patch);
    return ok({ ok: true, deducted: !!patch.deducted_at });
  }
  if ((m = path.match(/^\/admin\/orders\/(\d+)\/invoice$/)) && method === 'POST') {
    if (!ctx.squareToken) return fail(400, 'Square is not connected.');
    const o = await ctx.db.getOrder(+m[1]);
    const settings = await ctx.db.getSettings();
    const pricing = C.priceOrder(o.items, await ctx.db.getTable('products'), o.payment_method, settings);
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
