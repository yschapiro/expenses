/**
 * Custom Dessert Order System (Google Apps Script)
 * ------------------------------------------------
 * Lives inside one Google Sheet. It:
 *   1. Serves the customer order form (a web link you send to customers)
 *   2. Saves each order to the "Orders" tab with a clean summary
 *   3. Puts the order on your Google Calendar
 *   4. Drafts a Square invoice (adds the credit-card fee when card is chosen)
 *   5. Works out the ingredients from your "Recipes" tab, checks "Inventory",
 *      and emails you right away if a new order leaves you short
 *   6. Emails you a shopping list every Sunday morning
 *
 * Tabs it uses: Orders, Products, Flavors, Recipes, Inventory, Settings.
 * See README.md for the step-by-step setup.
 */

// ───────────────────────── Constants ─────────────────────────

var SHEETS = {
  ORDERS: 'Orders',
  PRODUCTS: 'Products',
  FLAVORS: 'Flavors',
  RECIPES: 'Recipes',
  INVENTORY: 'Inventory',
  SETTINGS: 'Settings'
};

var ORDER_HEADERS = [
  'Order #', 'Submitted', 'Status', 'Customer', 'Email', 'Phone',
  'Event Type', 'Event Date', 'Pickup / Delivery', 'Time', 'Delivery Address',
  'Items', 'Allergies', 'Notes', 'Payment Method',
  'Subtotal', 'Card Fee', 'Total', 'Initials', 'Terms Accepted',
  'Signed Copy', 'Calendar Event', 'Square Invoice', 'Inventory Deducted', 'Items Data'
];

var STATUS = { NEW: 'New', CONFIRMED: 'Confirmed', DONE: 'Done', CANCELLED: 'Cancelled' };
var OPEN_STATUSES = [STATUS.NEW, STATUS.CONFIRMED];

var SQUARE_VERSION = '2024-10-17';

// ───────────────────────── Web form ─────────────────────────

/** Serves the customer order form. */
function doGet() {
  var cfg = getFormConfig_();
  var t = HtmlService.createTemplateFromFile('Form');
  // Escape "<" so nothing in your settings can break out of the <script> tag.
  t.configJson = JSON.stringify(cfg).replace(/</g, '\\u003c');
  return t.evaluate()
    .setTitle(cfg.businessName + ' – Order Form')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL); // lets you embed it on a website
}

function getFormConfig_() {
  var s = getSettings_();
  var products = readTable_(SHEETS.PRODUCTS).filter(function (r) { return r['Product'] && r['Size / Option']; });
  var flavors = readTable_(SHEETS.FLAVORS).filter(function (r) { return r['List'] && r['Choice']; });
  var lists = {};
  flavors.forEach(function (r) {
    var k = String(r['List']).trim();
    (lists[k] = lists[k] || []).push(String(r['Choice']).trim());
  });
  return {
    businessName: s['Business Name'] || 'Custom Desserts',
    eventTypes: splitList_(s['Event Types']),
    paymentMethods: splitList_(s['Payment Methods']),
    cardMethod: String(s['Card Fee Applies To'] || '').trim(),
    cardFeePct: toNumber_(s['Card Fee %']),
    terms: String(s['Terms & Conditions'] || ''),
    products: products.map(function (r) {
      return {
        product: String(r['Product']).trim(),
        size: String(r['Size / Option']).trim(),
        choice1: String(r['Choice 1 List'] || '').trim(),
        choice2: String(r['Choice 2 List'] || '').trim()
      };
    }),
    lists: lists
  };
}

/**
 * Called by the form when the customer presses Submit.
 * @param {Object} f form payload (see Form.html → collect())
 */
function submitOrder(f) {
  validateOrder_(f);
  var s = getSettings_();
  var catalog = readTable_(SHEETS.PRODUCTS);
  var pricing = priceOrder_(f.items, catalog, f.paymentMethod, s['Card Fee Applies To'], toNumber_(s['Card Fee %']));

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  var orderNo, rowIndex, ordersSheet;
  try {
    ordersSheet = getSheet_(SHEETS.ORDERS);
    orderNo = nextOrderNumber_(ordersSheet);
    var now = new Date();
    var row = {
      'Order #': orderNo,
      'Submitted': now,
      'Status': STATUS.NEW,
      'Customer': f.name,
      'Email': f.email,
      'Phone': f.phone,
      'Event Type': f.eventType,
      'Event Date': f.eventDate,
      'Pickup / Delivery': f.fulfillment,
      'Time': f.time,
      'Delivery Address': f.address || '',
      'Items': itemsSummary_(f.items),
      'Allergies': f.allergies || '',
      'Notes': f.notes || '',
      'Payment Method': f.paymentMethod,
      'Subtotal': pricing.subtotal,
      'Card Fee': pricing.fee,
      'Total': pricing.total,
      'Initials': f.initials,
      'Terms Accepted': now,
      'Inventory Deducted': '',
      'Items Data': JSON.stringify(f.items)
    };
    ordersSheet.appendRow(ORDER_HEADERS.map(function (h) { return row[h] === undefined ? '' : row[h]; }));
    rowIndex = ordersSheet.getLastRow();
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }

  var order = { orderNo: orderNo, f: f, pricing: pricing };
  var results = {};
  var problems = [];

  // Each step is independent: if one fails, the others still happen and you get told.
  step_('Signed copy', problems, function () {
    var signed = saveSignedCopy_(order, s);
    results.signedUrl = signed.url;
    results.signedBlob = signed.pdf;
    setCell_(ordersSheet, rowIndex, 'Signed Copy', signed.url);
  });
  step_('Calendar', problems, function () {
    var ev = createCalendarEvent_(order, s);
    results.calendarUrl = ev.url;
    setCell_(ordersSheet, rowIndex, 'Calendar Event', ev.id);
  });
  step_('Square invoice', problems, function () {
    var inv = createSquareDraftInvoice_(order, s);
    if (inv) {
      results.invoiceUrl = inv.url;
      setCell_(ordersSheet, rowIndex, 'Square Invoice', inv.url);
    } else {
      problems.push('Square invoice: Square is not connected yet (see README step 5), so no draft was made.');
    }
  });
  var inv;
  step_('Inventory', problems, function () {
    inv = recalculateInventory();
    results.shortages = shortagesForOrder_(f.items, inv);
  });

  step_('Email to you', problems, function () { emailOwnerNewOrder_(order, results, problems, s); });
  if (yes_(s['Send Customer A Copy'])) {
    step_('Customer copy', problems, function () { emailCustomerCopy_(order, results, s); });
  }
  return { orderNo: orderNo };
}

