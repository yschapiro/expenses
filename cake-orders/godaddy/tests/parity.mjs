// Runs core.js over parity-fixture.json and prints JSON (compare with parity.php).
import { readFileSync } from 'node:fs';
const C = await import(new URL('../../site/public/js/core.js', import.meta.url));
const fx = JSON.parse(readFileSync(new URL('./parity-fixture.json', import.meta.url)));
const SIG = 'data:image/png;base64,' + 'A'.repeat(300);
const fix = (f) => f && f.signature === 'SIG' ? { ...f, signature: SIG } : f;
const sample = C.sampleData();
const out = { sample, nums: fx.nums.map(C.num), norms: fx.nums.map(C.norm), cases: [], bad: [] };
out.config = C.formConfig(fx.settings, sample.products, sample.choices);
out.defaults = C.settingsWithDefaults(fx.settings);
const orders = [];
fx.forms.forEach((form, i) => {
  const f = C.cleanOrder(fix(form));
  const pricing = C.priceOrder(f.items, sample.products, f.paymentMethod, fx.settings);
  const row = { id: i + 1, status: i ? 'Confirmed' : 'New', name: f.name, email: f.email, phone: f.phone, event_type: f.eventType, event_date: f.eventDate,
    fulfillment: f.fulfillment, time: f.time, address: f.address, items: f.items, allergies: f.allergies, notes: f.notes, payment_method: f.paymentMethod,
    subtotal: pricing.subtotal, fee: pricing.fee, total: pricing.total, initials: f.initials, terms_text: 'T&C <b>', terms_accepted_at: '2030-01-01T00:00:00.000Z', signature: f.signature };
  orders.push(row);
  out.cases.push({ f, pricing, needs: C.computeNeeds(f.items, sample.recipes) });
});
const status = C.inventoryStatus(sample.inventory, orders, sample.recipes);
out.status = status;
out.shopping = C.shoppingList(status.rows);
out.shortages = orders.map((o) => C.shortagesForOrder(o.items, status, sample.recipes));
out.owner = orders.map((o, i) => C.ownerEmail(o, { shortages: out.shortages[i], links: { 'Open dashboard': 'https://x/admin.html#order-1', Empty: '' }, problems: ['a <b>'] }));
out.customer = orders.map((o) => C.customerEmail(o, fx.settings));
out.weekly = C.weeklyEmail(status, orders);
out.ics = C.buildIcs([...orders, { ...orders[1], id: 9, status: 'Cancelled', time: '', notes: 'x'.repeat(200) }], fx.settings, { method: 'PUBLISH' }).replace(/DTSTAMP:\w+/g, 'DTSTAMP:X');
out.square = orders.map((o, i) => [C.squareOrderBody(o, out.cases[i].pricing, 'LOC', 'CUST', fx.settings, 'u1'),
  C.squareInvoiceBody(o, 'LOC', 'CUST', 'ORD', fx.settings, 'u2'), C.squareCustomerBody(o, 'u3')]);
for (const b of fx.badForms) { try { C.cleanOrder(fix(b)); out.bad.push('OK'); } catch (e) { out.bad.push(e.message); } }
out.misc = { money: [0, 1.005, 0.125, 1234.5, null].map(C.money), dt: ['00:05', '12:30', '23:59', 'x'].map(C.displayTime), dd: ['2026-02-29', '2030-12-31', 'bad'].map(C.displayDate),
  add: C.addDays('2026-03-01', -1), deductions: C.deductions(orders[0].items, sample.recipes) };
console.log(JSON.stringify(out, null, 1));
