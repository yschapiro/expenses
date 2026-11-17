// In-browser demo backend: same handlers as the real server (api.js), with storage in this
// browser and pretend Square/email so every screen can be tried without any setup.
import { handle } from './api.js';
import * as C from './core.js';

const KEY = 'dessert-orders-demo-v1';
let mem = null; // fallback when localStorage is unavailable

function load() {
  try { const raw = localStorage.getItem(KEY); if (raw) return JSON.parse(raw); } catch { /* private mode */ }
  if (mem) return mem;
  return seed();
}
function save(state) {
  mem = state;
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* ignore */ }
}

function seed() {
  const s = C.sampleData();
  const state = { settings: { owner_email: 'you@example.com', square_location_id: 'DEMO-LOCATION' }, ...s, orders: [], nextId: 1, outbox: [] };
  // A few example orders so the dashboard isn't empty.
  const tz = C.settingsWithDefaults(state.settings).timezone;
  const today = C.todayIn(tz);
  const examples = [
    { name: 'Rachel Levine', email: 'rachel@example.com', phone: '555-201-3344', event_type: 'Bar/Bat Mitzvah', event_date: C.addDays(today, 3), time: '14:00', fulfillment: 'Delivery', address: '18 Oak Lane',
      items: [{ product: 'Cake', size: '10" round', choice1: 'Chocolate', choice2: 'Chocolate Ganache', qty: 1, notes: 'Navy & gold, "Mazel Tov Eli"' },
        { product: 'Cookies', size: '1 dozen', choice1: 'Vanilla Sugar Cookie', choice2: '', qty: 4, notes: 'Star of David + name cookies' }],
      payment_method: 'Credit card', status: 'Confirmed' },
    { name: 'Dana Cohen', email: 'dana@example.com', phone: '555-777-1200', event_type: 'Birthday', event_date: C.addDays(today, 5), time: '11:30', fulfillment: 'Pickup', address: '',
      items: [{ product: 'Cake Pops', size: '1 dozen', choice1: 'Funfetti', choice2: 'White Chocolate', qty: 2, notes: 'Pink & purple unicorns' }],
      payment_method: 'Venmo', status: 'New', allergies: 'Nut allergy' },
    { name: 'Michael Stern', email: 'mstern@example.com', phone: '555-430-9981', event_type: 'Corporate', event_date: C.addDays(today, 12), time: '', fulfillment: 'Pickup', address: '',
      items: [{ product: 'Dessert Cups', size: '1 dozen', choice1: 'Red Velvet', choice2: 'Vanilla Buttercream', qty: 3, notes: 'Company logo toppers' }],
      payment_method: 'Zelle', status: 'New' }
  ];
  for (const e of examples) {
    const pricing = C.priceOrder(e.items, s.products, e.payment_method, state.settings);
    state.orders.push({ allergies: '', notes: '', ...e, id: state.nextId++, created_at: new Date().toISOString(),
      subtotal: pricing.subtotal, fee: pricing.fee, total: pricing.total, initials: e.name.split(' ').map((x) => x[0]).join(''),
      terms_text: C.SETTINGS_DEFS.terms[0], terms_accepted_at: new Date().toISOString(), signature: '', client_info: 'example',
      square_invoice_id: 'demo-' + e.name.split(' ')[0].toLowerCase(), square_invoice_url: '#square-demo', deducted_at: '' });
  }
  save(state);
  return state;
}

const clone = (x) => JSON.parse(JSON.stringify(x));

const db = {
  async getSettings() { return { ...load().settings }; },
  async saveSettings(obj) { const s = load(); s.settings = { ...obj }; save(s); },
  async getTable(name) { return clone(load()[name]); },
  async replaceTable(name, rows) { const s = load(); s[name] = clone(rows); save(s); },
  async insertOrder(o) { const s = load(); const id = s.nextId++; s.orders.push({ ...clone(o), id }); save(s); return id; },
  async updateOrder(id, patch) { const s = load(); const o = s.orders.find((x) => x.id === id); if (o) Object.assign(o, clone(patch)); save(s); },
  async getOrder(id) { const o = load().orders.find((x) => x.id === id); return o ? clone(o) : null; },
  async listOrders() {
    return load().orders.map(({ signature, terms_text, ...o }) => clone(o))
      .sort((a, b) => (a.event_date + a.time).localeCompare(b.event_date + b.time));
  },
  async adjustInventory(ingredient, delta) {
    const s = load();
    for (const r of s.inventory) if (C.norm(r.ingredient) === C.norm(ingredient)) r.on_hand = C.r3(C.num(r.on_hand) + delta);
    save(s);
  }
};

// Pretend Square: answers like the real API so the "draft invoice" step runs.
async function fakeFetch(url, opts) {
  const path = new URL(url).pathname;
  const reply = (data) => ({ ok: true, status: 200, json: async () => data });
  if (path.endsWith('/customers/search')) return reply({ customers: [] });
  if (path.endsWith('/customers')) return reply({ customer: { id: 'DEMO-CUSTOMER' } });
  if (path.endsWith('/orders')) return reply({ order: { id: 'DEMO-ORDER-' + Date.now() } });
  if (path.endsWith('/invoices')) return reply({ invoice: { id: 'demo-' + Date.now(), _body: JSON.parse(opts.body) } });
  if (path.endsWith('/locations')) return reply({ locations: [{ id: 'DEMO-LOCATION', name: 'Your kitchen (demo)' }] });
  return { ok: false, status: 404, json: async () => ({ errors: [{ detail: 'demo' }] }) };
}

export function demoOutbox() { return load().outbox || []; }
export function demoReset() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } mem = null; }

export async function demoHandle(req) {
  const res = await handle(req, {
    db,
    adminPassword: 'demo',
    squareToken: 'demo',
    fetch: fakeFetch,
    sendEmail: async (to, subject, html, attachments) => {
      const s = load();
      s.outbox.unshift({ to, subject, html, at: new Date().toISOString(), attachments: (attachments || []).map((a) => a.filename) });
      s.outbox = s.outbox.slice(0, 30);
      save(s);
    },
    uuid: () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)),
    nowIso: () => new Date().toISOString(),
    publicUrl: new URL('.', location.href).href,
    backendName: 'Demo'
  });
  // Point the pretend invoice links somewhere harmless.
  if (res.data && typeof res.data === 'object' && res.data.url && String(res.data.url).includes('/dashboard/invoices/')) res.data.url = '#square-demo';
  return res;
}