function validateOrder_(f) {
  var need = ['name', 'email', 'phone', 'eventDate', 'fulfillment', 'paymentMethod', 'initials', 'signature'];
  need.forEach(function (k) {
    if (!f || !String(f[k] || '').trim()) throw new Error('Please fill in: ' + k);
  });
  if (f.agreed !== true) throw new Error('You must agree to the terms and conditions.');
  if (!/^data:image\/png;base64,/.test(f.signature)) throw new Error('Signature is missing.');
  if (!f.items || !f.items.length) throw new Error('Please add at least one item.');
  f.items.forEach(function (it) {
    it.qty = Math.max(1, Math.round(toNumber_(it.qty) || 1));
  });
}

function step_(label, problems, fn) {
  try { fn(); } catch (e) {
    console.error(label + ': ' + (e && e.stack || e));
    problems.push(label + ': ' + (e && e.message || e));
  }
}

// ───────────────────────── Pricing ─────────────────────────

/** Pure function: prices each item from the Products tab and adds the card fee if needed. */
function priceOrder_(items, catalog, paymentMethod, cardMethod, feePct) {
  var lines = items.map(function (it) {
    var row = findProduct_(catalog, it.product, it.size);
    var unit = row ? toNumber_(row['Starting Price']) : 0;
    return { item: it, unitPrice: unit, amount: round2_(unit * it.qty) };
  });
  var subtotal = round2_(lines.reduce(function (a, l) { return a + l.amount; }, 0));
  var isCard = !!cardMethod && norm_(paymentMethod) === norm_(cardMethod);
  var fee = isCard ? round2_(subtotal * (feePct || 0) / 100) : 0;
  return { lines: lines, subtotal: subtotal, fee: fee, feePct: isCard ? feePct : 0, total: round2_(subtotal + fee) };
}

function findProduct_(catalog, product, size) {
  for (var i = 0; i < catalog.length; i++) {
    if (norm_(catalog[i]['Product']) === norm_(product) && norm_(catalog[i]['Size / Option']) === norm_(size)) return catalog[i];
  }
  return null;
}

// ───────────────────────── Ingredients & inventory ─────────────────────────

/**
 * Pure function: turns order items into ingredient amounts using the Recipes tab.
 * For each item it adds up the recipe rows for:
 *   - the product itself (e.g. "Cake" → boards & boxes), and
 *   - each choice the customer picked (e.g. "Chocolate", "Raspberry"),
 * at that item's size. A recipe row with a blank Size applies to every size.
 * Everything is multiplied by the item's quantity.
 */
function computeNeeds_(items, recipes) {
  var index = {};
  recipes.forEach(function (r) {
    if (!r['Recipe'] || !r['Ingredient']) return;
    var key = norm_(r['Recipe']) + '|' + norm_(r['Size'] || '*');
    (index[key] = index[key] || []).push(r);
  });
  var needs = {};
  var missing = [];
  items.forEach(function (it) {
    var parts = [it.product, it.choice1, it.choice2].filter(function (x) { return x && String(x).trim(); });
    parts.forEach(function (name, i) {
      var rows = (index[norm_(name) + '|' + norm_(it.size)] || []).concat(index[norm_(name) + '|*'] || []);
      if (!rows.length && i > 0) missing.push(name + ' (' + it.size + ')');
      rows.forEach(function (r) {
        var ing = String(r['Ingredient']).trim();
        needs[ing] = round3_((needs[ing] || 0) + toNumber_(r['Amount']) * (it.qty || 1));
      });
    });
  });
  return { needs: needs, missing: missing };
}

/**
 * Re-adds up what every open order (New / Confirmed) needs, and writes
 * "Reserved for Orders" and "Left After Orders" on the Inventory tab.
 * Safe to run any time (also available from the 🎂 Orders menu).
 */
function recalculateInventory() {
  var recipes = readTable_(SHEETS.RECIPES);
  var orders = readTable_(SHEETS.ORDERS);
  var reserved = {};
  var missing = [];
  orders.forEach(function (o) {
    if (OPEN_STATUSES.indexOf(String(o['Status']).trim()) < 0) return;
    var items = parseItems_(o['Items Data']);
    var r = computeNeeds_(items, recipes);
    Object.keys(r.needs).forEach(function (k) { reserved[norm_(k)] = round3_((reserved[norm_(k)] || 0) + r.needs[k]); });
    r.missing.forEach(function (m) { if (missing.indexOf(m) < 0) missing.push(m); });
  });

  var sh = getSheet_(SHEETS.INVENTORY);
  var data = sh.getDataRange().getValues();
  var h = headerMap_(data[0]);
  var known = {};
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    var name = String(data[i][h['Ingredient']] || '').trim();
    if (!name) continue;
    known[norm_(name)] = true;
    var onHand = toNumber_(data[i][h['On Hand']]);
    var res = reserved[norm_(name)] || 0;
    var left = round3_(onHand - res);
    sh.getRange(i + 1, h['Reserved for Orders'] + 1, 1, 2).setValues([[res, left]]);
    rows.push({
      ingredient: name, unit: data[i][h['Unit']], onHand: onHand, reserved: res, left: left,
      keepAtLeast: toNumber_(data[i][h['Keep At Least']])
    });
  }
  var unknown = Object.keys(reserved).filter(function (k) { return !known[k]; });
  return { rows: rows, unknownIngredients: unknown, missingRecipes: missing };
}

/** Which ingredients this order uses that you don't have enough of. */
function shortagesForOrder_(items, inv) {
  var used = computeNeeds_(items, readTable_(SHEETS.RECIPES));
  var out = { short: [], low: [], missingRecipes: used.missing, unknownIngredients: [] };
  var byName = {};
  inv.rows.forEach(function (r) { byName[norm_(r.ingredient)] = r; });
  Object.keys(used.needs).forEach(function (ing) {
    var r = byName[norm_(ing)];
    if (!r) { out.unknownIngredients.push(ing); return; }
    if (r.left < 0) out.short.push(r);
    else if (r.keepAtLeast && r.left < r.keepAtLeast) out.low.push(r);
  });
  return out;
}

