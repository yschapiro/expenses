// Cloudflare Worker: serves the site (../site/public) and the /api/* routes.
// Storage: D1 (binding DB). Email: Resend (optional). Invoices: Square (optional).
import { handle, weeklyEmail } from '../../site/public/js/api.js';
import * as C from '../../site/public/js/core.js';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let path;
    if (url.pathname.startsWith('/api/')) path = url.pathname.slice(4);
    else if (url.pathname === '/calendar.ics') path = '/calendar.ics';
    else return env.ASSETS.fetch(request);

    const ctx = makeCtx(env, url.origin + '/');
    await ensureSeeded(env.DB);

    let body = null;
    if (request.method === 'POST' || request.method === 'PUT') {
      const text = await request.text();
      if (text.length > 1_000_000) return json({ error: 'Too large' }, 413);
      try { body = text ? JSON.parse(text) : null; } catch { return json({ error: 'Bad JSON' }, 400); }
    }
    const res = await handle({
      method: request.method, path, body,
      query: Object.fromEntries(url.searchParams),
      adminKey: request.headers.get('X-Admin-Key') || '',
      clientInfo: [request.headers.get('CF-Connecting-IP'), request.headers.get('User-Agent')].filter(Boolean).join(' | ')
    }, ctx);
    if (res.raw != null) return new Response(res.raw, { status: res.status, headers: { 'Content-Type': res.contentType, 'Cache-Control': 'no-store' } });
    return json(res.data, res.status);
  },

  async scheduled(event, env, executionCtx) {
    await ensureSeeded(env.DB);
    executionCtx.waitUntil(weeklyEmail(makeCtx(env, '')));
  }
};

function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS }); }

function makeCtx(env, publicUrl) {
  return {
    db: d1Adapter(env.DB),
    adminPassword: env.ADMIN_PASSWORD,
    squareToken: env.SQUARE_ACCESS_TOKEN || '',
    fetch: (u, o) => fetch(u, o),
    sendEmail: env.RESEND_API_KEY && env.FROM_EMAIL ? (to, subject, html, attachments, replyTo) => resend(env, to, subject, html, attachments, replyTo) : null,
    uuid: () => crypto.randomUUID(),
    nowIso: () => new Date().toISOString(),
    publicUrl,
    backendName: 'Cloudflare'
  };
}

// ───────── Email via Resend ─────────
async function resend(env, to, subject, html, attachments = [], replyTo) {
  const body = { from: env.FROM_EMAIL, to: [to], subject, html };
  if (replyTo) body.reply_to = replyTo;
  if (attachments.length) body.attachments = attachments.map((a) => ({ filename: a.filename, content: b64(a.content) }));
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error('Email failed: ' + (await r.text()).slice(0, 300));
}
function b64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// ───────── D1 storage ─────────
const ORDER_COLS = ['created_at', 'status', 'name', 'email', 'phone', 'event_type', 'event_date', 'fulfillment', 'time', 'address', 'items',
  'allergies', 'notes', 'payment_method', 'subtotal', 'fee', 'total', 'initials', 'terms_text', 'terms_accepted_at', 'signature',
  'client_info', 'square_invoice_id', 'square_invoice_url', 'deducted_at',
  'token', 'design_summary', 'images', 'prefill_items', 'changes', 'needs_review', 'zip', 'delivery_zone', 'delivery_fee',
  'payment_status', 'submitted_at', 'confirmed_email_at'];
const JSON_COLS = ['items', 'images', 'prefill_items', 'changes'];
const LIST_COLS = ORDER_COLS.filter((c) => !['signature', 'terms_text', 'prefill_items'].includes(c));
const toDb = (c, v) => JSON_COLS.includes(c) ? JSON.stringify(v ?? []) : (v ?? '');

function rowToOrder(r) {
  if (!r) return r;
  const o = { ...r };
  for (const c of JSON_COLS) if (c in o) { try { o[c] = JSON.parse(o[c] || '[]'); } catch { o[c] = []; } }
  return o;
}

