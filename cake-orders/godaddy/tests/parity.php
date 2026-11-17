<?php
// Runs core.php over parity-fixture.json and prints JSON (compare with parity.mjs).
require __DIR__ . '/../lib/core.php';
$fx = C::fromJson(json_decode(file_get_contents(__DIR__ . '/parity-fixture.json')));
$SIG = 'data:image/png;base64,' . str_repeat('A', 300);
$fix = fn($f) => (is_array($f) && ($f['signature'] ?? null) === 'SIG') ? array_merge($f, ['signature' => $SIG]) : $f;
$sample = C::sampleData();
$out = ['sample' => $sample, 'nums' => array_map([C::class, 'num'], $fx['nums']), 'norms' => array_map([C::class, 'norm'], $fx['nums']), 'cases' => [], 'bad' => []];
$out['config'] = C::formConfig($fx['settings'], $sample['products'], $sample['choices']);
$out['defaults'] = C::settingsWithDefaults($fx['settings']);
$orders = [];
foreach ($fx['forms'] as $i => $form) {
    $f = C::cleanOrder($fix($form));
    $pricing = C::priceOrder($f['items'], $sample['products'], $f['paymentMethod'], $fx['settings']);
    $orders[] = ['id' => $i + 1, 'status' => $i ? 'Confirmed' : 'New', 'name' => $f['name'], 'email' => $f['email'], 'phone' => $f['phone'], 'event_type' => $f['eventType'], 'event_date' => $f['eventDate'],
        'fulfillment' => $f['fulfillment'], 'time' => $f['time'], 'address' => $f['address'], 'items' => $f['items'], 'allergies' => $f['allergies'], 'notes' => $f['notes'], 'payment_method' => $f['paymentMethod'],
        'subtotal' => $pricing['subtotal'], 'fee' => $pricing['fee'], 'total' => $pricing['total'], 'initials' => $f['initials'], 'terms_text' => 'T&C <b>', 'terms_accepted_at' => '2030-01-01T00:00:00.000Z', 'signature' => $f['signature']];
    $n = C::computeNeeds($f['items'], $sample['recipes']);
    $n['needs'] = (object)$n['needs'];
    $out['cases'][] = ['f' => $f, 'pricing' => $pricing, 'needs' => $n];
}
$status = C::inventoryStatus($sample['inventory'], $orders, $sample['recipes']);
$out['status'] = $status;
$out['shopping'] = C::shoppingList($status['rows']);
$out['shortages'] = array_map(fn($o) => C::shortagesForOrder($o['items'], $status, $sample['recipes']), $orders);
$out['owner'] = array_map(fn($o, $i) => C::ownerEmail($o, ['shortages' => $out['shortages'][$i], 'links' => ['Open dashboard' => 'https://x/admin.html#order-1', 'Empty' => ''], 'problems' => ['a <b>']]), $orders, array_keys($orders));
$out['customer'] = array_map(fn($o) => C::customerEmail($o, $fx['settings']), $orders);
$out['weekly'] = C::weeklyEmail($status, $orders);
$extra = array_merge($orders[1], ['id' => 9, 'status' => 'Cancelled', 'time' => '', 'notes' => str_repeat('x', 200)]);
$out['ics'] = preg_replace('/DTSTAMP:\w+/', 'DTSTAMP:X', C::buildIcs(array_merge($orders, [$extra]), $fx['settings'], 'PUBLISH'));
$out['square'] = array_map(fn($o, $i) => [C::squareOrderBody($o, $out['cases'][$i]['pricing'], 'LOC', 'CUST', $fx['settings'], 'u1'),
    C::squareInvoiceBody($o, 'LOC', 'CUST', 'ORD', $fx['settings'], 'u2'), C::squareCustomerBody($o, 'u3')], $orders, array_keys($orders));
foreach ($fx['badForms'] as $b) { try { C::cleanOrder($fix($b)); $out['bad'][] = 'OK'; } catch (OrderError $e) { $out['bad'][] = $e->getMessage(); } }
$out['misc'] = ['money' => array_map([C::class, 'money'], [0, 1.005, 0.125, 1234.5, null]), 'dt' => array_map([C::class, 'displayTime'], ['00:05', '12:30', '23:59', 'x']),
    'dd' => array_map([C::class, 'displayDate'], ['2026-02-29', '2030-12-31', 'bad']), 'add' => C::addDays('2026-03-01', -1), 'deductions' => (object)C::deductions($orders[0]['items'], $sample['recipes'])];
echo C::json($out), "\n";