/** Pure function: what to buy so every ingredient is back to its "Keep At Least" level. */
function buildShoppingList_(invRows) {
  return invRows.map(function (r) {
    var target = Math.max(r.keepAtLeast || 0, 0);
    var buy = round3_(target - r.left);
    return buy > 0 ? { ingredient: r.ingredient, unit: r.unit, buy: buy, left: r.left } : null;
  }).filter(Boolean);
}

/** When an order is marked Done, take its ingredients out of "On Hand" (once). */
function deductOrderFromInventory_(itemsData) {
  var used = computeNeeds_(parseItems_(itemsData), readTable_(SHEETS.RECIPES)).needs;
  var sh = getSheet_(SHEETS.INVENTORY);
  var data = sh.getDataRange().getValues();
  var h = headerMap_(data[0]);
  for (var i = 1; i < data.length; i++) {
    var name = norm_(data[i][h['Ingredient']]);
    Object.keys(used).forEach(function (ing) {
      if (norm_(ing) === name) {
        sh.getRange(i + 1, h['On Hand'] + 1).setValue(round3_(toNumber_(data[i][h['On Hand']]) - used[ing]));
      }
    });
  }
}

// ───────────────────────── Status changes (installable onEdit) ─────────────────────────

function onStatusEdit(e) {
  if (!e || !e.range) return;
  var sh = e.range.getSheet();
  if (sh.getName() !== SHEETS.ORDERS || e.range.getRow() < 2) return;
  var h = headerMap_(sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]);
  if (e.range.getColumn() !== h['Status'] + 1 || e.range.getNumRows() !== 1) return;

  var rowNo = e.range.getRow();
  var row = sh.getRange(rowNo, 1, 1, sh.getLastColumn()).getValues()[0];
  var status = String(row[h['Status']]).trim();
  var s = getSettings_();

  if (status === STATUS.DONE && !row[h['Inventory Deducted']]) {
    deductOrderFromInventory_(row[h['Items Data']]);
    sh.getRange(rowNo, h['Inventory Deducted'] + 1).setValue(new Date());
  }
  try {
    var cal = getCalendar_(s);
    var ev = row[h['Calendar Event']] ? cal.getEventById(row[h['Calendar Event']]) : null;
    if (ev) {
      var title = ev.getTitle().replace(/^(❌ CANCELLED – |⏳ )/, '');
      if (status === STATUS.CANCELLED) { ev.setTitle('❌ CANCELLED – ' + title); ev.setColor(CalendarApp.EventColor.GRAY); }
      else if (status === STATUS.NEW) { ev.setTitle('⏳ ' + title); ev.setColor(CalendarApp.EventColor.GRAY); }
      else { ev.setTitle(title); ev.setColor(CalendarApp.EventColor.GREEN); }
    }
  } catch (err) { console.error(err); }
  recalculateInventory();
}

// ───────────────────────── Calendar ─────────────────────────

function createCalendarEvent_(order, s) {
  var f = order.f;
  var cal = getCalendar_(s);
  var tz = Session.getScriptTimeZone();
  var title = '⏳ ' + (f.fulfillment || 'Pickup') + ': ' + f.name + ' – ' + shortItems_(f.items);
  var desc = plainSummary_(order);
  var ev;
  if (f.time) {
    var start = Utilities.parseDate(f.eventDate + ' ' + f.time, 'yyyy-MM-dd HH:mm', tz);
    var mins = toNumber_(s['Calendar Event Minutes']) || 30;
    ev = cal.createEvent(title, start, new Date(start.getTime() + mins * 60000), { description: desc, location: f.address || '' });
  } else {
    ev = cal.createAllDayEvent(title, Utilities.parseDate(f.eventDate, 'yyyy-MM-dd', tz), { description: desc });
  }
  ev.setColor(CalendarApp.EventColor.GRAY); // gray = not confirmed yet; turns green when you set status to Confirmed
  return { id: ev.getId(), url: 'https://calendar.google.com/calendar/r/day/' + f.eventDate.replace(/-/g, '/') };
}

function getCalendar_(s) {
  var id = String(s['Calendar ID'] || '').trim();
  return id ? CalendarApp.getCalendarById(id) : CalendarApp.getDefaultCalendar();
}

// ───────────────────────── Square ─────────────────────────

function squareBase_(s) {
  return /sandbox/i.test(String(s['Square Environment'] || '')) ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com';
}

function squareCall_(s, method, path, body) {
  var token = PropertiesService.getScriptProperties().getProperty('SQUARE_ACCESS_TOKEN');
  if (!token) return null;
  var res = UrlFetchApp.fetch(squareBase_(s) + path, {
    method: method,
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token, 'Square-Version': SQUARE_VERSION },
    payload: body ? JSON.stringify(body) : undefined,
    muteHttpExceptions: true
  });
  var json = JSON.parse(res.getContentText() || '{}');
  if (res.getResponseCode() >= 300) {
    var msg = (json.errors || []).map(function (e) { return e.detail || e.code; }).join('; ');
    throw new Error('Square said: ' + (msg || res.getResponseCode()));
  }
  return json;
}

/** Creates (or finds) the customer, an order with the line items + card fee, and a DRAFT invoice. */
function createSquareDraftInvoice_(order, s) {
  if (!PropertiesService.getScriptProperties().getProperty('SQUARE_ACCESS_TOKEN')) return null;
  var locationId = String(s['Square Location ID'] || '').trim();
  if (!locationId) throw new Error('Add your Square Location ID on the Settings tab (menu: 🎂 Orders → Test Square connection shows it).');
  var f = order.f;

  var customerId = findOrCreateSquareCustomer_(s, f);
  var body = buildSquareOrderBody_(order, locationId, customerId, s);
  var o = squareCall_(s, 'post', '/v2/orders', body);

  var invBody = buildSquareInvoiceBody_(order, locationId, customerId, o.order.id, s);
  var inv = squareCall_(s, 'post', '/v2/invoices', invBody);
  var dashHost = /sandbox/i.test(String(s['Square Environment'] || '')) ? 'https://app.squareupsandbox.com' : 'https://app.squareup.com';
  return { id: inv.invoice.id, url: dashHost + '/dashboard/invoices/' + inv.invoice.id };
}

