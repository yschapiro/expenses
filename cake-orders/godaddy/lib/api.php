<?php
// Request handlers — PHP port of site/public/js/api.js (same routes, same responses).
//
// Api::handle($req, $ctx) where
//   $req = ['method', 'path', 'query' => [], 'body', 'adminKey', 'clientInfo']
//   $ctx = [
//     'db'            => Db (getSettings, saveSettings, getTable, replaceTable, insertOrder, updateOrder, getOrder, listOrders, adjustInventory),
//     'adminPassword' => string,
//     'sendEmail'     => ?callable(to, subject, html, attachments = [], replyTo = null),
//     'squareToken'   => string,
//     'uuid'          => callable, 'nowIso' => callable,
//     'publicUrl'     => 'https://example.com/orders/' (folder of api.php, trailing slash) or '',
//     'backendName'   => 'GoDaddy',
//   ]
// Returns ['status' => int, 'data' => mixed] or ['status' => int, 'raw' => string, 'contentType' => string].
require_once __DIR__ . '/core.php';
require_once __DIR__ . '/db.php';

final class Api
{
    private static function ok($data, int $status = 200): array { return ['status' => $status, 'data' => $data]; }
    private static function fail(int $status, string $message): array { return ['status' => $status, 'data' => ['error' => $message]]; }

    public static function handle(array $req, array $ctx): array
    {
        $method = $req['method'];
        $path = $req['path'];
        try {
            if ($method === 'GET' && $path === '/config') return self::ok(self::getConfig($ctx));
            if ($method === 'POST' && $path === '/orders') return self::ok(self::submitOrder($req['body'] ?? null, $ctx, $req));
            if ($method === 'GET' && $path === '/calendar.ics') return self::calendarFeed($req, $ctx);

            if (strncmp($path, '/admin/', 7) === 0) {
                if (!C::truthy($ctx['adminPassword'] ?? '')) return self::fail(500, 'Admin password is not configured on the server.');
                if (!hash_equals((string)$ctx['adminPassword'], (string)($req['adminKey'] ?? ''))) return self::fail(401, 'Wrong password.');
                return self::admin($req, $ctx);
            }
            return self::fail(404, 'Not found');
        } catch (OrderError $e) {
            return self::fail(400, $e->getMessage());
        } catch (Throwable $e) {
            error_log('[orders] ' . $e);
            return self::fail(500, 'Server error: ' . $e->getMessage());
        }
    }

    private static function getConfig(array $ctx): array
    {
        $db = $ctx['db'];
        return C::formConfig($db->getSettings(), $db->getTable('products'), $db->getTable('choices'));
    }

