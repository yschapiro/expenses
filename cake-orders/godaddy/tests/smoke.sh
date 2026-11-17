#!/usr/bin/env bash
# Smoke test for the GoDaddy PHP backend.
#   godaddy/tests/smoke.sh                 – starts `php -S` on a temp SQLite DB, runs all checks, stops it
#   SMOKE_DIR=/some/tmp godaddy/tests/smoke.sh   – keep the temp config + database in that folder
# Needs: php (8.1+), node (18+), curl. Also lints every PHP file and runs the core.js ⇄ core.php parity check.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
CORE_JS="$(cd "$ROOT/../site/public/js" && pwd)/core.js"
PORT="${PORT:-8099}"
BASE="http://127.0.0.1:$PORT/"
DIR="${SMOKE_DIR:-$(mktemp -d)}"
mkdir -p "$DIR"
rm -f "$DIR/orders.sqlite" "$DIR/orders.sqlite-"*

echo "== php -l"
find "$ROOT" -name '*.php' -print0 | xargs -0 -n1 php -l | grep -v '^No syntax errors' && { echo "lint failed"; exit 1; } || true

echo "== parity core.js vs core.php"
node "$HERE/parity.mjs" | node -e 'process.stdout.write(JSON.stringify(JSON.parse(require("fs").readFileSync(0)))+"\n")' > "$DIR/parity-js.json"
php "$HERE/parity.php" > "$DIR/parity-php.json"
cmp -s "$DIR/parity-js.json" "$DIR/parity-php.json" && echo "ok   parity (byte-identical JSON)" || { echo "FAIL parity: diff $DIR/parity-js.json $DIR/parity-php.json"; exit 1; }

cat > "$DIR/config.php" <<EOF
<?php return ['ADMIN_PASSWORD' => 'test-pass', 'SQUARE_ACCESS_TOKEN' => '', 'FROM_EMAIL' => '', 'DB_DSN' => 'sqlite:$DIR/orders.sqlite', 'DB_USER' => '', 'DB_PASS' => ''];
EOF

ORDERS_CONFIG="$DIR/config.php" php -S "127.0.0.1:$PORT" -t "$ROOT" > "$DIR/server.log" 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do curl -s -o /dev/null "$BASE" && break; sleep 0.1; done

echo "== HTTP checks against $BASE"
BASE="$BASE" CORE_JS="$CORE_JS" node --input-type=module <<'EOF'
import zlib from 'node:zlib';
const C = await import(process.env.CORE_JS);
const BASE = process.env.BASE;
let failed = 0;
const check = (name, cond, extra = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond ? '' : ' ' + extra)); if (!cond) failed++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
async function api(method, route, body, key = 'test-pass', extraQuery = '') {
  const headers = { 'Content-Type': 'application/json' };
  if (key !== null) headers['X-Admin-Key'] = key;
  const r = await fetch(BASE + 'api.php?r=' + route + extraQuery, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let data = null; try { data = JSON.parse(text); } catch {}
  return { status: r.status, type: r.headers.get('content-type'), cache: r.headers.get('cache-control'), text, data };
}

// A real (small, noisy) PNG as a data URL.
function png(w, h) {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h); for (let i = 0; i < raw.length; i++) raw[i] = i % (w * 3 + 1) === 0 ? 0 : (i * 7919) % 251;
  return 'data:image/png;base64,' + Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}
const signature = png(24, 12);
const date = C.addDays(new Date().toISOString().slice(0, 10), 2);
const order = {
  name: 'Sarah Klein', email: 'sarah@example.com', phone: '(555) 123-4567', eventType: 'Bar/Bat Mitzvah', eventDate: date,
  fulfillment: 'Delivery', time: '15:00', address: '12 Main St', allergies: 'Sesame', notes: 'Navy & gold',
  paymentMethod: 'Credit card', initials: 'SK', agreed: true, signature, website: '',
  items: [{ product: 'Cake', size: '8" round', choice1: 'Chocolate', choice2: 'Raspberry', qty: 1, notes: 'Mazel Tov "Eli"' },
          { product: 'Cookies', size: '1 dozen', choice1: 'Vanilla Sugar Cookie', choice2: '', qty: 3, notes: '' }]
};
const sample = C.sampleData();

let r = await api('GET', '/config', undefined, null);
check('GET /config 200 + json headers', r.status === 200 && /^application\/json; charset=utf-8/.test(r.type) && r.cache === 'no-store', r.status + ' ' + r.type);
check('config matches core.js formConfig(sample)', eq(r.data, C.formConfig({}, sample.products, sample.choices)));