/** Pure function: Square order body. */
function buildSquareOrderBody_(order, locationId, customerId, s) {
  var p = order.pricing;
  var lineItems = p.lines.map(function (l) {
    var it = l.item;
    var name = [it.size, it.product].join(' ') + (it.choice1 || it.choice2 ? ' – ' + [it.choice1, it.choice2].filter(Boolean).join(' / ') : '');
    var li = {
      name: name.slice(0, 500),
      quantity: String(it.qty),
      base_price_money: { amount: Math.round(l.unitPrice * 100), currency: String(s['Currency'] || 'USD') }
    };
    if (it.notes) li.note = String(it.notes).slice(0, 2000);
    return li;
  });
  var body = {
    idempotency_key: 'order-' + order.orderNo + '-' + Utilities.getUuid(),
    order: {
      location_id: locationId,
      customer_id: customerId,
      reference_id: String(order.orderNo),
      line_items: lineItems
    }
  };
  if (p.fee > 0) {
    body.order.service_charges = [{
      name: 'Credit card fee (' + p.feePct + '%)',
      percentage: String(p.feePct),
      calculation_phase: 'SUBTOTAL_PHASE'
    }];
  }
  return body;
}

/** Pure function: Square draft invoice body (not sent to the customer until you press Send in Square). */
function buildSquareInvoiceBody_(order, locationId, customerId, orderId, s) {
  var f = order.f;
  var daysBefore = toNumber_(s['Invoice Due Days Before Event']);
  var due = new Date(f.eventDate + 'T12:00:00');
  due.setDate(due.getDate() - (isNaN(daysBefore) ? 7 : daysBefore));
  var today = new Date(); today.setHours(0, 0, 0, 0);
  if (due < today) due = today;
  var dueStr = due.getFullYear() + '-' + pad2_(due.getMonth() + 1) + '-' + pad2_(due.getDate());
  return {
    idempotency_key: 'inv-' + order.orderNo + '-' + Utilities.getUuid(),
    invoice: {
      location_id: locationId,
      order_id: orderId,
      primary_recipient: { customer_id: customerId },
      payment_requests: [{ request_type: 'BALANCE', due_date: dueStr }],
      delivery_method: 'EMAIL',
      accepted_payment_methods: { card: true, square_gift_card: false, bank_account: false, buy_now_pay_later: false, cash_app_pay: false },
      invoice_number: String(order.orderNo),
      title: (f.eventType ? f.eventType + ' – ' : '') + 'Order #' + order.orderNo,
      description: ('Event date: ' + f.eventDate + (f.time ? ' ' + f.time : '') + ' (' + f.fulfillment + ')\n' +
        'Payment method chosen: ' + f.paymentMethod).slice(0, 65536)
    }
  };
}

function findOrCreateSquareCustomer_(s, f) {
  var found = squareCall_(s, 'post', '/v2/customers/search', {
    query: { filter: { email_address: { exact: f.email } } }, limit: 1
  });
  if (found && found.customers && found.customers.length) return found.customers[0].id;
  var parts = String(f.name).trim().split(/\s+/);
  var body = {
    idempotency_key: Utilities.getUuid(),
    given_name: parts[0],
    family_name: parts.slice(1).join(' '),
    email_address: f.email
  };
  var digits = String(f.phone || '').replace(/\D/g, '');
  if (digits.length === 10) body.phone_number = '+1' + digits;
  else if (digits.length === 11 && digits[0] === '1') body.phone_number = '+' + digits;
  return squareCall_(s, 'post', '/v2/customers', body).customer.id;
}

// ───────────────────────── Signed copy ─────────────────────────

function saveSignedCopy_(order, s) {
  var folder = getSignedFolder_();
  var f = order.f;
  var sigBlob = Utilities.newBlob(Utilities.base64Decode(f.signature.split(',')[1]), 'image/png', 'signature.png');
  var html = '<html><body style="font-family:Arial;font-size:11pt">' + htmlSummary_(order, s) +
    '<h3>Terms &amp; Conditions agreed to</h3><div style="white-space:pre-wrap;font-size:9pt">' + esc_(s['Terms & Conditions'] || '') + '</div>' +
    '<p><b>Agreed:</b> Yes &nbsp; <b>Initials:</b> ' + esc_(f.initials) + ' &nbsp; <b>Date:</b> ' + esc_(new Date().toString()) + '</p>' +
    '<p><b>Signature:</b><br><img src="' + f.signature + '" style="height:90px;border-bottom:1px solid #999"></p></body></html>';
  var name = 'Order ' + order.orderNo + ' – ' + f.name + ' – ' + f.eventDate;
  var pdf = Utilities.newBlob(html, 'text/html', name + '.html').getAs('application/pdf').setName(name + '.pdf');
  var file = folder.createFile(pdf);
  folder.createFile(sigBlob.setName(name + ' – signature.png'));
  return { url: file.getUrl(), pdf: pdf };
}

function getSignedFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('SIGNED_FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* recreate below */ } }
  var folder = DriveApp.createFolder('Order Forms – Signed Copies');
  props.setProperty('SIGNED_FOLDER_ID', folder.getId());
  return folder;
}

// ───────────────────────── Emails ─────────────────────────

function emailOwnerNewOrder_(order, results, problems, s) {
  var f = order.f;
  var sh = results.shortages;
  var alert = '';
  if (sh && sh.short.length) {
    alert += '<div style="background:#fde8e8;border:1px solid #e0a0a0;padding:12px;border-radius:8px;margin-bottom:14px">' +
      '<b>⚠️ You don\'t have enough for all your open orders. Buy:</b><ul>' +
      sh.short.map(function (r) { return '<li><b>' + esc_(fmt_(-r.left)) + ' ' + esc_(r.unit) + '</b> ' + esc_(r.ingredient) + '</li>'; }).join('') +
      '</ul></div>';
  }
  if (sh && sh.low.length) {
    alert += '<p>🔸 Running low (below your "keep at least" level): ' +
      sh.low.map(function (r) { return esc_(r.ingredient) + ' (' + fmt_(r.left) + ' ' + esc_(r.unit) + ' left)'; }).join(', ') + '</p>';
  }
  if (sh && (sh.missingRecipes.length || sh.unknownIngredients.length)) {
    alert += '<p style="color:#8a5a00">ℹ️ Couldn\'t count everything: ' +
      (sh.missingRecipes.length ? 'no recipe on file for ' + esc_(sh.missingRecipes.join(', ')) + '. ' : '') +
      (sh.unknownIngredients.length ? 'Not on your Inventory tab: ' + esc_(sh.unknownIngredients.join(', ')) + '.' : '') + '</p>';
  }
  var links = '<p>' +
    (results.invoiceUrl ? '<a href="' + results.invoiceUrl + '">Review draft invoice in Square</a> · ' : '') +
    (results.calendarUrl ? '<a href="' + results.calendarUrl + '">Calendar</a> · ' : '') +
    (results.signedUrl ? '<a href="' + results.signedUrl + '">Signed form (PDF)</a> · ' : '') +
    '<a href="' + SpreadsheetApp.openById(spreadsheetId_()).getUrl() + '">Order sheet</a></p>';
  var probs = problems.length ? '<p style="color:#b00"><b>Something needs your attention:</b><br>' + problems.map(esc_).join('<br>') + '</p>' : '';

  var subject = (sh && sh.short.length ? '⚠️ SHORT ON INGREDIENTS – ' : '') +
    'New order #' + order.orderNo + ': ' + f.name + ' – ' + f.eventDate;
  MailApp.sendEmail({
    to: ownerEmail_(s), subject: subject, replyTo: f.email, name: 'Order Form',
    htmlBody: alert + links + htmlSummary_(order, s) + probs
  });
}

