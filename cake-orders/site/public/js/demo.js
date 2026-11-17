// In-browser demo backend: same handlers as the real server (api.js), with storage in this
// browser and pretend Square/email so every screen can be tried without any setup.
import { handle } from './api.js';
import * as C from './core.js';

const KEY = 'dessert-orders-demo-v2';
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
  const state = { settings: { owner_email: 'you@example.com', square_location_id: 'DEMO-LOCATION' }, ...s, orders: [], nextId: 1, outbox: [],
    images: {}, feedback: [], nextFeedback: 1 };
  // A few example orders so the dashboard isn't empty.
  const tz = C.settingsWithDefaults(state.settings).timezone;
  const today = C.todayIn(tz);
  const examples = [
    { name: 'Rachel Levine', email: 'rachel@example.com', phone: '555-201-3344', event_type: 'Bar/Bat Mitzvah', event_date: C.addDays(today, 3), time: '14:00',
      fulfillment: 'Delivery', address: '18 Oak Lane, Brooklyn', zip: '11230', delivery_zone: 'Brooklyn', delivery_fee: 40,
      design_summary: 'Navy & gold theme. Gold drip on the top tier, "Mazel Tov Eli" in gold script. Star of David cookies to match.',
      items: [{ product: 'Cake', tiers: [{ size: '10" round', choice1: 'Chocolate', choice2: 'Chocolate Ganache' }, { size: '8" round', choice1: 'Vanilla', choice2: 'Raspberry' }], qty: 1, price: 380, notes: 'Navy fondant, gold drip' },
        { product: 'Cookies', size: '1 dozen', choice1: 'Vanilla Sugar Cookie', choice2: '', qty: 4, price: 54, notes: 'Star of David + name cookies' }],
      payment_method: 'Credit card', status: 'Confirmed', payment_status: 'Paid' },
    { name: 'Dana Cohen', email: 'dana@example.com', phone: '555-777-1200', event_type: 'Birthday', event_date: C.addDays(today, 5), time: '11:30', fulfillment: 'Pickup', address: '',
      design_summary: 'Unicorn theme, pink & purple, gold horn toppers.',
      items: [{ product: 'Cake Pops', size: '1 dozen', choice1: 'Funfetti', choice2: 'White Chocolate', qty: 3, price: 78, notes: 'Pink & purple unicorns' },
        { product: 'Cookies', size: '1 dozen', choice1: 'Chocolate Sugar Cookie', choice2: '', qty: 1, price: 48, notes: '', added: true }],
      changes: ['Changed quantity of 1 dozen Cake Pops from 2 to 3', 'Added: 1 × 1 dozen Cookies – Chocolate Sugar Cookie (minimum price $48.00 each)'],
      needs_review: 1, payment_method: 'Venmo', status: 'New', payment_status: 'Unpaid', allergies: 'Nut allergy' },
    { name: 'Michael Stern', email: 'mstern@example.com', phone: '555-430-9981', event_type: 'Corporate', event_date: C.addDays(today, 12), time: '', fulfillment: 'Pickup', address: '',
      items: [{ product: 'Dessert Cups', size: '1 dozen', choice1: 'Red Velvet', choice2: 'Vanilla Buttercream', qty: 3, price: 60, notes: 'Company logo toppers' }],
      payment_method: 'Zelle', status: 'Baked', payment_status: 'Deposit paid' }
  ];
  for (const e of examples) {
    const pricing = C.priceOrder(e.items, s.products, e.payment_method, state.settings, e.delivery_fee || 0);
    state.orders.push({ allergies: '', notes: '', changes: [], needs_review: 0, images: [], design_summary: '', token: '', zip: '', delivery_zone: '', delivery_fee: 0, ...e,
      id: state.nextId++, created_at: new Date().toISOString(), submitted_at: new Date().toISOString(),
      subtotal: pricing.subtotal, fee: pricing.fee, total: pricing.total, initials: e.name.split(' ').map((x) => x[0]).join(''),
      terms_text: C.SETTINGS_DEFS.terms[0], terms_accepted_at: new Date().toISOString(), signature: '', client_info: 'example',
      square_invoice_id: 'demo-' + e.name.split(' ')[0].toLowerCase(), square_invoice_url: '#square-demo', deducted_at: '' });
  }
  // A prepared link that the customer hasn't filled in yet.
  const prepared = [{ ref: 'p0', product: 'Cake', tiers: [{ size: '10" round', choice1: '', choice2: '' }, { size: '8" round', choice1: '', choice2: '' }, { size: '6" round', choice1: '', choice2: '' }],
    qty: 1, price: 520, notes: 'White fondant, pressed flowers cascading down one side' },
    { ref: 'p1', product: 'Cookies', size: '1 dozen', choice1: '', choice2: '', qty: 6, price: 54, notes: 'Monogram cookies L & D' }];
  state.orders.push({ id: state.nextId++, status: 'Draft', token: 'demoLeahGold000000000000000000ab', created_at: new Date().toISOString(),
    name: 'Leah Gold', email: 'leah@example.com', phone: '', event_type: 'Wedding', event_date: C.addDays(today, 20), time: '', fulfillment: '',
    design_summary: '3-tier white wedding cake with pressed flowers cascading down one side (blush & sage).\nMonogram cookies L & D for the dessert table.',
    images: [], items: prepared, prefill_items: prepared, changes: [], needs_review: 0, payment_status: 'Unpaid', subtotal: 844, fee: 0, total: 844,
    signature: '', terms_text: '', initials: '', square_invoice_id: '', square_invoice_url: '', deducted_at: '' });
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
  async findOrderByToken(token) { const o = load().orders.find((x) => x.token && x.token === token); return o ? clone(o) : null; },
  async insertImage(id, data) { const s = load(); s.images[id] = data; save(s); },
  async getImage(id) { return load().images[id] || null; },
  async insertFeedback(f) { const s = load(); const id = s.nextFeedback++; s.feedback.unshift({ ...f, id }); save(s); return id; },
  async listFeedback() { return clone(load().feedback); },
  async updateFeedback(id, patch) { const s = load(); const f = s.feedback.find((x) => x.id === id); if (f) Object.assign(f, patch); save(s); },
  async listOrders() {
    return load().orders.map(({ signature, terms_text, prefill_items, ...o }) => clone(o))
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
