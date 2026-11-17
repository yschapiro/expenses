// End-to-end browser test: customer form → dashboard → status Done → inventory → calendar → settings.
// Usage: node tests/e2e.cjs <base-url-ending-in-slash> <admin-password> [screenshot-dir]
const { chromium } = require('playwright');
const assert = require('assert');
const BASE = process.argv[2], PW = process.argv[3], SHOTS = process.argv[4];
const ymd = (d) => d.toISOString().slice(0, 10);

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 420, height: 900 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('dialog', (d) => d.accept());
  const shot = async (n, full = true) => SHOTS && p.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: full });

  // 1. Customer form
  await p.goto(BASE + 'index.html');
  await p.waitForSelector('#form:not(.hidden)');
  const date = ymd(new Date(Date.now() + 2 * 86400000));
  await p.fill('#name', 'Sarah Klein'); await p.fill('#email', 'sarah@example.com'); await p.fill('#phone', '(555) 123-4567');
  await p.selectOption('#eventType', 'Bar/Bat Mitzvah'); await p.fill('#eventDate', date);
  await p.selectOption('#fulfillment', 'Delivery'); await p.fill('#address', '12 Main St'); await p.fill('#time', '15:00');
  const it = p.locator('.item').nth(0);
  await it.locator('[data-k=product]').selectOption('Cake'); await it.locator('[data-k=size]').selectOption('8" round');
  await it.locator('[data-k=choice1]').selectOption('Chocolate'); await it.locator('[data-k=choice2]').selectOption('Raspberry');
  await it.locator('[data-k=notes]').fill('Navy & gold, "Mazel Tov Eli"');
  await p.click('#addItem');
  const it2 = p.locator('.item').nth(1);
  await it2.locator('[data-k=product]').selectOption('Cookies'); await it2.locator('[data-k=size]').selectOption('1 dozen');
  await it2.locator('[data-k=choice1]').selectOption('Vanilla Sugar Cookie'); await it2.locator('[data-k=qty]').fill('3');
  await p.fill('#allergies', 'Sesame');
  await p.selectOption('#paymentMethod', 'Credit card');
  assert(await p.isDisabled('#submit'), 'submit locked before agreeing');
  await p.check('#agree'); await p.fill('#initials', 'SK');
  assert(await p.isDisabled('#submit'), 'submit locked before signature');
  const box = await p.locator('#sig').boundingBox();
  await p.mouse.move(box.x + 30, box.y + 100); await p.mouse.down();
  await p.mouse.move(box.x + 120, box.y + 40, { steps: 10 }); await p.mouse.move(box.x + 220, box.y + 110, { steps: 10 }); await p.mouse.up();
  assert(!(await p.isDisabled('#submit')), 'submit unlocked');
  await shot('1-form');
  await p.click('#submit');
  await p.waitForSelector('#thanks:not(.hidden)', { timeout: 15000 });
  const orderText = await p.textContent('#orderNo');
  console.log('submitted', orderText.trim());
  assert(/#\d{4}/.test(orderText));

  // 2. Dashboard
  await p.setViewportSize({ width: 1200, height: 900 });
  await p.goto(BASE + 'admin.html');
  if (await p.isVisible('#login')) { await p.fill('#pw', PW); await p.click('#loginForm button'); }
  await p.waitForSelector('.orow');
  assert((await p.textContent('#olist')).includes('Sarah Klein'));
  await shot('2-dashboard', false);
  await p.locator('.orow', { hasText: 'Sarah Klein' }).click();
  await p.waitForSelector('#status');
  assert(await p.isVisible('img.sigimg'), 'signature shown');
  const panel = await p.textContent('#panel');
  assert(panel.includes('$264.00 + $9.24 card fee = $273.24'), 'pricing in panel');
  assert(panel.includes('Sesame'));
  await shot('3-order', false);

  // inventory before
  const invBefore = await p.evaluate(async ([pw]) => (await import('./js/client.js')).call('GET', '/admin/tables/inventory', null, pw), [PW]);
  const eggs0 = invBefore.find((r) => r.ingredient === 'Eggs').on_hand;
  await p.selectOption('#status', 'Done');
  await p.waitForFunction(() => /Saved/.test(document.getElementById('statusMsg').textContent));
  assert((await p.textContent('#statusMsg')).includes('ingredients'), 'deducted message');
  // second Done should not deduct again
  await p.selectOption('#status', 'Confirmed'); await p.waitForFunction(() => /Saved/.test(document.getElementById('statusMsg').textContent));
  await p.selectOption('#status', 'Done'); await p.waitForFunction(() => /Saved/.test(document.getElementById('statusMsg').textContent));
  const invAfter = await p.evaluate(async ([pw]) => (await import('./js/client.js')).call('GET', '/admin/tables/inventory', null, pw), [PW]);
  const eggs1 = invAfter.find((r) => r.ingredient === 'Eggs').on_hand;
  console.log('eggs', eggs0, '->', eggs1);
  assert.strictEqual(eggs0 - eggs1, 6, 'eggs deducted exactly once (3 cake + 3 dozen cookies)');

  // 3. Inventory tab
  await p.goto(BASE + 'admin.html#inventory');
  await p.waitForSelector('#invTable tbody tr');
  await shot('4-inventory', false);
  // edit on-hand and save
  const flourInput = p.locator('#invTable tbody tr', { has: p.locator('input[value="Flour"]') }).locator('[data-k=on_hand]');
  await flourInput.fill('2'); await p.click('#saveInv');
  await p.waitForFunction(() => document.querySelectorAll('#invTable tbody tr').length > 0 && /Flour/.test(document.body.innerText));
  await p.waitForTimeout(500);
  assert((await p.textContent('main')).includes('Flour'), 'shopping list mentions flour after setting it low');

  // 4. Calendar
  await p.goto(BASE + 'admin.html#calendar');
  await p.waitForSelector('#main .card');
  const calUrl = await p.locator('#calUrl').inputValue().catch(() => '');
  if (calUrl) {
    const r = await p.request.get(calUrl);
    assert.strictEqual(r.status(), 200);
    const ics = await r.text();
    assert(ics.includes('BEGIN:VEVENT') && ics.includes('Sarah Klein'), 'ics feed has order');
    const bad = await p.request.get(calUrl.replace(/key=[^&]+/, 'key=nope'));
    assert.strictEqual(bad.status(), 403);
    console.log('calendar feed ok');
  }

  // 5. Settings → form shows new name
  await p.goto(BASE + 'admin.html#settings');
  await p.waitForSelector('#s-business_name');
  await p.fill('#s-business_name', 'Test Bakery'); await p.click('#saveSet');
  await p.waitForSelector('#setMsg .ok');
  await p.goto(BASE + 'index.html');
  await p.waitForFunction(() => document.getElementById('biz').textContent === 'Test Bakery');

  // 6. Recipes + Menu render
  await p.goto(BASE + 'admin.html#recipes'); await p.waitForSelector('#rec tbody tr');
  await p.goto(BASE + 'admin.html#menu'); await p.waitForSelector('#prod tbody tr');

  // 7. API rejects bad input / wrong password
  const bad = await p.evaluate(async () => { try { await (await import('./js/client.js')).call('POST', '/orders', { name: 'x' }); return 'no error'; } catch (e) { return e.status + ' ' + e.message; } });
  assert(/^400 /.test(bad), 'bad order rejected: ' + bad);
  const unauth = await p.evaluate(async () => { try { await (await import('./js/client.js')).call('GET', '/admin/orders', null, 'wrong'); return 'no error'; } catch (e) { return e.status; } });
  assert.strictEqual(unauth, 401);

  assert.deepStrictEqual(errs, [], 'no page errors');
  await b.close();
  console.log('E2E OK');
})().catch((e) => { console.error(e); process.exit(1); });