function emailCustomerCopy_(order, results, s) {
  var f = order.f;
  var biz = s['Business Name'] || 'Custom Desserts';
  MailApp.sendEmail({
    to: f.email,
    subject: biz + ' – we received your order form (#' + order.orderNo + ')',
    name: biz,
    replyTo: ownerEmail_(s),
    htmlBody: '<p>Hi ' + esc_(f.name.split(' ')[0]) + ',</p><p>Thank you! We received your order form. ' +
      'We\'ll review it and send your invoice shortly. A copy of what you submitted, including the terms you agreed to and your signature, is attached.</p>' +
      htmlSummary_(order, s, true) + '<p>– ' + esc_(biz) + '</p>',
    attachments: results.signedBlob ? [results.signedBlob] : []
  });
}

/** Sunday-morning email: this week's orders + shopping list + full inventory. */
function weeklyShoppingList() {
  var s = getSettings_();
  var inv = recalculateInventory();
  var list = buildShoppingList_(inv.rows);
  var today = new Date(); today.setHours(0, 0, 0, 0);
  var weekEnd = new Date(today.getTime() + 8 * 86400000);
  var tz = Session.getScriptTimeZone();
  var orders = readTable_(SHEETS.ORDERS).filter(function (o) {
    if (OPEN_STATUSES.indexOf(String(o['Status']).trim()) < 0) return false;
    var d = asDate_(o['Event Date'], tz);
    return d && d >= today && d < weekEnd;
  }).sort(function (a, b) { return asDate_(a['Event Date'], tz) - asDate_(b['Event Date'], tz); });

  var html = '<h2>🛒 Shopping list</h2>' + (list.length
    ? '<table cellpadding="6" style="border-collapse:collapse">' + list.map(function (r) {
      return '<tr><td>☐</td><td><b>' + fmt_(r.buy) + ' ' + esc_(r.unit) + '</b></td><td>' + esc_(r.ingredient) + '</td></tr>';
    }).join('') + '</table>'
    : '<p>Nothing to buy – you have enough for all open orders. 🎉</p>');

  html += '<h2>📅 This week\'s orders (' + orders.length + ')</h2>' + (orders.length ? '<ul>' + orders.map(function (o) {
    return '<li><b>' + esc_(Utilities.formatDate(asDate_(o['Event Date'], tz), tz, 'EEE MMM d')) + (o['Time'] ? ' ' + esc_(displayTime_(o['Time'], tz)) : '') +
      '</b> – ' + esc_(o['Customer']) + ' (' + esc_(o['Status']) + '): ' + esc_(o['Items']).replace(/\n/g, '; ') + '</li>';
  }).join('') + '</ul>' : '<p>No orders this week.</p>');

  html += '<h2>📦 Inventory</h2><table cellpadding="4" style="border-collapse:collapse;font-size:13px">' +
    '<tr style="background:#f3f3f3"><th align="left">Ingredient</th><th>Have</th><th>Needed for orders</th><th>Left after</th></tr>' +
    inv.rows.map(function (r) {
      var color = r.left < 0 ? '#c00' : (r.keepAtLeast && r.left < r.keepAtLeast ? '#b36b00' : '#222');
      return '<tr><td>' + esc_(r.ingredient) + '</td><td align="center">' + fmt_(r.onHand) + ' ' + esc_(r.unit) +
        '</td><td align="center">' + fmt_(r.reserved) + '</td><td align="center" style="color:' + color + '"><b>' + fmt_(r.left) + '</b></td></tr>';
    }).join('') + '</table>';

  if (inv.missingRecipes.length) html += '<p style="color:#8a5a00">ℹ️ No recipe on file for: ' + esc_(inv.missingRecipes.join(', ')) + ' – these weren\'t counted.</p>';
  if (inv.unknownIngredients.length) html += '<p style="color:#8a5a00">ℹ️ Recipes use ingredients that aren\'t on your Inventory tab: ' + esc_(inv.unknownIngredients.join(', ')) + '</p>';

  MailApp.sendEmail({ to: ownerEmail_(s), subject: '🛒 Weekly shopping list & orders', name: 'Order Form', htmlBody: html });
}

function htmlSummary_(order, s, forCustomer) {
  var f = order.f, p = order.pricing;
  var row = function (k, v) { return v ? '<tr><td style="color:#666;padding:3px 12px 3px 0;vertical-align:top">' + k + '</td><td style="padding:3px 0"><b>' + esc_(v) + '</b></td></tr>' : ''; };
  var items = '<ol style="margin:4px 0 0 18px;padding:0">' + p.lines.map(function (l) {
    var it = l.item;
    return '<li style="margin-bottom:6px"><b>' + esc_(it.qty + ' × ' + it.size + ' ' + it.product) + '</b>' +
      (it.choice1 || it.choice2 ? ' – ' + esc_([it.choice1, it.choice2].filter(Boolean).join(' / ')) : '') +
      (it.notes ? '<br><span style="color:#555">' + esc_(it.notes) + '</span>' : '') + '</li>';
  }).join('') + '</ol>';
  var money = forCustomer ? '' :
    row('Starting price', '$' + p.subtotal.toFixed(2)) + (p.fee ? row('Card fee', '$' + p.fee.toFixed(2)) : '') + row('Total', '$' + p.total.toFixed(2));
  return '<h3 style="margin:0 0 6px">Order #' + order.orderNo + ' – ' + esc_(f.name) + '</h3>' +
    '<table style="font-size:14px">' +
    row('Event', [f.eventType, f.eventDate, f.time ? displayTime_(f.time) : ''].filter(Boolean).join(' · ')) +
    row(f.fulfillment, f.address || ' ') + row('Phone', f.phone) + row('Email', f.email) +
    row('Payment', f.paymentMethod) + money + row('Allergies', f.allergies) + row('Notes', f.notes) +
    '</table><div style="margin-top:8px"><b>Items</b>' + items + '</div>';
}