    // ───────── new order ─────────
    private static function submitOrder($body, array $ctx, array $req): array
    {
        if (is_array($body) && C::truthy($body['website'] ?? null)) return ['orderNo' => 0]; // honeypot: bots fill hidden fields
        $f = C::cleanOrder($body);

        $db = $ctx['db'];
        $settings = $db->getSettings();
        $products = $db->getTable('products');
        $recipes = $db->getTable('recipes');
        $s = C::settingsWithDefaults($settings);
        $pricing = C::priceOrder($f['items'], $products, $f['paymentMethod'], $settings);

        $now = ($ctx['nowIso'])();
        $row = [
            'created_at' => $now, 'status' => 'New',
            'name' => $f['name'], 'email' => $f['email'], 'phone' => $f['phone'], 'event_type' => $f['eventType'], 'event_date' => $f['eventDate'],
            'fulfillment' => $f['fulfillment'], 'time' => $f['time'], 'address' => $f['address'], 'items' => $f['items'], 'allergies' => $f['allergies'], 'notes' => $f['notes'],
            'payment_method' => $f['paymentMethod'], 'subtotal' => $pricing['subtotal'], 'fee' => $pricing['fee'], 'total' => $pricing['total'],
            'initials' => $f['initials'], 'terms_text' => $s['terms'], 'terms_accepted_at' => ($ctx['nowIso'])(), 'signature' => $f['signature'],
            'client_info' => C::slice((string)($req['clientInfo'] ?? ''), 300), 'square_invoice_id' => '', 'square_invoice_url' => '', 'deducted_at' => '',
        ];
        $row['id'] = $db->insertOrder($row);

        $problems = [];
        $links = [];
        // Square draft invoice
        if (C::truthy($ctx['squareToken'] ?? '')) {
            try {
                $inv = self::createSquareInvoice($row, $pricing, $settings, $ctx);
                $db->updateOrder($row['id'], ['square_invoice_id' => $inv['id'], 'square_invoice_url' => $inv['url']]);
                $links['Review draft invoice in Square'] = $inv['url'];
            } catch (Throwable $e) { $problems[] = 'Square invoice: ' . $e->getMessage(); }
        } else $problems[] = 'Square is not connected yet, so no draft invoice was made.';

        // Inventory check
        $shortages = null;
        try {
            $status = self::currentInventory($ctx, $recipes);
            $shortages = C::shortagesForOrder($f['items'], $status, $recipes);
        } catch (Throwable $e) { $problems[] = 'Inventory: ' . $e->getMessage(); }

        $links['Open dashboard'] = C::truthy($ctx['publicUrl'] ?? '') ? $ctx['publicUrl'] . 'admin.html#order-' . $row['id'] : '';

        $send = $ctx['sendEmail'] ?? null;
        if ($send) {
            $ownerTo = $s['owner_email'];
            if ($ownerTo !== '') {
                try {
                    $m = C::ownerEmail($row, ['shortages' => $shortages, 'links' => $links, 'problems' => $problems]);
                    $send($ownerTo, $m['subject'], $m['html'], [['filename' => 'order-' . C::orderNo($row['id']) . '.ics', 'content' => C::buildIcs([$row], $settings, 'PUBLISH'), 'type' => 'text/calendar']], $f['email']);
                } catch (Throwable $e) { error_log('[orders] owner email: ' . $e->getMessage()); }
            }
            if (C::yes($s['send_customer_copy'])) {
                try { $m = C::customerEmail($row, $settings); $send($f['email'], $m['subject'], $m['html'], [], $ownerTo); }
                catch (Throwable $e) { error_log('[orders] customer email: ' . $e->getMessage()); }
            }
        }
        return ['orderNo' => C::orderNo($row['id']), 'id' => $row['id'], 'shortages' => $shortages, 'problems' => $problems];
    }

    private static function currentInventory(array $ctx, ?array $recipes = null): array
    {
        $db = $ctx['db'];
        $inventory = $db->getTable('inventory');
        $open = array_values(array_filter($db->listOrders(), fn($o) => in_array($o['status'], C::OPEN_STATUSES, true)));
        return C::inventoryStatus($inventory, $open, $recipes ?? $db->getTable('recipes'));
    }

    // ───────── Square ─────────
    private static function squareBase($settings): string
    {
        return preg_match('/sandbox/i', C::settingsWithDefaults($settings)['square_env']) ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com';
    }