r = await api('POST', '/orders', { ...order, website: 'spam' }, null);
check('honeypot → {orderNo:0}', r.status === 200 && r.text === '{"orderNo":0}', r.text);

r = await api('POST', '/orders', { ...order, initials: '' }, null);
check('invalid order → 400 error', r.status === 400 && r.data.error === 'Please fill in: initials.', r.text);
r = await api('POST', '/orders', { ...order, signature: 'data:image/png;base64,abc' }, null);
check('bad signature → 400', r.status === 400 && r.data.error === 'Please sign the form.', r.text);
r = await fetch(BASE + 'api.php?r=/orders', { method: 'POST', body: '{bad' });
check('bad JSON → 400', r.status === 400 && (await r.json()).error === 'Bad JSON');

r = await api('POST', '/orders', order, null);
check('valid order → 200 orderNo 1001', r.status === 200 && r.data.orderNo === 1001 && r.data.id === 1, r.text);
check('order response keys', eq(Object.keys(r.data), ['orderNo', 'id', 'shortages', 'problems']) && Array.isArray(r.data.problems) && r.data.problems[0] === 'Square is not connected yet, so no draft invoice was made.', r.text);
const clean = C.cleanOrder(order);
const invBefore = C.inventoryStatus(sample.inventory, [{ items: clean.items }], sample.recipes);
check('shortages match core.js', eq(r.data.shortages, C.shortagesForOrder(clean.items, invBefore, sample.recipes)), r.text);

r = await api('GET', '/admin/orders', undefined, 'wrong');
check('admin wrong key → 401', r.status === 401 && r.data.error === 'Wrong password.', r.text);
r = await api('GET', '/admin/orders', undefined, null);
check('admin no key → 401', r.status === 401);

r = await api('GET', '/admin/orders');
const pricing = C.priceOrder(clean.items, sample.products, clean.paymentMethod, {});
check('admin orders list', r.status === 200 && r.data.length === 1 && r.data[0].orderNo === 1001 && !('signature' in r.data[0]) && !('terms_text' in r.data[0]) && Array.isArray(r.data[0].items), r.text.slice(0, 300));
check('list pricing = core.js priceOrder', r.data[0].subtotal === pricing.subtotal && r.data[0].fee === pricing.fee && r.data[0].total === pricing.total, JSON.stringify([r.data[0].subtotal, r.data[0].fee, r.data[0].total, pricing.subtotal, pricing.fee, pricing.total]));
check('list items = cleaned items', eq(r.data[0].items, clean.items));
const listKeys = ['id', 'created_at', 'status', 'name', 'email', 'phone', 'event_type', 'event_date', 'fulfillment', 'time', 'address', 'items', 'allergies', 'notes', 'payment_method', 'subtotal', 'fee', 'total', 'initials', 'terms_accepted_at', 'client_info', 'square_invoice_id', 'square_invoice_url', 'deducted_at', 'orderNo'];
check('list key order like D1', eq(Object.keys(r.data[0]), listKeys), Object.keys(r.data[0]).join(','));

r = await api('GET', '/admin/orders/1');
check('order detail has signature + terms', r.status === 200 && r.data.signature === signature && r.data.terms_text === C.settingsWithDefaults({}).terms && r.data.orderNo === 1001 && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(r.data.created_at), r.text.slice(0, 200));
r = await api('GET', '/admin/orders/99');
check('missing order → 404', r.status === 404 && r.data.error === 'No such order');

r = await api('GET', '/admin/inventory');
check('inventory = core.js inventoryStatus', r.status === 200 && eq(r.data, { ...invBefore, shopping: C.shoppingList(invBefore.rows) }), r.text.slice(0, 300));
const needs = C.computeNeeds(clean.items, sample.recipes).needs;
check('reserved = computeNeeds', Object.entries(needs).every(([k, v]) => r.data.rows.find((x) => x.ingredient === k).reserved === v));

r = await api('POST', '/admin/orders/1/status', { status: 'Bogus' });
check('bad status → 400', r.status === 400 && r.data.error === 'Bad status');
r = await api('POST', '/admin/orders/1/status', { status: 'Done' });
check('Done → deducted:true', r.status === 200 && r.text === '{"ok":true,"deducted":true}', r.text);
let inv = (await api('GET', '/admin/tables/inventory')).data;
const expect = sample.inventory.map((i) => ({ ...i, on_hand: needs[i.ingredient] ? C.r3(i.on_hand - needs[i.ingredient]) : i.on_hand }));
check('on_hand decreased by needs', eq(inv, expect), JSON.stringify(inv.slice(0, 4)));
r = await api('POST', '/admin/orders/1/status', { status: 'Done' });
check('second Done → deducted:false', r.text === '{"ok":true,"deducted":false}', r.text);
check('on_hand unchanged after second Done', eq((await api('GET', '/admin/tables/inventory')).data, expect));
r = await api('GET', '/admin/inventory');
check('Done order no longer reserved', r.data.rows.every((x) => x.reserved === 0));