function plainSummary_(order) {
  var f = order.f;
  return ['Order #' + order.orderNo, f.name + ' · ' + f.phone + ' · ' + f.email,
    (f.fulfillment || '') + (f.address ? ' to ' + f.address : ''), 'Payment: ' + f.paymentMethod, '',
    itemsSummary_(f.items), f.allergies ? '\nALLERGIES: ' + f.allergies : '', f.notes ? '\nNotes: ' + f.notes : ''].join('\n');
}

function itemsSummary_(items) {
  return items.map(function (it) {
    return '• ' + it.qty + ' × ' + it.size + ' ' + it.product +
      (it.choice1 || it.choice2 ? ' – ' + [it.choice1, it.choice2].filter(Boolean).join(' / ') : '') +
      (it.notes ? ' (' + it.notes + ')' : '');
  }).join('\n');
}

function shortItems_(items) {
  return items.map(function (it) { return (it.qty > 1 ? it.qty + '× ' : '') + it.size + ' ' + it.product; }).join(', ');
}

// ───────────────────────── Menu, setup & Square helpers ─────────────────────────

function onOpen() {
  SpreadsheetApp.getUi().createMenu('🎂 Orders')
    .addItem('Recalculate inventory', 'recalculateInventoryFromMenu')
    .addItem('Email me the shopping list now', 'weeklyShoppingList')
    .addSeparator()
    .addItem('Connect Square (paste access token)', 'setSquareToken')
    .addItem('Test Square connection', 'testSquare')
    .addSeparator()
    .addItem('Set up / repair (safe to re-run)', 'setup')
    .addToUi();
}

function recalculateInventoryFromMenu() {
  var inv = recalculateInventory();
  var msg = 'Inventory updated.';
  if (inv.missingRecipes.length) msg += '\n\nNo recipe on file for: ' + inv.missingRecipes.join(', ');
  if (inv.unknownIngredients.length) msg += '\n\nRecipes use ingredients not on the Inventory tab: ' + inv.unknownIngredients.join(', ');
  SpreadsheetApp.getUi().alert(msg);
}

function setSquareToken() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt('Connect Square', 'Paste your Square access token (Square Developer → your app → Credentials). It is stored privately in this script, not on the sheet.', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  var t = r.getResponseText().trim();
  if (t) { PropertiesService.getScriptProperties().setProperty('SQUARE_ACCESS_TOKEN', t); testSquare(); }
}

function testSquare() {
  var ui = SpreadsheetApp.getUi();
  try {
    var res = squareCall_(getSettings_(), 'get', '/v2/locations');
    if (!res) { ui.alert('Square is not connected yet. Use 🎂 Orders → Connect Square first.'); return; }
    ui.alert('✅ Square connected. Your locations:\n\n' + (res.locations || []).map(function (l) {
      return l.name + '  →  Location ID: ' + l.id;
    }).join('\n') + '\n\nCopy the Location ID into the Settings tab.');
  } catch (e) { ui.alert('Square connection failed:\n' + e.message); }
}

/** One-time setup. Creates any missing tabs (with sample data) and the automatic triggers. Never erases your data. */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ss.getId());

  ensureSheet_(ss, SHEETS.SETTINGS, ['Setting', 'Value', 'What it means'], sampleSettings_());
  ensureSheet_(ss, SHEETS.PRODUCTS, ['Product', 'Size / Option', 'Starting Price', 'Choice 1 List', 'Choice 2 List'], sampleProducts_());
  ensureSheet_(ss, SHEETS.FLAVORS, ['List', 'Choice'], sampleFlavors_());
  ensureSheet_(ss, SHEETS.INVENTORY, ['Ingredient', 'Unit', 'On Hand', 'Keep At Least', 'Reserved for Orders', 'Left After Orders'], sampleInventory_());
  ensureSheet_(ss, SHEETS.RECIPES, ['Recipe', 'Size', 'Ingredient', 'Amount', 'Notes'], sampleRecipes_());
  var orders = ensureSheet_(ss, SHEETS.ORDERS, ORDER_HEADERS, []);

  // Status dropdown on the Orders tab
  var statusCol = ORDER_HEADERS.indexOf('Status') + 1;
  orders.getRange(2, statusCol, 1000, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList([STATUS.NEW, STATUS.CONFIRMED, STATUS.DONE, STATUS.CANCELLED], true).build());
  orders.hideColumns(ORDER_HEADERS.indexOf('Items Data') + 1);
  orders.getRange(2, ORDER_HEADERS.indexOf('Items') + 1, 1000, 1).setWrap(true);
  orders.setFrozenColumns(4);

  // Red when an ingredient would go negative
  var inv = ss.getSheetByName(SHEETS.INVENTORY);
  inv.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=AND($A2<>"",$F2<0)').setBackground('#f8d0d0')
      .setRanges([inv.getRange('A2:F1000')]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=AND($A2<>"",$D2<>"",$F2<$D2)').setBackground('#fdebc8')
      .setRanges([inv.getRange('A2:F1000')]).build()
  ]);

  // Triggers: status changes + Sunday shopping list
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['onStatusEdit', 'weeklyShoppingList'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('onStatusEdit').forSpreadsheet(ss).onEdit().create();
  ScriptApp.newTrigger('weeklyShoppingList').timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(7).create();

  getSignedFolder_();
  recalculateInventory();
  try { SpreadsheetApp.getUi().alert('✅ All set up. Next: Deploy → New deployment → Web app (see README step 4).'); } catch (e) { /* run from editor */ }
}