    private static function square(array $ctx, $settings, string $method, string $path, ?array $body = null): array
    {
        $ch = curl_init(self::squareBase($settings) . $path);
        $opts = [
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 30,
            CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . $ctx['squareToken'], 'Square-Version: 2024-10-17', 'Content-Type: application/json'],
        ];
        if ($body !== null) $opts[CURLOPT_POSTFIELDS] = C::json($body);
        curl_setopt_array($ch, $opts);
        $text = curl_exec($ch);
        if ($text === false) { $err = curl_error($ch); curl_close($ch); throw new RuntimeException('fetch failed: ' . $err); }
        $code = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        $json = json_decode((string)$text, true);
        if (!is_array($json)) $json = [];
        if ($code < 200 || $code > 299) {
            $msgs = [];
            foreach (is_array($json['errors'] ?? null) ? $json['errors'] : [] as $e) {
                $msgs[] = C::truthy($e['detail'] ?? null) ? $e['detail'] : C::s($e['code'] ?? null);
            }
            $msg = implode('; ', $msgs);
            throw new RuntimeException('Square said: ' . ($msg !== '' ? $msg : (string)$code));
        }
        return $json;
    }

    private static function createSquareInvoice(array $o, array $pricing, $settings, array $ctx): array
    {
        $s = C::settingsWithDefaults($settings);
        if ($s['square_location_id'] === '') throw new RuntimeException('Add your Square location ID in Settings.');
        $found = self::square($ctx, $settings, 'POST', '/v2/customers/search', ['query' => ['filter' => ['email_address' => ['exact' => $o['email']]]], 'limit' => 1]);
        $customerId = !empty($found['customers']) ? $found['customers'][0]['id']
            : self::square($ctx, $settings, 'POST', '/v2/customers', C::squareCustomerBody($o, ($ctx['uuid'])()))['customer']['id'];
        $so = self::square($ctx, $settings, 'POST', '/v2/orders', C::squareOrderBody($o, $pricing, $s['square_location_id'], $customerId, $settings, ($ctx['uuid'])()));
        $inv = self::square($ctx, $settings, 'POST', '/v2/invoices', C::squareInvoiceBody($o, $s['square_location_id'], $customerId, $so['order']['id'], $settings, ($ctx['uuid'])()));
        $dash = preg_match('/sandbox/i', $s['square_env']) ? 'https://app.squareupsandbox.com' : 'https://app.squareup.com';
        return ['id' => $inv['invoice']['id'], 'url' => $dash . '/dashboard/invoices/' . $inv['invoice']['id']];
    }

    // ───────── calendar feed ─────────
    private static function calendarFeed(array $req, array $ctx): array
    {
        $db = $ctx['db'];
        $settings = $db->getSettings();
        $key = (string)($settings['_calendar_key'] ?? '');
        $given = $req['query']['key'] ?? '';
        if ($key === '' || !hash_equals($key, is_string($given) ? $given : '')) return self::fail(403, 'Bad calendar key');
        $orders = array_values(array_filter($db->listOrders(), fn($o) => $o['status'] !== 'Cancelled'));
        return ['status' => 200, 'raw' => C::buildIcs($orders, $settings), 'contentType' => 'text/calendar; charset=utf-8'];
    }

    private static function ensureCalendarKey(array $ctx): string
    {
        $db = $ctx['db'];
        $s = $db->getSettings();
        if (C::truthy($s['_calendar_key'] ?? null)) return (string)$s['_calendar_key'];
        $key = str_replace('-', '', ($ctx['uuid'])());
        $s['_calendar_key'] = $key;
        $db->saveSettings($s);
        return $key;
    }

    // ───────── admin ─────────
    private static function admin(array $req, array $ctx): array
    {
        $method = $req['method'];
        $path = $req['path'];
        $body = $req['body'] ?? null;
        $db = $ctx['db'];

        if ($method === 'GET' && $path === '/admin/info') {
            $key = self::ensureCalendarKey($ctx);
            return self::ok([
                'calendarUrl' => C::truthy($ctx['publicUrl'] ?? '') ? $ctx['publicUrl'] . 'api.php?r=/calendar.ics&key=' . $key : '',
                'emailConfigured' => !empty($ctx['sendEmail']), 'squareConfigured' => C::truthy($ctx['squareToken'] ?? ''), 'backend' => (string)($ctx['backendName'] ?? ''),
            ]);
        }
        if ($method === 'GET' && $path === '/admin/orders') {
            $out = [];
            foreach ($db->listOrders() as $o) {
                unset($o['signature'], $o['terms_text']);
                $o['orderNo'] = C::orderNo($o['id']);
                $out[] = $o;
            }
            return self::ok($out);
        }
        if (preg_match('#^/admin/orders/(\d+)$#D', $path, $m) && $method === 'GET') {
            $o = $db->getOrder((int)$m[1]);
            if (!$o) return self::fail(404, 'No such order');
            $o['orderNo'] = C::orderNo($o['id']);
            return self::ok($o);
        }
        if (preg_match('#^/admin/orders/(\d+)/status$#D', $path, $m) && $method === 'POST') {
            $id = (int)$m[1];
            $st = (is_array($body) && C::truthy($body['status'] ?? null)) ? C::jsString($body['status']) : '';
            if (!in_array($st, C::STATUSES, true)) return self::fail(400, 'Bad status');
            $o = $db->getOrder($id);
            if (!$o) return self::fail(404, 'No such order');
            $patch = ['status' => $st];
            if ($st === 'Done' && !C::truthy($o['deducted_at'] ?? null)) {
                $used = C::deductions($o['items'], $db->getTable('recipes'));
                foreach ($used as $ing => $amt) $db->adjustInventory((string)$ing, -$amt);
                $patch['deducted_at'] = ($ctx['nowIso'])();
            }
            $db->updateOrder($id, $patch);
            return self::ok(['ok' => true, 'deducted' => C::truthy($patch['deducted_at'] ?? null)]);
        }
        if (preg_match('#^/admin/orders/(\d+)/invoice$#D', $path, $m) && $method === 'POST') {
            if (!C::truthy($ctx['squareToken'] ?? '')) return self::fail(400, 'Square is not connected.');
            $o = $db->getOrder((int)$m[1]);
            if (!$o) throw new RuntimeException("Cannot read properties of null (reading 'items')"); // same as api.js
            $settings = $db->getSettings();
            $pricing = C::priceOrder($o['items'], $db->getTable('products'), $o['payment_method'], $settings);
            $inv = self::createSquareInvoice($o, $pricing, $settings, $ctx);
            $db->updateOrder($o['id'], ['square_invoice_id' => $inv['id'], 'square_invoice_url' => $inv['url']]);
            return self::ok($inv);
        }
        if ($method === 'GET' && $path === '/admin/inventory') {
            $status = self::currentInventory($ctx);
            $status['shopping'] = C::shoppingList($status['rows']);
            return self::ok($status);
        }
        if (preg_match('#^/admin/tables/(\w+)$#D', $path, $m)) {
            $name = $m[1];
            if (!isset(C::TABLES[$name])) return self::fail(404, 'No such table');
            if ($method === 'GET') return self::ok($db->getTable($name));
            if ($method === 'PUT') {
                $cols = C::TABLES[$name];
                $rows = [];
                foreach (C::isJsArray($body) ? $body : [] as $r) {
                    if (!is_array($r)) $r = [];
                    $row = [];
                    foreach ($cols as $c) $row[$c] = isset(C::NUMERIC[$c]) ? C::num($r[$c] ?? null) : C::jsTrim(C::s($r[$c] ?? null));
                    if (C::jsTrim(C::jsString($row[$cols[0]])) !== '') $rows[] = $row;
                }
                $db->replaceTable($name, $rows);
                return self::ok(['ok' => true, 'count' => count($rows)]);
            }
        }
        if ($path === '/admin/settings') {
            if ($method === 'GET') {
                $s = $db->getSettings();
                $out = [];
                foreach (C::settingsDefs() as $key => [$def, $label, $help]) $out[] = ['key' => $key, 'label' => $label, 'help' => $help, 'value' => $s[$key] ?? $def];
                return self::ok($out);
            }
            if ($method === 'PUT') {
                $next = $db->getSettings();
                foreach (array_keys(C::settingsDefs()) as $k) {
                    if (is_array($body) && isset($body[$k])) $next[$k] = C::jsString($body[$k]);
                }
                $db->saveSettings($next);
                return self::ok(['ok' => true]);
            }
        }
        if ($method === 'POST' && $path === '/admin/weekly-email') return self::ok(self::weeklyEmail($ctx));
        if ($method === 'GET' && $path === '/admin/square-test') {
            if (!C::truthy($ctx['squareToken'] ?? '')) return self::fail(400, 'Square is not connected (no access token on the server).');
            $r = self::square($ctx, $db->getSettings(), 'GET', '/v2/locations');
            return self::ok(array_map(fn($l) => ['id' => $l['id'] ?? null, 'name' => $l['name'] ?? null], is_array($r['locations'] ?? null) ? $r['locations'] : []));
        }
        return self::fail(404, 'Not found');
    }

    public static function weeklyEmail(array $ctx): array
    {
        $db = $ctx['db'];
        $settings = $db->getSettings();
        $s = C::settingsWithDefaults($settings);
        $status = self::currentInventory($ctx);
        $today = C::todayIn($s['timezone']);
        $end = C::addDays($today, 8);
        $orders = array_values(array_filter($db->listOrders(), fn($o) => in_array($o['status'], C::OPEN_STATUSES, true)
            && strcmp((string)$o['event_date'], $today) >= 0 && strcmp((string)$o['event_date'], $end) < 0));
        usort($orders, fn($a, $b) => strcmp($a['event_date'] . $a['time'], $b['event_date'] . $b['time']));
        $m = C::weeklyEmail($status, $orders);
        $send = $ctx['sendEmail'] ?? null;
        if (!$send) return ['sent' => false, 'reason' => 'Email is not set up on the server.', 'html' => $m['html']];
        if ($s['owner_email'] === '') return ['sent' => false, 'reason' => 'Add your email in Settings.', 'html' => $m['html']];
        $send($s['owner_email'], $m['subject'], $m['html'], []);
        return ['sent' => true, 'html' => $m['html']];
    }
}