r = await api('GET', '/admin/tables/recipes');
check('GET recipes = sampleData', r.status === 200 && eq(r.data, sample.recipes));
const newRecipes = [{ recipe: ' Cake ', size: '6" round', ingredient: 'Flour', amount: '2.5 cups', notes: 'x' }, { recipe: '', ingredient: 'skip' }, { recipe: 'Pie', size: '', ingredient: 'Sugar', amount: 1 }];
r = await api('PUT', '/admin/tables/recipes', newRecipes);
check('PUT recipes → count 2', r.text === '{"ok":true,"count":2}', r.text);
r = await api('GET', '/admin/tables/recipes');
check('recipes round trip', eq(r.data, [{ recipe: 'Cake', size: '6" round', ingredient: 'Flour', amount: 2.5, notes: 'x' }, { recipe: 'Pie', size: '', ingredient: 'Sugar', amount: 1, notes: '' }]), r.text);
await api('PUT', '/admin/tables/recipes', sample.recipes);
check('recipes restored', eq((await api('GET', '/admin/tables/recipes')).data, sample.recipes));
r = await api('GET', '/admin/tables/nope');
check('unknown table → 404', r.status === 404 && r.data.error === 'No such table');

r = await api('GET', '/admin/settings');
check('GET settings shape', r.status === 200 && r.data.length === Object.keys(C.SETTINGS_DEFS).length && eq(Object.keys(r.data[0]), ['key', 'label', 'help', 'value']) && r.data[0].value === 'Sweet Creations');
r = await api('PUT', '/admin/settings', { business_name: 'Cakes by Dana', card_fee_pct: 4, junk: 'x' });
check('PUT settings ok', r.text === '{"ok":true}', r.text);
r = await api('GET', '/admin/settings');
check('settings saved', r.data.find((x) => x.key === 'business_name').value === 'Cakes by Dana' && r.data.find((x) => x.key === 'card_fee_pct').value === '4' && !r.data.some((x) => x.key === 'junk'));
r = await api('GET', '/config', undefined, null);
check('config reflects settings', r.data.businessName === 'Cakes by Dana' && r.data.cardFeePct === 4);

r = await api('GET', '/admin/info');
const key = (r.data.calendarUrl.match(/key=([0-9a-f]{32})$/) || [])[1];
check('/admin/info', r.status === 200 && r.data.calendarUrl === BASE + 'api.php?r=/calendar.ics&key=' + key && r.data.emailConfigured === false && r.data.squareConfigured === false && r.data.backend === 'GoDaddy', r.text);
check('calendar key stable', (await api('GET', '/admin/info')).data.calendarUrl === r.data.calendarUrl);

let c = await fetch(r.data.calendarUrl);
let ics = await c.text();
check('calendar.ics good key → 200 text/calendar VEVENT', c.status === 200 && /^text\/calendar/.test(c.headers.get('content-type')) && ics.includes('BEGIN:VEVENT') && ics.includes('✅ Delivery: Sarah Klein'), c.status + ' ' + ics.slice(0, 200));
c = await api('GET', '/calendar.ics', undefined, null, '&key=wrong');
check('calendar.ics wrong key → 403', c.status === 403 && c.data.error === 'Bad calendar key', c.text);

r = await api('POST', '/admin/weekly-email');
check('weekly-email disabled', r.status === 200 && r.data.sent === false && r.data.reason === 'Email is not set up on the server.' && r.data.html.includes('Shopping list'), r.text.slice(0, 200));
r = await api('GET', '/admin/square-test');
check('square-test without token → 400', r.status === 400 && r.data.error === 'Square is not connected (no access token on the server).');
r = await api('GET', '/nope', undefined, null);
check('unknown route → 404', r.status === 404 && r.data.error === 'Not found');

if (failed) { console.log(failed + ' check(s) FAILED'); process.exit(1); }
console.log('ALL OK');
EOF

echo "== cron.php"
ORDERS_CONFIG="$DIR/config.php" php "$ROOT/cron.php" && true; echo "(exit $? expected 1: email disabled)"
if grep -Eiq 'warning|notice|deprecated|fatal' "$DIR/server.log"; then echo "PHP warnings in server log:"; grep -Ei 'warning|notice|deprecated|fatal' "$DIR/server.log"; exit 1; fi
echo "no PHP warnings in server log"