function ensureSheet_(ss, name, headers, rows) {
  var sh = ss.getSheetByName(name);
  if (sh) return sh;
  sh = ss.insertSheet(name);
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#f3e5f5');
  sh.setFrozenRows(1);
  if (rows.length) sh.getRange(2, 1, rows.length, headers.length).setValues(rows);
  sh.autoResizeColumns(1, headers.length);
  return sh;
}

// ───────────────────────── Sample data (replace with your own) ─────────────────────────

function sampleSettings_() {
  return [
    ['Business Name', 'Sweet Creations', 'Shown at the top of the form and in emails'],
    ['Your Email', '', 'Where new-order alerts and the Sunday shopping list go (blank = the Google account running this)'],
    ['Calendar ID', '', 'Blank = your main Google Calendar. Or paste a calendar\'s ID (Calendar settings → Integrate calendar)'],
    ['Calendar Event Minutes', 30, 'Length of the pickup/delivery calendar entry'],
    ['Event Types', 'Wedding, Bar/Bat Mitzvah, Birthday, Baby Shower, Bridal Shower, Corporate, Other', 'Dropdown on the form (comma-separated)'],
    ['Payment Methods', 'Credit card, Venmo, Cash App, Zelle', 'Dropdown on the form (comma-separated)'],
    ['Card Fee Applies To', 'Credit card', 'Which payment method gets the card fee (must match one above exactly)'],
    ['Card Fee %', 3.5, 'Added to the Square invoice when the customer picks the method above'],
    ['Currency', 'USD', ''],
    ['Invoice Due Days Before Event', 7, 'Due date on the draft invoice'],
    ['Send Customer A Copy', 'Yes', 'Yes = customer gets an email copy of their signed form'],
    ['Square Environment', 'production', 'production = real Square account; sandbox = testing'],
    ['Square Location ID', '', 'Menu 🎂 Orders → Test Square connection shows it'],
    ['Terms & Conditions', SAMPLE_TERMS, 'Replace with your own terms. Customers must scroll past this and tick “I agree”.']
  ];
}

var SAMPLE_TERMS = [
  'SAMPLE TERMS – REPLACE WITH YOUR OWN',
  '',
  '1. Deposit & payment: A non-refundable deposit of 50% secures your date. The balance is due 7 days before your event.',
  '2. Changes: Design changes may be made up to 14 days before the event and may change the price.',
  '3. Cancellations: Cancellations within 14 days of the event are not refundable.',
  '4. Allergies: Our kitchen handles wheat, dairy, eggs, soy and nuts. We cannot guarantee any item is allergen-free.',
  '5. Pickup & delivery: Once the order leaves our hands, we are not responsible for damage caused by transport, heat or handling.',
  '6. Design: Every item is handmade. Colors and details may vary slightly from inspiration photos.',
  '7. Rentals: Cake stands or other rentals must be returned within 3 days or a replacement fee applies.'
].join('\n');

function sampleProducts_() {
  return [
    ['Cake', '6" round', 85, 'Cake Flavor', 'Filling'],
    ['Cake', '8" round', 120, 'Cake Flavor', 'Filling'],
    ['Cake', '10" round', 165, 'Cake Flavor', 'Filling'],
    ['Cookies', '1 dozen', 48, 'Cookie Flavor', ''],
    ['Cake Pops', '1 dozen', 42, 'Cake Flavor', 'Coating'],
    ['Rice Krispie Pops', '1 dozen', 40, '', 'Coating'],
    ['Dessert Cups', '1 dozen', 45, 'Cake Flavor', 'Filling']
  ];
}

function sampleFlavors_() {
  return [
    ['Cake Flavor', 'Vanilla'], ['Cake Flavor', 'Chocolate'], ['Cake Flavor', 'Red Velvet'], ['Cake Flavor', 'Funfetti'],
    ['Filling', 'Vanilla Buttercream'], ['Filling', 'Chocolate Ganache'], ['Filling', 'Raspberry'], ['Filling', 'Cookies & Cream'],
    ['Cookie Flavor', 'Vanilla Sugar Cookie'], ['Cookie Flavor', 'Chocolate Sugar Cookie'],
    ['Coating', 'White Chocolate'], ['Coating', 'Milk Chocolate']
  ];
}

function sampleInventory_() {
  return [
    ['Flour', 'cups', 40, 10], ['Sugar', 'cups', 30, 8], ['Eggs', 'each', 36, 12], ['Butter', 'sticks', 24, 8],
    ['Milk', 'cups', 12, 4], ['Cocoa powder', 'cups', 6, 2], ['Powdered sugar', 'cups', 30, 10],
    ['Heavy cream', 'cups', 8, 2], ['Chocolate chips', 'cups', 10, 3], ['Raspberry jam', 'cups', 4, 1],
    ['Oreo cookies', 'packs', 2, 1], ['Red food coloring', 'oz', 4, 1], ['Sprinkles', 'cups', 3, 1],
    ['Candy melts', 'lbs', 6, 2], ['Rice Krispies cereal', 'cups', 24, 6], ['Marshmallows', 'bags', 4, 2],
    ['Lollipop sticks', 'each', 150, 50], ['Treat bags', 'each', 150, 50], ['Cake boards', 'each', 10, 4], ['Cake boxes', 'each', 10, 4]
  ].map(function (r) { return r.concat(['', '']); });
}

