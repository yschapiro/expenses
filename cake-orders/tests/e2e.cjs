// End-to-end browser test of the whole flow:
//   prepare a private link → customer fills it in (flavors per tier, changes a quantity, adds an item, delivery zone)
//   → order needs review → can't confirm until reviewed → confirm → Done deducts inventory → payment → general form with tiers
//   → recipes editor, menu/zones, feedback, calendar feed, security checks.
// Usage: node tests/e2e.cjs <base-url-ending-in-slash> <admin-password> [screenshot-dir]
const { chromium } = require('playwright');
const assert = require('assert');
const zlib = require('zlib');
const BASE = process.argv[2], PW = process.argv[3], SHOTS = process.argv[4];
const ymd = (d) => d.toISOString().slice(0, 10);

function tinyPng() { // 40x30 solid plum PNG, built by hand so no files are needed
  const w = 40, h = 30, raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([156, 79, 150], y * (w * 3 + 1) + 1 + x * 3);
  const crc = (b) => { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    let r = 0xffffffff; for (const x of b) r = t[(r ^ x) & 255] ^ (r >>> 8); return (r ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function sign(p) {
  const box = await p.locator('#sig').boundingBox();
  await p.mouse.move(box.x + 30, box.y + 100); await p.mouse.down();
  await p.mouse.move(box.x + 120, box.y + 40, { steps: 10 }); await p.mouse.move(box.x + 220, box.y + 110, { steps: 10 }); await p.mouse.up();
}
const apiCall = (p, method, path, body, key) => p.evaluate(async ([m, pa, b, k]) => {
  try { return await (await import('./js/client.js')).call(m, pa, b, k); } catch (e) { return { __error: e.status + ' ' + e.message }; }
}, [method, path, body, key]);

(async () => {
  const b = await chromium.launch();
  const bctx = await b.newContext({ viewport: { width: 1200, height: 900 } });
  const p = await bctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  const shot = async (n, full = false) => SHOTS && p.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: full });

  // ── 1. You prepare a private order link ──
  await p.goto(BASE + 'admin.html');
  if (await p.isVisible('#login')) { await p.fill('#pw', PW); await p.click('#loginForm button'); }
  await p.waitForSelector('#prepBtn');
  await p.click('#prepBtn');
  await p.waitForSelector('#pName');
  await p.fill('#pName', 'Sarah Klein'); await p.fill('#pEmail', 'sarah@example.com'); await p.fill('#pPhone', '555-123-4567');
  await p.selectOption('#pType', 'Bar/Bat Mitzvah');
  await p.fill('#pDate', ymd(new Date(Date.now() + 2 * 86400000)));
  await p.fill('#pDesign', 'Navy & gold. Gold drip on top tier.\n"Mazel Tov Eli" in gold script.');
  await p.setInputFiles('#pFile', { name: 'sketch.png', mimeType: 'image/png', buffer: tinyPng() });
  await p.waitForSelector('#pThumbs img');
  const it1 = p.locator('.prep-item').nth(0);
  await it1.locator('[data-k=product]').selectOption('Cake');
  await it1.locator('[data-k=tiers]').fill('2');
  await it1.locator('.ptier').nth(1).waitFor();
  await it1.locator('.ptier').nth(0).locator('[data-k=tsize]').selectOption('10" round');
  await it1.locator('.ptier').nth(1).locator('[data-k=tsize]').selectOption('8" round');
  await it1.locator('[data-k=price]').fill('300');
  await it1.locator('[data-k=notes]').fill('Navy fondant');
  await p.click('#pAdd');
  const it2 = p.locator('.prep-item').nth(1);
  await it2.locator('[data-k=product]').selectOption('Cookies');
  await it2.locator('[data-k=qty]').fill('2');
  await it2.locator('[data-k=price]').fill('50');
  await shot('1-prepare', true);
  await p.click('#pSave');
  await p.waitForSelector('#custLink');
  const link = await p.inputValue('#custLink');
  console.log('customer link', link.replace(/[A-Za-z0-9]{20,}/, '…'));
  await shot('2-link');

  // ── 2. The customer opens it ──
  const c = await bctx.newPage(); // same browser profile (the demo keeps its data in the browser)
  await c.setViewportSize({ width: 420, height: 900 });
  c.on('pageerror', (e) => errs.push(e.message));
  await c.goto(link);
  await c.waitForSelector('#form:not(.hidden)');
  assert((await c.textContent('#designText')).includes('Mazel Tov Eli'), 'design summary shown');
  await c.waitForSelector('#gallery img');
  assert.strictEqual(await c.inputValue('#name'), 'Sarah Klein', 'name prefilled');
  const cake = c.locator('.item').nth(0);
  assert.strictEqual(await cake.locator('.tier').count(), 2, 'two tiers');
  await cake.locator('.tier').nth(0).locator('[data-k=choice1]').selectOption('Chocolate');
  await cake.locator('.tier').nth(0).locator('[data-k=choice2]').selectOption('Raspberry');
  await cake.locator('.tier').nth(1).locator('[data-k=choice1]').selectOption('Vanilla');
  await cake.locator('.tier').nth(1).locator('[data-k=choice2]').selectOption('Vanilla Buttercream');
  const cookies = c.locator('.item').nth(1);
  await cookies.locator('[data-k=choice1]').selectOption('Vanilla Sugar Cookie');
  await cookies.locator('[data-k=qty]').fill('3');
  await c.waitForSelector('.added-note');
  await c.click('#addItem');
  const extra = c.locator('.item.open').nth(0);
  const addable = await extra.locator('[data-k=product] option').allTextContents();
  assert(!addable.includes('Cake'), 'customers cannot add a cake themselves');
  await extra.locator('[data-k=product]').selectOption('Cake Pops'); await extra.locator('[data-k=size]').selectOption('1 dozen');
  await extra.locator('[data-k=choice1]').selectOption('Funfetti'); await extra.locator('[data-k=choice2]').selectOption('White Chocolate');
  await c.selectOption('#fulfillment', 'Delivery'); await c.fill('#address', '12 Main St, New York'); await c.fill('#zip', '10023'); await c.fill('#time', '15:00');
  await c.waitForSelector('.zone-ok');
  assert((await c.textContent('#zoneInfo')).includes('Manhattan'), 'zone from zip');
  await c.selectOption('#paymentMethod', 'Credit card');
  const totals = await c.textContent('#totals');
  // 300 + 3×50 + 72 (cake pops minimum) + 85 delivery = 607; card 3.5% = 21.25 → 628.25
  assert(totals.includes('$628.25'), 'running total: ' + totals);
  await c.fill('#allergies', 'Sesame');
  await c.check('#agree'); await c.fill('#initials', 'SK'); await sign(c);
  if (SHOTS) await c.screenshot({ path: `${SHOTS}/3-customer.png`, fullPage: true });
  await c.click('#submit');
  await c.waitForSelector('#thanks:not(.hidden), #error:not(.hidden)', { timeout: 15000 });
  assert(await c.isVisible('#thanks'), 'submit failed: ' + await c.textContent('#error'));
  console.log('submitted', (await c.textContent('#orderNo')).trim());
  await c.goto('about:blank'); await c.goto(link); await c.waitForSelector('#thanks:not(.hidden)');
  assert((await c.textContent('#thanks')).includes('already have your order'), 'link can only be used once');

  // ── 3. You review, confirm, bake, finish ──
  await p.goto(BASE + 'admin.html#orders'); await p.reload();
  await p.waitForSelector('.orow');
  await p.locator('.orow', { hasText: 'Sarah Klein' }).click();
  await p.waitForSelector('#reviewBox');
  const review = await p.textContent('#reviewBox');
  assert(review.includes('from 2 to 3') && review.includes('Cake Pops'), 'changes listed: ' + review);
  const panel = await p.textContent('#panel');
  assert(panel.includes('$607.00 + $21.25 card fee') || panel.includes('= $628.25'), 'price in dashboard');
  await shot('4-review');
  await p.selectOption('#status', 'Confirmed');
  await p.waitForFunction(() => /⚠/.test(document.getElementById('statusMsg').textContent));
  assert((await p.textContent('#statusMsg')).includes('Changes reviewed'), 'cannot confirm before review');
  await p.click('#reviewed');
  await p.waitForSelector('#status'); await p.waitForTimeout(300);
  assert(!(await p.isVisible('#reviewBox')), 'review box gone');
  const inv0 = await apiCall(p, 'GET', '/admin/tables/inventory', null, PW);
  await p.selectOption('#status', 'Confirmed'); await p.waitForFunction(() => /Saved/.test(document.getElementById('statusMsg').textContent));
  await p.selectOption('#status', 'Baked'); await p.waitForFunction(() => /Saved/.test(document.getElementById('statusMsg').textContent));
  await p.selectOption('#status', 'Done'); await p.waitForFunction(() => /ingredients/.test(document.getElementById('statusMsg').textContent));
  await p.selectOption('#payment', 'Paid'); await p.waitForFunction(() => /Payment saved/.test(document.getElementById('statusMsg').textContent));
  const inv1 = await apiCall(p, 'GET', '/admin/tables/inventory', null, PW);
  const eggs = (inv) => inv.find((r) => r.ingredient === 'Eggs').on_hand;
  // 10" chocolate 4.8 + 8" vanilla 4 + 3 dz cookies 3 + 1 dz funfetti pops 1.6 = 13.4 eggs
  console.log('eggs', eggs(inv0), '->', eggs(inv1));
  assert.strictEqual(Math.round((eggs(inv0) - eggs(inv1)) * 10) / 10, 13.4, 'eggs deducted for tiers + extras');

  // ── 4. General form (no link) with a 3-tier cake ──
  await c.goto(BASE + 'index.html');
  await c.waitForSelector('#form:not(.hidden)');
  await c.fill('#name', 'Walk In'); await c.fill('#email', 'walk@example.com'); await c.fill('#phone', '5551112222');
  await c.fill('#eventDate', ymd(new Date(Date.now() + 9 * 86400000))); await c.selectOption('#fulfillment', 'Pickup');
  const g = c.locator('.item').nth(0);
  await g.locator('[data-k=product]').selectOption('Cake');
  await g.locator('[data-k=tiercount]').selectOption('3');
  for (let k = 0; k < 3; k++) {
    const t = g.locator('.tier').nth(k);
    await t.locator('[data-k=tsize]').selectOption(['10" round', '8" round', '6" round'][k]);
    await t.locator('[data-k=choice1]').selectOption('Chocolate'); await t.locator('[data-k=choice2]').selectOption('Raspberry');
  }
  await c.selectOption('#paymentMethod', 'Zelle');
  await c.check('#agree'); await c.fill('#initials', 'WI'); await sign(c);
  await c.click('#submit');
  await c.waitForSelector('#thanks:not(.hidden)', { timeout: 15000 });
  const all = await apiCall(p, 'GET', '/admin/orders', null, PW);
  const walk = all.find((o) => o.name === 'Walk In');
  assert(walk && walk.items[0].tiers.length === 3, 'general-form tiered cake saved');

  // ── 5. Recipes editor, menu & zones, issues list ──
  await p.goto(BASE + 'admin.html#recipes'); await p.reload();
  await p.waitForSelector('.rname');
  await p.locator('.rname', { hasText: 'Chocolate' }).first().click();
  await p.waitForSelector('#recT tbody tr');
  const eggsCell = p.locator('#recT tbody tr', { has: p.locator('input[value="Eggs"]') }).locator('input[data-s="8\\" round"]');
  await eggsCell.fill('3.5');
  await p.click('#saveRec'); await p.waitForSelector('#recMsg .ok');
  const rec = await apiCall(p, 'GET', '/admin/tables/recipes', null, PW);
  assert.strictEqual(rec.find((r) => r.recipe === 'Chocolate' && r.size === '8" round' && r.ingredient === 'Eggs').amount, 3.5, 'recipe saved');
  await shot('5-recipes');
  await p.goto(BASE + 'admin.html#menu'); await p.reload(); await p.waitForSelector('#zon tbody tr');
  const fb = await apiCall(p, 'POST', '/admin/feedback', { note: 'Please move the allergies box higher', page: 'index.html' }, PW);
  assert(fb.id, 'feedback saved');
  await p.goto(BASE + 'admin.html#feedback'); await p.reload(); await p.waitForSelector('.fb');
  assert((await p.textContent('main')).includes('allergies box'), 'feedback listed');
  assert(await p.isVisible('#reportBtn'), 'report button on dashboard');

  // ── 6. Calendar feed (real server only) & security ──
  await p.goto(BASE + 'admin.html#calendar'); await p.reload(); await p.waitForSelector('#main .card');
  const calUrl = await p.locator('#calUrl').inputValue().catch(() => '');
  if (calUrl) {
    const r = await p.request.get(calUrl); assert.strictEqual(r.status(), 200);
    assert((await r.text()).includes('Sarah Klein'), 'ics has order');
    assert.strictEqual((await p.request.get(calUrl.replace(/key=[^&]+/, 'key=nope'))).status(), 403);
    console.log('calendar feed ok');
  }
  const bad = await apiCall(p, 'POST', '/orders', { name: 'x' });
  assert(/^400 /.test(bad.__error), 'bad order rejected');
  assert(/^401 /.test((await apiCall(p, 'GET', '/admin/orders', null, 'wrong')).__error), 'wrong password rejected');
  const forged = await apiCall(p, 'GET', '/order/notarealtoken1234567890', null);
  assert(/^404 /.test(forged.__error), 'unknown link rejected');

  assert.deepStrictEqual(errs, [], 'no page errors');
  await b.close();
  console.log('E2E OK');
})().catch((e) => { console.error(e); process.exit(1); });