function d1Adapter(db) {
  return {
    async getSettings() {
      const { results } = await db.prepare('SELECT key, value FROM settings').all();
      return Object.fromEntries(results.map((r) => [r.key, r.value]));
    },
    async saveSettings(obj) {
      const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
      await db.batch(Object.entries(obj).map(([k, v]) => stmt.bind(k, String(v ?? ''))));
    },
    async getTable(name) {
      const cols = C.TABLES[name];
      const { results } = await db.prepare(`SELECT ${cols.join(', ')} FROM ${name} ORDER BY id`).all();
      return results;
    },
    async replaceTable(name, rows) {
      const cols = C.TABLES[name];
      const ins = db.prepare(`INSERT INTO ${name} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
      await db.batch([db.prepare(`DELETE FROM ${name}`), ...rows.map((r) => ins.bind(...cols.map((c) => r[c] ?? null)))]);
    },
    async insertOrder(o) {
      const vals = ORDER_COLS.map((c) => toDb(c, o[c]));
      const r = await db.prepare(`INSERT INTO orders (${ORDER_COLS.join(', ')}) VALUES (${ORDER_COLS.map(() => '?').join(', ')})`).bind(...vals).run();
      return r.meta.last_row_id;
    },
    async updateOrder(id, patch) {
      const keys = Object.keys(patch).filter((k) => ORDER_COLS.includes(k));
      if (!keys.length) return;
      await db.prepare(`UPDATE orders SET ${keys.map((k) => k + ' = ?').join(', ')} WHERE id = ?`)
        .bind(...keys.map((k) => toDb(k, patch[k])), id).run();
    },
    async getOrder(id) {
      return rowToOrder(await db.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first());
    },
    async listOrders() {
      const { results } = await db.prepare(`SELECT id, ${LIST_COLS.join(', ')} FROM orders ORDER BY event_date, time`).all();
      return results.map(rowToOrder);
    },
    async findOrderByToken(token) {
      if (!token) return null;
      return rowToOrder(await db.prepare('SELECT * FROM orders WHERE token = ?').bind(token).first());
    },
    async insertImage(id, data) { await db.prepare('INSERT INTO images (id, data) VALUES (?, ?)').bind(id, data).run(); },
    async getImage(id) { const r = await db.prepare('SELECT data FROM images WHERE id = ?').bind(id).first(); return r ? r.data : null; },
    async insertFeedback(f) {
      const r = await db.prepare('INSERT INTO feedback (created_at, page, note, screenshot, status, reply) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(f.created_at, f.page, f.note, f.screenshot, f.status, f.reply).run();
      return r.meta.last_row_id;
    },
    async listFeedback() { return (await db.prepare('SELECT * FROM feedback ORDER BY id DESC').all()).results; },
    async updateFeedback(id, patch) {
      const keys = Object.keys(patch).filter((k) => ['status', 'reply'].includes(k));
      if (keys.length) await db.prepare(`UPDATE feedback SET ${keys.map((k) => k + ' = ?').join(', ')} WHERE id = ?`).bind(...keys.map((k) => patch[k]), id).run();
    },
    async adjustInventory(ingredient, delta) {
      await db.prepare('UPDATE inventory SET on_hand = ROUND(on_hand + ?, 3) WHERE lower(trim(ingredient)) = lower(trim(?))').bind(delta, ingredient).run();
    }
  };
}

let seeded = false;
async function ensureSeeded(db) {
  if (seeded) return;
  const flag = await db.prepare("SELECT value FROM settings WHERE key = '_seeded'").first().catch(() => null);
  if (!flag) {
    const a = d1Adapter(db);
    const sample = C.sampleData();
    for (const t of Object.keys(C.TABLES)) await a.replaceTable(t, sample[t]);
    await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('_seeded', '1')").run();
  }
  seeded = true;
}