function sampleRecipes_() {
  var sizes = { '6" round': 0.6, '8" round': 1, '10" round': 1.6 };
  var cakes = {
    'Vanilla': [['Flour', 2.5], ['Sugar', 2], ['Eggs', 4], ['Butter', 2], ['Milk', 1]],
    'Chocolate': [['Flour', 2], ['Sugar', 2], ['Eggs', 3], ['Cocoa powder', 0.75], ['Milk', 1], ['Butter', 1]],
    'Red Velvet': [['Flour', 2.5], ['Sugar', 2], ['Eggs', 3], ['Cocoa powder', 0.25], ['Red food coloring', 1], ['Butter', 2]],
    'Funfetti': [['Flour', 2.5], ['Sugar', 2], ['Eggs', 4], ['Butter', 2], ['Milk', 1], ['Sprinkles', 0.5]]
  };
  var fillings = {
    'Vanilla Buttercream': [['Butter', 2], ['Powdered sugar', 4]],
    'Chocolate Ganache': [['Chocolate chips', 1.5], ['Heavy cream', 1]],
    'Raspberry': [['Raspberry jam', 0.75]],
    'Cookies & Cream': [['Butter', 2], ['Powdered sugar', 3], ['Oreo cookies', 0.5]]
  };
  var rows = [];
  Object.keys(sizes).forEach(function (size) {
    var m = sizes[size];
    rows.push(['Cake', size, 'Cake boards', 1, 'Every cake'], ['Cake', size, 'Cake boxes', 1, 'Every cake']);
    rows.push(['Cake', size, 'Butter', round2_(4 * m), 'Outside buttercream'], ['Cake', size, 'Powdered sugar', round2_(8 * m), 'Outside buttercream']);
    [cakes, fillings].forEach(function (group) {
      Object.keys(group).forEach(function (name) {
        group[name].forEach(function (ing) { rows.push([name, size, ing[0], round2_(ing[1] * m), '']); });
      });
    });
  });
  // Per-dozen items (size "1 dozen"). Cake pops and dessert cups reuse the cake flavor at "1 dozen" size.
  var dz = '1 dozen';
  rows.push(
    ['Cookies', dz, 'Treat bags', 12, ''],
    ['Vanilla Sugar Cookie', dz, 'Flour', 3, ''], ['Vanilla Sugar Cookie', dz, 'Sugar', 1, ''], ['Vanilla Sugar Cookie', dz, 'Butter', 2, ''], ['Vanilla Sugar Cookie', dz, 'Eggs', 1, ''], ['Vanilla Sugar Cookie', dz, 'Powdered sugar', 2, 'Royal icing'],
    ['Chocolate Sugar Cookie', dz, 'Flour', 2.5, ''], ['Chocolate Sugar Cookie', dz, 'Cocoa powder', 0.5, ''], ['Chocolate Sugar Cookie', dz, 'Sugar', 1, ''], ['Chocolate Sugar Cookie', dz, 'Butter', 2, ''], ['Chocolate Sugar Cookie', dz, 'Eggs', 1, ''], ['Chocolate Sugar Cookie', dz, 'Powdered sugar', 2, 'Royal icing'],
    ['Cake Pops', dz, 'Lollipop sticks', 12, ''], ['Cake Pops', dz, 'Treat bags', 12, ''],
    ['Rice Krispie Pops', dz, 'Rice Krispies cereal', 6, ''], ['Rice Krispie Pops', dz, 'Marshmallows', 1, ''], ['Rice Krispie Pops', dz, 'Butter', 1, ''], ['Rice Krispie Pops', dz, 'Lollipop sticks', 12, ''], ['Rice Krispie Pops', dz, 'Treat bags', 12, ''],
    ['White Chocolate', dz, 'Candy melts', 0.75, 'Coating'], ['Milk Chocolate', dz, 'Candy melts', 0.75, 'Coating']
  );
  Object.keys(cakes).forEach(function (name) {
    cakes[name].forEach(function (ing) { rows.push([name, dz, ing[0], round2_(ing[1] * 0.4), 'Cake pops / dessert cups']); });
  });
  Object.keys(fillings).forEach(function (name) {
    fillings[name].forEach(function (ing) { rows.push([name, dz, ing[0], round2_(ing[1] * 0.5), 'Dessert cups']); });
  });
  return rows;
}

// ───────────────────────── Small helpers ─────────────────────────

function spreadsheetId_() {
  return PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID') || SpreadsheetApp.getActiveSpreadsheet().getId();
}
function getSheet_(name) {
  var sh = SpreadsheetApp.openById(spreadsheetId_()).getSheetByName(name);
  if (!sh) throw new Error('Missing tab "' + name + '". Run 🎂 Orders → Set up / repair.');
  return sh;
}
function readTable_(name) {
  var values = getSheet_(name).getDataRange().getValues();
  var headers = values.shift().map(function (x) { return String(x).trim(); });
  return values.map(function (r) {
    var o = {};
    headers.forEach(function (h, i) { o[h] = r[i]; });
    return o;
  });
}
function headerMap_(headers) {
  var m = {};
  headers.forEach(function (h, i) { m[String(h).trim()] = i; });
  return m;
}
function setCell_(sheet, row, header, value) {
  var h = headerMap_(sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]);
  sheet.getRange(row, h[header] + 1).setValue(value);
}
function nextOrderNumber_(sheet) {
  var last = sheet.getLastRow();
  if (last < 2) return 1001;
  var nums = sheet.getRange(2, 1, last - 1, 1).getValues().map(function (r) { return toNumber_(r[0]) || 0; });
  return Math.max.apply(null, nums.concat([1000])) + 1;
}
function getSettings_() {
  var out = {};
  readTable_(SHEETS.SETTINGS).forEach(function (r) { if (r['Setting']) out[String(r['Setting']).trim()] = r['Value']; });
  return out;
}
function ownerEmail_(s) { return String(s['Your Email'] || '').trim() || Session.getEffectiveUser().getEmail(); }
function parseItems_(json) { try { return JSON.parse(json || '[]'); } catch (e) { return []; } }
function splitList_(v) { return String(v || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean); }
function norm_(v) { return String(v === undefined || v === null ? '' : v).trim().toLowerCase().replace(/[“”″]/g, '"').replace(/\s+/g, ' '); }
function toNumber_(v) { var n = parseFloat(String(v === undefined || v === null ? '' : v).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? 0 : n; }
function yes_(v) { return /^(y|yes|true|1)$/i.test(String(v || '').trim()); }
function round2_(n) { return Math.round(n * 100) / 100; }
function round3_(n) { return Math.round(n * 1000) / 1000; }
function pad2_(n) { return (n < 10 ? '0' : '') + n; }
function fmt_(n) { return String(round2_(n)); }
function esc_(v) {
  return String(v === undefined || v === null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function asDate_(v, tz) {
  if (v instanceof Date) { var d = new Date(v.getTime()); d.setHours(0, 0, 0, 0); return d; }
  if (!v) return null;
  try { return Utilities.parseDate(String(v), 'yyyy-MM-dd', tz); } catch (e) { return null; }
}
function displayTime_(t, tz) {
  if (t instanceof Date) return Utilities.formatDate(t, tz || Session.getScriptTimeZone(), 'h:mm a');
  var m = String(t).match(/^(\d{1,2}):(\d{2})/);
  if (!m) return String(t);
  var h = +m[1];
  return ((h + 11) % 12 + 1) + ':' + m[2] + (h < 12 ? ' AM' : ' PM');
}
