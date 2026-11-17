<?php
// Shared business logic for the order system — PHP port of site/public/js/core.js.
// Pure functions only: no network, no storage. Keep in sync with core.js.
//
// Conventions used to stay faithful to the JavaScript version:
//  * JS objects are PHP associative arrays; JS arrays are PHP lists.
//  * JSON objects decoded from request bodies carry C::OBJ as a marker key when they would
//    otherwise look like a list (empty, or keys 0..n-1), so Array.isArray() can be told apart.
//  * Truthiness follows JS (C::truthy): '0' is true, 0 / '' / null / false are false, arrays are true.
//  * Numbers are floats (or ints where JS would print an integer) and are printed like JS (C::jsNum).

ini_set('serialize_precision', '-1');

class OrderError extends Exception {}

final class C
{
    const OBJ = "\0obj";
    const STATUSES = ['New', 'Confirmed', 'Done', 'Cancelled'];
    const OPEN_STATUSES = ['New', 'Confirmed'];

    // JavaScript's \s character class.
    const WS = '\s\x{00A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}';

    /** Settings: key → [default value, label, help]. */
    public static function settingsDefs(): array
    {
        static $defs = null;
        if ($defs !== null) return $defs;
        $terms = implode("\n", [
            'SAMPLE TERMS – REPLACE WITH YOUR OWN', '',
            '1. Deposit & payment: A non-refundable deposit of 50% secures your date. The balance is due 7 days before your event.',
            '2. Changes: Design changes may be made up to 14 days before the event and may change the price.',
            '3. Cancellations: Cancellations within 14 days of the event are not refundable.',
            '4. Allergies: Our kitchen handles wheat, dairy, eggs, soy and nuts. We cannot guarantee any item is allergen-free.',
            '5. Pickup & delivery: Once the order leaves our hands, we are not responsible for damage caused by transport, heat or handling.',
            '6. Design: Every item is handmade. Colors and details may vary slightly from inspiration photos.',
            '7. Rentals: Cake stands or other rentals must be returned within 3 days or a replacement fee applies.',
        ]);
        return $defs = [
            'business_name' => ['Sweet Creations', 'Business name', 'Shown on the form and in emails'],
            'owner_email' => ['', 'Your email', 'Where new-order alerts and the Sunday shopping list go'],
            'timezone' => ['America/New_York', 'Time zone', 'Used for "this week" and calendar times'],
            'event_types' => ['Wedding, Bar/Bat Mitzvah, Birthday, Baby Shower, Bridal Shower, Corporate, Other', 'Event types', 'Dropdown on the form (comma-separated)'],
            'payment_methods' => ['Credit card, Venmo, Cash App, Zelle', 'Payment methods', 'Dropdown on the form (comma-separated)'],
            'card_fee_method' => ['Credit card', 'Card fee applies to', 'Which payment method gets the fee (must match one above)'],
            'card_fee_pct' => ['3.5', 'Card fee %', 'Added to the invoice when that method is chosen'],
            'currency' => ['USD', 'Currency', ''],
            'invoice_due_days' => ['7', 'Invoice due (days before event)', 'Due date on the draft Square invoice'],
            'send_customer_copy' => ['Yes', 'Email customer a copy', 'Yes = customer gets their signed form by email'],
            'square_env' => ['production', 'Square environment', 'production = real; sandbox = testing'],
            'square_location_id' => ['', 'Square location ID', 'Dashboard → Settings → "Test Square" shows it'],
            'terms' => [$terms, 'Terms & conditions', 'Customers must tick "I agree" and sign. A copy is saved with every order.'],
        ];
    }

    /** Editable tables and their columns (same in every backend). */
    const TABLES = [
        'products' => ['product', 'size', 'price', 'choice1', 'choice2'],
        'choices' => ['list', 'choice'],
        'inventory' => ['ingredient', 'unit', 'on_hand', 'keep_at_least'],
        'recipes' => ['recipe', 'size', 'ingredient', 'amount', 'notes'],
    ];
    const NUMERIC = ['price' => 1, 'on_hand' => 1, 'keep_at_least' => 1, 'amount' => 1];

    // ───────── JS semantics helpers ─────────

    /** JSON-decoded value → PHP value with object markers (see file header). */
    public static function fromJson($v)
    {
        if ($v instanceof stdClass) {
            $a = [];
            foreach (get_object_vars($v) as $k => $x) $a[$k] = self::fromJson($x);
            if (array_is_list($a)) $a[self::OBJ] = true;
            return $a;
        }
        if (is_array($v)) return array_map([self::class, 'fromJson'], $v);
        return $v;
    }

    public static function isJsArray($v): bool { return is_array($v) && array_is_list($v); }

    public static function truthy($v): bool
    {
        if (is_array($v) || is_object($v)) return true;
        if (is_float($v)) return $v != 0 && !is_nan($v);
        return (bool)($v !== null && $v !== false && $v !== '' && $v !== 0);
    }

    /** JS String(v). */
    public static function jsString($v): string
    {
        if ($v === null) return 'null';
        if ($v === true) return 'true';
        if ($v === false) return 'false';
        if (is_int($v) || is_float($v)) return self::jsNum($v);
        if (is_string($v)) return $v;
        if (is_array($v)) {
            if (!array_is_list($v)) return '[object Object]';
            return implode(',', array_map(fn($x) => $x === null ? '' : self::jsString($x), $v));
        }
        return '[object Object]';
    }

    /** String(v ?? '') */
    public static function s($v): string { return $v === null ? '' : self::jsString($v); }

    /** JS Number.prototype.toString() for a PHP number. */
    public static function jsNum($n): string
    {
        if (is_int($n)) return (string)$n;
        $n = (float)$n;
        if (is_nan($n)) return 'NaN';
        if (is_infinite($n)) return $n > 0 ? 'Infinity' : '-Infinity';
        if ($n == 0) return '0';
        $j = json_encode($n); // shortest round-trip digits (serialize_precision = -1)
        if (!preg_match('/^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/', $j, $m)) return $j;
        $sign = $m[1];
        $int = $m[2];
        $frac = $m[3] ?? '';
        $exp = isset($m[4]) ? (int)$m[4] : 0;
        $digits = ltrim($int . $frac, '0');
        $lead = strlen($int . $frac) - strlen($digits); // leading zeros removed
        $pointPos = strlen($int) + $exp - $lead;          // decimal point position relative to digits
        $digits = rtrim($digits, '0');
        $k = strlen($digits);
        $nn = $pointPos;
        if ($k <= $nn && $nn <= 21) $out = $digits . str_repeat('0', $nn - $k);
        elseif (0 < $nn && $nn <= 21) $out = substr($digits, 0, $nn) . '.' . substr($digits, $nn);
        elseif (-6 < $nn && $nn <= 0) $out = '0.' . str_repeat('0', -$nn) . $digits;
        else {
            $e = $nn - 1;
            $out = $digits[0] . ($k > 1 ? '.' . substr($digits, 1) : '') . 'e' . ($e >= 0 ? '+' : '-') . abs($e);
        }
        return $sign . $out;
    }

    /** JS Math.round (ties toward +∞). */
    public static function jsRound($x): float
    {
        $x = (float)$x;
        if (is_nan($x) || is_infinite($x)) return $x;
        $f = floor($x);
        $r = ($x - $f >= 0.5) ? $f + 1 : $f;
        return $r == 0 ? 0.0 : $r;
    }

    /** JS Number(n).toFixed(digits). */
    public static function toFixed($n, int $digits): string
    {
        $x = (float)$n;
        if (is_nan($x)) return 'NaN';
        if (abs($x) >= 1e21) return self::jsNum($x);
        $neg = $x < 0;
        [$ip, $fp] = explode('.', sprintf('%.40F', abs($x))); // exact enough to decide ties
        $D = $ip . substr($fp, 0, $digits);
        $rest = substr($fp, $digits);
        if ($rest !== '' && $rest[0] >= '5') { // nearest; ties go to the larger value (like JS)
            $i = strlen($D) - 1;
            while ($i >= 0 && $D[$i] === '9') { $D[$i] = '0'; $i--; }
            $D = $i < 0 ? '1' . $D : substr_replace($D, (string)((int)$D[$i] + 1), $i, 1);
        }
        $D = str_pad(ltrim($D, '0'), $digits + 1, '0', STR_PAD_LEFT);
        $out = $digits > 0 ? substr($D, 0, -$digits) . '.' . substr($D, -$digits) : $D;
        if ($neg) $out = '-' . $out; // JS: (-0.001).toFixed(2) === '-0.00'
        return $out;
    }

    public static function jsTrim(string $s): string
    {
        $r = preg_replace('/^[' . self::WS . ']+|[' . self::WS . ']+$/uD', '', $s);
        return $r === null ? trim($s) : $r;
    }

    public static function lower(string $s): string { return function_exists('mb_strtolower') ? mb_strtolower($s, 'UTF-8') : strtolower($s); }
    public static function slice(string $s, int $max): string { return function_exists('mb_substr') ? mb_substr($s, 0, $max, 'UTF-8') : substr($s, 0, $max); }
    public static function len(string $s): int { return function_exists('mb_strlen') ? mb_strlen($s, 'UTF-8') : strlen($s); }

    // ───────── helpers (core.js exports) ─────────
    public static function norm($v): string
    {
        $s = self::lower(self::jsTrim(self::s($v)));
        $s = str_replace(["\u{201C}", "\u{201D}", "\u{2033}"], '"', $s);
        $r = preg_replace('/[' . self::WS . ']+/u', ' ', $s);
        return $r === null ? $s : $r;
    }

    public static function num($v): float
    {
        if (is_int($v) || is_float($v)) $str = self::jsNum($v);
        else $str = self::s($v);
        $str = preg_replace('/[^0-9.\-]/', '', $str);
        if (preg_match('/^-?(?:\d+\.?\d*|\.\d+)/', $str, $m)) return (float)$m[0];
        return 0.0;
    }

    public static function r2($n): float { return self::jsRound((float)$n * 100) / 100; }
    public static function r3($n): float { return self::jsRound((float)$n * 1000) / 1000; }

    public static function list($v): array
    {
        $out = [];
        foreach (explode(',', self::s($v)) as $x) { $x = self::jsTrim($x); if ($x !== '') $out[] = $x; }
        return $out;
    }

    public static function yes($v): bool { return (bool)preg_match('/^(y|yes|true|1)$/iD', self::jsTrim(self::s($v))); }

    public static function esc($v): string
    {
        return str_replace(['&', '<', '>', '"'], ['&amp;', '&lt;', '&gt;', '&quot;'], self::s($v));
    }

    public static function money($n): string { return '$' . self::toFixed(self::truthy($n) ? (float)$n : 0.0, 2); }

    public static function orderNo($id): int { return 1000 + (int)$id; }

    public static function settingsWithDefaults($stored): array
    {
        $out = [];
        foreach (self::settingsDefs() as $k => $d) {
            $v = is_array($stored) ? ($stored[$k] ?? null) : null;
            $out[$k] = ($v !== null && $v !== '') ? self::jsString($v) : $d[0];
        }
        return $out;
    }

    public static function displayTime($t): string
    {
        $t = self::truthy($t) ? self::jsString($t) : '';
        if (!preg_match('/^(\d{1,2}):(\d{2})/', $t, $m)) return $t;
        $h = (int)$m[1];
        return ((($h + 11) % 12) + 1) . ':' . $m[2] . ($h < 12 ? ' AM' : ' PM');
    }

    public static function displayDate($d): string
    {
        $d = self::truthy($d) ? self::jsString($d) : '';
        if (!preg_match('/^(\d{4})-(\d{2})-(\d{2})$/D', $d, $m)) return $d;
        $ts = gmmktime(12, 0, 0, (int)$m[2], (int)$m[3], (int)$m[1]);
        return gmdate('D, M j, Y', $ts);
    }

    /** Today's date (YYYY-MM-DD) in the business's time zone. */
    public static function todayIn($tz): string
    {
        try { return (new DateTime('now', new DateTimeZone((string)$tz)))->format('Y-m-d'); }
        catch (Throwable $e) { return gmdate('Y-m-d'); }
    }

    public static function addDays(string $ymd, $days): string
    {
        $p = array_map('intval', explode('-', $ymd) + [0, 0, 0]);
        $ts = gmmktime(0, 0, 0, $p[1], (int)($p[2] + $days), $p[0]);
        return gmdate('Y-m-d', $ts);
    }

    // ───────── form config ─────────
    public static function formConfig($settings, array $products, array $choices): array
    {
        $s = self::settingsWithDefaults($settings);
        $lists = [];
        foreach ($choices as $c) {
            if (self::truthy($c['list'] ?? null) && self::truthy($c['choice'] ?? null)) {
                $lists[self::jsTrim(self::jsString($c['list']))][] = self::jsTrim(self::jsString($c['choice']));
            }
        }
        $prods = [];
        foreach ($products as $p) {
            if (!self::truthy($p['product'] ?? null) || !self::truthy($p['size'] ?? null)) continue;
            $prods[] = [
                'product' => self::jsTrim(self::jsString($p['product'])), 'size' => self::jsTrim(self::jsString($p['size'])),
                'choice1' => self::jsTrim(self::truthy($p['choice1'] ?? null) ? self::jsString($p['choice1']) : ''),
                'choice2' => self::jsTrim(self::truthy($p['choice2'] ?? null) ? self::jsString($p['choice2']) : ''),
            ];
        }
        return [
            'businessName' => $s['business_name'],
            'eventTypes' => self::list($s['event_types']),
            'paymentMethods' => self::list($s['payment_methods']),
            'cardMethod' => self::jsTrim($s['card_fee_method']),
            'cardFeePct' => self::num($s['card_fee_pct']),
            'terms' => $s['terms'],
            'products' => $prods,
            'lists' => (object)$lists,
        ];
    }

    // ───────── validation ─────────
    private static function str($v, int $max = 500): string { return self::slice(self::jsTrim(self::s($v)), $max); }

    /** Returns a cleaned order or throws OrderError with a customer-friendly message. */
    public static function cleanOrder($f): array
    {
        if (!is_array($f)) throw new OrderError('Empty form.');
        $g = fn($k) => $f[$k] ?? null;
        $o = [
            'name' => self::str($g('name'), 120), 'email' => self::str($g('email'), 200), 'phone' => self::str($g('phone'), 40),
            'eventType' => self::str($g('eventType'), 80), 'eventDate' => self::str($g('eventDate'), 10), 'fulfillment' => self::str($g('fulfillment'), 20),
            'time' => self::str($g('time'), 5), 'address' => self::str($g('address'), 300), 'allergies' => self::str($g('allergies'), 500), 'notes' => self::str($g('notes'), 3000),
            'paymentMethod' => self::str($g('paymentMethod'), 60), 'initials' => self::str($g('initials'), 6), 'agreed' => $g('agreed') === true,
            'signature' => self::truthy($g('signature')) ? self::jsString($g('signature')) : '',
        ];
        $nws = '[^' . self::WS . ']+';
        $miss = [];
        if ($o['name'] === '') $miss[] = 'name';
        if (!preg_match('/^' . $nws . '@' . $nws . '\.' . $nws . '$/uD', $o['email'])) $miss[] = 'a valid email';
        if (strlen(preg_replace('/\D/', '', $o['phone'])) < 7) $miss[] = 'phone';
        if (!preg_match('/^\d{4}-\d{2}-\d{2}$/D', $o['eventDate'])) $miss[] = 'date';
        if ($o['fulfillment'] === '') $miss[] = 'pickup or delivery';
        if ($o['fulfillment'] === 'Delivery' && $o['address'] === '') $miss[] = 'delivery address';
        if ($o['paymentMethod'] === '') $miss[] = 'payment method';
        if ($o['initials'] === '') $miss[] = 'initials';
        if ($miss) throw new OrderError('Please fill in: ' . implode(', ', $miss) . '.');
        if (!$o['agreed']) throw new OrderError('You must agree to the terms and conditions.');
        if (!preg_match('/^data:image\/png;base64,[A-Za-z0-9+\/=]+$/D', $o['signature']) || self::len($o['signature']) < 200) throw new OrderError('Please sign the form.');
        if (self::len($o['signature']) > 600000) throw new OrderError('Signature image is too large.');
        if ($o['time'] !== '' && !preg_match('/^\d{2}:\d{2}$/D', $o['time'])) $o['time'] = '';
        $items = self::isJsArray($g('items')) ? array_slice($g('items'), 0, 30) : [];
        $o['items'] = [];
        foreach ($items as $it) {
            if (!is_array($it)) $it = [];
            $q = self::num($it['qty'] ?? null);
            $clean = [
                'product' => self::str($it['product'] ?? null, 80), 'size' => self::str($it['size'] ?? null, 80),
                'choice1' => self::str($it['choice1'] ?? null, 80), 'choice2' => self::str($it['choice2'] ?? null, 80),
                'qty' => (int)min(999, max(1, self::jsRound($q != 0 ? $q : 1))), 'notes' => self::str($it['notes'] ?? null, 2000),
            ];
            if ($clean['product'] !== '' && $clean['size'] !== '') $o['items'][] = $clean;
        }
        if (!$o['items']) throw new OrderError('Please add at least one item.');
        return $o;
    }

    // ───────── pricing ─────────
    public static function priceOrder(array $items, array $products, $paymentMethod, $settings): array
    {
        $s = self::settingsWithDefaults($settings);
        $lines = [];
        foreach ($items as $it) {
            $p = null;
            foreach ($products as $x) {
                if (self::norm($x['product'] ?? null) === self::norm($it['product'] ?? null) && self::norm($x['size'] ?? null) === self::norm($it['size'] ?? null)) { $p = $x; break; }
            }
            $unit = $p ? self::num($p['price'] ?? null) : 0.0;
            $lines[] = ['item' => $it, 'unitPrice' => $unit, 'amount' => self::r2($unit * (float)$it['qty'])];
        }
        $sum = 0.0;
        foreach ($lines as $l) $sum += $l['amount'];
        $subtotal = self::r2($sum);
        $isCard = $s['card_fee_method'] !== '' && self::norm($paymentMethod) === self::norm($s['card_fee_method']);
        $pct = $isCard ? self::num($s['card_fee_pct']) : 0.0;
        $fee = self::r2($subtotal * $pct / 100);
        return ['lines' => $lines, 'subtotal' => $subtotal, 'fee' => $fee, 'feePct' => $pct, 'total' => self::r2($subtotal + $fee)];
    }

    // ───────── ingredients & inventory ─────────
    private static function qtyOf(array $it): float
    {
        $q = $it['qty'] ?? null;
        return self::truthy($q) ? (float)$q : 1.0;
    }

    /** Returns ['needs' => [ingredient => amount], 'missing' => [...]]. */
    public static function computeNeeds(array $items, array $recipes): array
    {
        $index = [];
        foreach ($recipes as $r) {
            if (!self::truthy($r['recipe'] ?? null) || !self::truthy($r['ingredient'] ?? null)) continue;
            $ns = self::norm($r['size'] ?? null);
            $key = self::norm($r['recipe']) . '|' . ($ns !== '' ? $ns : '*');
            $index[$key][] = $r;
        }
        $needs = [];
        $missing = [];
        foreach ($items as $it) {
            $parts = [];
            foreach ([$it['product'] ?? null, $it['choice1'] ?? null, $it['choice2'] ?? null] as $x) {
                if (self::truthy($x) && self::jsTrim(self::jsString($x)) !== '') $parts[] = $x;
            }
            foreach ($parts as $i => $name) {
                $rows = array_merge($index[self::norm($name) . '|' . self::norm($it['size'] ?? null)] ?? [], $index[self::norm($name) . '|*'] ?? []);
                if (!$rows && $i > 0) $missing[] = self::jsString($name) . ' (' . self::s($it['size'] ?? null) . ')';
                foreach ($rows as $r) {
                    $ing = self::jsTrim(self::jsString($r['ingredient']));
                    $needs[$ing] = self::r3(($needs[$ing] ?? 0.0) + self::num($r['amount'] ?? null) * self::qtyOf($it));
                }
            }
        }
        $out = [];
        foreach ($needs as $k => $v) $out[(string)$k] = $v;
        return ['needs' => $out, 'missing' => $missing];
    }

    /** openOrders: [['items' => [...]]]. Returns rows with reserved/left plus problems. */
    public static function inventoryStatus(array $inventory, array $openOrders, array $recipes): array
    {
        $reserved = [];
        $missing = [];
        foreach ($openOrders as $o) {
            $r = self::computeNeeds(is_array($o['items'] ?? null) ? $o['items'] : [], $recipes);
            foreach ($r['needs'] as $k => $v) { $nk = self::norm((string)$k); $reserved[$nk] = self::r3(($reserved[$nk] ?? 0.0) + $v); }
            foreach ($r['missing'] as $m) $missing[$m] = true;
        }
        $known = [];
        $rows = [];
        foreach ($inventory as $i) {
            if (!self::truthy($i['ingredient'] ?? null)) continue;
            $known[self::norm($i['ingredient'])] = true;
            $onHand = self::num($i['on_hand'] ?? null);
            $res = $reserved[self::norm($i['ingredient'])] ?? 0;
            $left = self::r3($onHand - $res);
            $keep = self::num($i['keep_at_least'] ?? null);
            $rows[] = ['ingredient' => $i['ingredient'], 'unit' => self::truthy($i['unit'] ?? null) ? $i['unit'] : '', 'onHand' => $onHand, 'keepAtLeast' => $keep,
                'reserved' => $res, 'left' => $left, 'state' => $left < 0 ? 'short' : (($keep != 0 && $left < $keep) ? 'low' : 'ok')];
        }
        $unknown = [];
        foreach ($reserved as $k => $v) if (!isset($known[(string)$k])) $unknown[] = (string)$k;
        return ['rows' => $rows, 'missingRecipes' => array_map('strval', array_keys($missing)), 'unknownIngredients' => $unknown];
    }

    public static function shoppingList(array $rows): array
    {
        $out = [];
        foreach ($rows as $r) {
            $buy = self::r3(max(self::truthy($r['keepAtLeast'] ?? null) ? (float)$r['keepAtLeast'] : 0.0, 0.0) - $r['left']);
            if ($buy > 0) $out[] = ['ingredient' => $r['ingredient'], 'unit' => $r['unit'], 'buy' => $buy, 'left' => $r['left']];
        }
        return $out;
    }

    public static function shortagesForOrder(array $items, array $status, array $recipes): array
    {
        $used = self::computeNeeds($items, $recipes);
        $byName = [];
        foreach ($status['rows'] as $r) $byName[self::norm($r['ingredient'])] = $r;
        $out = ['short' => [], 'low' => [], 'missingRecipes' => $used['missing'], 'unknownIngredients' => []];
        foreach (array_keys($used['needs']) as $ing) {
            $ing = (string)$ing;
            $r = $byName[self::norm($ing)] ?? null;
            if (!$r) $out['unknownIngredients'][] = $ing;
            elseif ($r['state'] === 'short') $out['short'][] = $r;
            elseif ($r['state'] === 'low') $out['low'][] = $r;
        }
        return $out;
    }

    /** Ingredient amounts to subtract when an order is marked Done. */
    public static function deductions(array $items, array $recipes): array { return self::computeNeeds($items, $recipes)['needs']; }

    // ───────── text summaries ─────────
    public static function itemLabel(array $it): string
    {
        $c1 = $it['choice1'] ?? null; $c2 = $it['choice2'] ?? null;
        $ch = array_map([self::class, 'jsString'], array_values(array_filter([$c1, $c2], [self::class, 'truthy'])));
        return self::s($it['qty'] ?? null) . ' × ' . self::s($it['size'] ?? null) . ' ' . self::s($it['product'] ?? null) .
            ((self::truthy($c1) || self::truthy($c2)) ? ' – ' . implode(' / ', $ch) : '');
    }

    public static function itemsSummary(array $items): string
    {
        return implode("\n", array_map(fn($it) => '• ' . self::itemLabel($it) . (self::truthy($it['notes'] ?? null) ? ' (' . self::jsString($it['notes']) . ')' : ''), $items));
    }

    public static function shortItems(array $items): string
    {
        return implode(', ', array_map(fn($it) => (($it['qty'] ?? 0) > 1 ? self::jsString($it['qty']) . '× ' : '') . self::s($it['size'] ?? null) . ' ' . self::s($it['product'] ?? null), $items));
    }

    private static function hrow($k, $v): string
    {
        return self::truthy($v) ? '<tr><td style="color:#666;padding:3px 12px 3px 0;vertical-align:top">' . self::esc($k) . '</td><td style="padding:3px 0"><b>' . self::esc($v) . '</b></td></tr>' : '';
    }

    /** order: row shape (id, name, email, phone, event_type, event_date, time, fulfillment, address, items, ...). */
    public static function orderHtml(array $o, bool $forCustomer = false): string
    {
        $items = '<ol style="margin:4px 0 0 18px;padding:0">' . implode('', array_map(fn($it) =>
            '<li style="margin-bottom:6px"><b>' . self::esc(self::itemLabel($it)) . '</b>' . (self::truthy($it['notes'] ?? null) ? '<br><span style="color:#555">' . self::esc($it['notes']) . '</span>' : '') . '</li>', $o['items'])) . '</ol>';
        $pay = $forCustomer ? '' : self::hrow('Starting price', self::money($o['subtotal'] ?? null)) . (self::truthy($o['fee'] ?? null) ? self::hrow('Card fee', self::money($o['fee'])) : '') . self::hrow('Total', self::money($o['total'] ?? null));
        $event = implode(' · ', array_map([self::class, 'jsString'], array_values(array_filter([$o['event_type'] ?? null, self::displayDate($o['event_date'] ?? null), self::displayTime($o['time'] ?? null)], [self::class, 'truthy']))));
        $isDel = ($o['fulfillment'] ?? null) === 'Delivery';
        $fulLabel = $isDel ? 'Deliver to' : 'Pickup / delivery';
        $fulValue = $isDel ? ($o['address'] ?? null) : (self::truthy($o['fulfillment'] ?? null) ? $o['fulfillment'] : 'Pickup');
        return '<h3 style="margin:0 0 6px">Order #' . self::orderNo($o['id']) . ' – ' . self::esc($o['name'] ?? null) . '</h3><table style="font-size:14px">' .
            self::hrow('Event', $event) .
            self::hrow($fulLabel, $fulValue) . self::hrow('Phone', $o['phone'] ?? null) . self::hrow('Email', $o['email'] ?? null) . self::hrow('Payment', $o['payment_method'] ?? null) . $pay .
            self::hrow('Allergies', $o['allergies'] ?? null) . self::hrow('Notes', $o['notes'] ?? null) . '</table><div style="margin-top:8px"><b>Items</b>' . $items . '</div>';
    }

    public static function shortageHtml($sh): string
    {
        if (!$sh) return '';
        $h = '';
        if ($sh['short']) $h .= '<div style="background:#fde8e8;border:1px solid #e0a0a0;padding:12px;border-radius:8px;margin-bottom:14px"><b>⚠️ You don\'t have enough for all your open orders. Buy:</b><ul>' .
            implode('', array_map(fn($r) => '<li><b>' . self::jsNum(self::r2(-$r['left'])) . ' ' . self::esc($r['unit']) . '</b> ' . self::esc($r['ingredient']) . '</li>', $sh['short'])) . '</ul></div>';
        if ($sh['low']) $h .= '<p>🔸 Running low: ' . implode(', ', array_map(fn($r) => self::esc($r['ingredient']) . ' (' . self::jsNum(self::r2($r['left'])) . ' ' . self::esc($r['unit']) . ' left)', $sh['low'])) . '</p>';
        if ($sh['missingRecipes'] || $sh['unknownIngredients']) $h .= '<p style="color:#8a5a00">ℹ️ Couldn\'t count everything: ' .
            ($sh['missingRecipes'] ? 'no recipe for ' . self::esc(implode(', ', $sh['missingRecipes'])) . '. ' : '') .
            ($sh['unknownIngredients'] ? 'Not on inventory: ' . self::esc(implode(', ', $sh['unknownIngredients'])) . '.' : '') . '</p>';
        return $h;
    }

    /** $opts: ['shortages' => ?, 'links' => [label => url], 'problems' => [...]] */
    public static function ownerEmail(array $o, array $opts): array
    {
        $shortages = $opts['shortages'] ?? null;
        $links = $opts['links'] ?? [];
        $problems = $opts['problems'] ?? [];
        $parts = [];
        foreach ($links as $k => $u) if (self::truthy($u)) $parts[] = '<a href="' . self::esc($u) . '">' . self::esc((string)$k) . '</a>';
        $linkHtml = implode(' · ', $parts);
        return [
            'subject' => (($shortages && $shortages['short']) ? '⚠️ SHORT ON INGREDIENTS – ' : '') . 'New order #' . self::orderNo($o['id']) . ': ' . self::s($o['name'] ?? null) . ' – ' . self::displayDate($o['event_date'] ?? null),
            'html' => self::shortageHtml($shortages) . ($linkHtml !== '' ? '<p>' . $linkHtml . '</p>' : '') . self::orderHtml($o) .
                ($problems ? '<p style="color:#b00"><b>Needs your attention:</b><br>' . implode('<br>', array_map([self::class, 'esc'], $problems)) . '</p>' : ''),
        ];
    }

    public static function customerEmail(array $o, $settings): array
    {
        $s = self::settingsWithDefaults($settings);
        return [
            'subject' => $s['business_name'] . ' – we received your order form (#' . self::orderNo($o['id']) . ')',
            'html' => '<p>Hi ' . self::esc(explode(' ', self::s($o['name'] ?? null))[0]) . ',</p><p>Thank you! We received your order form. We\'ll review it and send your invoice shortly.</p>' .
                self::orderHtml($o, true) . self::signedBlockHtml($o) . '<p>– ' . self::esc($s['business_name']) . '</p>',
        ];
    }

    /** Terms snapshot + initials + signature, for the signed copy and the customer email. */
    public static function signedBlockHtml(array $o): string
    {
        return '<h3>Terms &amp; Conditions agreed to</h3><div style="white-space:pre-wrap;font-size:12px;border:1px solid #ddd;padding:10px;border-radius:6px">' . self::esc($o['terms_text'] ?? null) . '</div>' .
            '<p><b>I agree:</b> ✔ &nbsp; <b>Initials:</b> ' . self::esc($o['initials'] ?? null) . ' &nbsp; <b>Signed:</b> ' . self::esc($o['terms_accepted_at'] ?? null) . '</p>' .
            (self::truthy($o['signature'] ?? null) ? '<p><b>Signature:</b><br><img alt="signature" src="' . self::jsString($o['signature']) . '" style="height:90px;border-bottom:1px solid #999"></p>' : '');
    }

    public static function weeklyEmail(array $status, array $weekOrders): array
    {
        $list = self::shoppingList($status['rows']);
        $h = '<h2>🛒 Shopping list</h2>' . ($list
            ? '<table cellpadding="6" style="border-collapse:collapse">' . implode('', array_map(fn($r) => '<tr><td>☐</td><td><b>' . self::jsNum($r['buy']) . ' ' . self::esc($r['unit']) . '</b></td><td>' . self::esc($r['ingredient']) . '</td></tr>', $list)) . '</table>'
            : '<p>Nothing to buy – you have enough for all open orders. 🎉</p>');
        $h .= '<h2>📅 This week\'s orders (' . count($weekOrders) . ')</h2>' . ($weekOrders ? '<ul>' . implode('', array_map(fn($o) =>
            '<li><b>' . self::esc(self::displayDate($o['event_date'] ?? null)) . (self::truthy($o['time'] ?? null) ? ' ' . self::esc(self::displayTime($o['time'])) : '') . '</b> – ' . self::esc($o['name'] ?? null) . ' (' . self::esc($o['status'] ?? null) . '): ' . self::esc(self::shortItems($o['items'])) . '</li>', $weekOrders)) . '</ul>' : '<p>No orders this week.</p>');
        $h .= '<h2>📦 Inventory</h2><table cellpadding="4" style="border-collapse:collapse;font-size:13px"><tr style="background:#f3f3f3"><th align="left">Ingredient</th><th>Have</th><th>For orders</th><th>Left after</th></tr>' .
            implode('', array_map(fn($r) => '<tr><td>' . self::esc($r['ingredient']) . '</td><td align="center">' . self::jsNum($r['onHand']) . ' ' . self::esc($r['unit']) . '</td><td align="center">' . self::jsNum($r['reserved']) . '</td><td align="center" style="color:' . ($r['state'] === 'short' ? '#c00' : ($r['state'] === 'low' ? '#b36b00' : '#222')) . '"><b>' . self::jsNum($r['left']) . '</b></td></tr>', $status['rows'])) . '</table>';
        if ($status['missingRecipes']) $h .= '<p style="color:#8a5a00">ℹ️ No recipe on file for: ' . self::esc(implode(', ', $status['missingRecipes'])) . '</p>';
        if ($status['unknownIngredients']) $h .= '<p style="color:#8a5a00">ℹ️ Not on inventory: ' . self::esc(implode(', ', $status['unknownIngredients'])) . '</p>';
        return ['subject' => '🛒 Weekly shopping list & orders', 'html' => $h];
    }

    // ───────── Square ─────────
    public static function squareOrderBody(array $o, array $pricing, $locationId, $customerId, $settings, string $uuid): array
    {
        $s = self::settingsWithDefaults($settings);
        $lineItems = [];
        foreach ($pricing['lines'] as $l) {
            $it = $l['item'];
            $c1 = $it['choice1'] ?? null; $c2 = $it['choice2'] ?? null;
            $ch = array_map([self::class, 'jsString'], array_values(array_filter([$c1, $c2], [self::class, 'truthy'])));
            $li = ['name' => self::s($it['size'] ?? null) . ' ' . self::s($it['product'] ?? null) . ((self::truthy($c1) || self::truthy($c2)) ? ' – ' . implode(' / ', $ch) : ''),
                'quantity' => self::jsString($it['qty']), 'base_price_money' => ['amount' => (int)self::jsRound($l['unitPrice'] * 100), 'currency' => $s['currency']]];
            if (self::truthy($it['notes'] ?? null)) $li['note'] = self::slice(self::jsString($it['notes']), 2000);
            $lineItems[] = $li;
        }
        $body = [
            'idempotency_key' => $uuid,
            'order' => ['location_id' => $locationId, 'customer_id' => $customerId, 'reference_id' => (string)self::orderNo($o['id']), 'line_items' => $lineItems],
        ];
        if ($pricing['fee'] > 0) $body['order']['service_charges'] = [['name' => 'Credit card fee (' . self::jsNum($pricing['feePct']) . '%)', 'percentage' => self::jsNum($pricing['feePct']), 'calculation_phase' => 'SUBTOTAL_PHASE']];
        return $body;
    }

    public static function squareInvoiceBody(array $o, $locationId, $customerId, $squareOrderId, $settings, string $uuid): array
    {
        $s = self::settingsWithDefaults($settings);
        $today = self::todayIn($s['timezone']);
        $due = self::addDays(self::s($o['event_date'] ?? null), -self::num($s['invoice_due_days']));
        if (strcmp($due, $today) < 0) $due = $today;
        $no = self::orderNo($o['id']);
        return [
            'idempotency_key' => $uuid,
            'invoice' => [
                'location_id' => $locationId, 'order_id' => $squareOrderId, 'primary_recipient' => ['customer_id' => $customerId],
                'payment_requests' => [['request_type' => 'BALANCE', 'due_date' => $due]], 'delivery_method' => 'EMAIL',
                'accepted_payment_methods' => ['card' => true, 'square_gift_card' => false, 'bank_account' => false, 'buy_now_pay_later' => false, 'cash_app_pay' => false],
                'invoice_number' => (string)$no,
                'title' => (self::truthy($o['event_type'] ?? null) ? self::jsString($o['event_type']) . ' – ' : '') . 'Order #' . $no,
                'description' => 'Event date: ' . self::displayDate($o['event_date'] ?? null) . (self::truthy($o['time'] ?? null) ? ' ' . self::displayTime($o['time']) : '') .
                    ' (' . self::s($o['fulfillment'] ?? null) . ")\nPayment method chosen: " . self::s($o['payment_method'] ?? null),
            ],
        ];
    }

    public static function squareCustomerBody(array $o, string $uuid): array
    {
        $parts = preg_split('/[' . self::WS . ']+/u', self::jsTrim(self::s($o['name'] ?? null)));
        $body = ['idempotency_key' => $uuid, 'given_name' => $parts[0], 'family_name' => implode(' ', array_slice($parts, 1)), 'email_address' => $o['email'] ?? null];
        $d = preg_replace('/\D/', '', self::s($o['phone'] ?? null));
        if (strlen($d) === 10) $body['phone_number'] = '+1' . $d;
        elseif (strlen($d) === 11 && $d[0] === '1') $body['phone_number'] = '+' . $d;
        return $body;
    }

    // ───────── Calendar (.ics) ─────────
    private static function icsEsc($v): string
    {
        $s = str_replace(['\\', ';', ','], ['\\\\', '\\;', '\\,'], self::s($v));
        return preg_replace('/\r?\n/', '\\n', $s);
    }

    private static function fold(string $line): string
    {
        $out = [];
        while (self::len($line) > 74) {
            $out[] = self::slice($line, 74);
            $line = ' ' . (function_exists('mb_substr') ? mb_substr($line, 74, null, 'UTF-8') : substr($line, 74));
        }
        $out[] = $line;
        return implode("\r\n", $out);
    }

    /** One calendar with an event per order (floating local times = your own time zone). */
    public static function buildIcs(array $orders, $settings, ?string $method = null): string
    {
        $s = self::settingsWithDefaults($settings);
        $stamp = gmdate('Ymd\THis\Z');
        $lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Order System//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:' . self::icsEsc($s['business_name']) . ' Orders', 'X-PUBLISHED-TTL:PT1H'];
        if ($method) $lines[] = 'METHOD:' . $method;
        foreach ($orders as $o) {
            $date = self::s($o['event_date'] ?? null);
            $d = str_replace('-', '', $date);
            $st = $o['status'] ?? null;
            $pre = $st === 'Cancelled' ? '❌ CANCELLED – ' : ($st === 'New' ? '⏳ ' : ($st === 'Done' ? '✅ ' : ''));
            array_push($lines, 'BEGIN:VEVENT', 'UID:order-' . self::s($o['id'] ?? null) . '@orders', 'DTSTAMP:' . $stamp);
            $time = self::truthy($o['time'] ?? null) ? self::jsString($o['time']) : '';
            if ($time !== '') {
                [$h, $m] = array_map('intval', explode(':', $time) + [0, 0]);
                $end = $h * 60 + $m + 30;
                array_push($lines, 'DTSTART:' . $d . 'T' . preg_replace('/:/', '', $time, 1) . '00',
                    'DTEND:' . $d . 'T' . str_pad((string)(intdiv($end, 60) % 24), 2, '0', STR_PAD_LEFT) . str_pad((string)($end % 60), 2, '0', STR_PAD_LEFT) . '00');
            } else {
                array_push($lines, 'DTSTART;VALUE=DATE:' . $d, 'DTEND;VALUE=DATE:' . str_replace('-', '', self::addDays($date, 1)));
            }
            $items = is_array($o['items'] ?? null) ? $o['items'] : [];
            $ful = self::truthy($o['fulfillment'] ?? null) ? self::jsString($o['fulfillment']) : 'Pickup';
            $desc = 'Order #' . self::orderNo($o['id']) . ' (' . self::s($st) . ")\n" . self::s($o['name'] ?? null) . ' · ' . self::s($o['phone'] ?? null) . ' · ' . self::s($o['email'] ?? null) .
                "\nPayment: " . self::s($o['payment_method'] ?? null) . "\n\n" . self::itemsSummary($items) .
                (self::truthy($o['allergies'] ?? null) ? "\n\nALLERGIES: " . self::jsString($o['allergies']) : '') .
                (self::truthy($o['notes'] ?? null) ? "\n\nNotes: " . self::jsString($o['notes']) : '');
            array_push($lines, 'SUMMARY:' . self::icsEsc($pre . $ful . ': ' . self::s($o['name'] ?? null) . ' – ' . self::shortItems($items)), 'DESCRIPTION:' . self::icsEsc($desc));
            if (self::truthy($o['address'] ?? null)) $lines[] = 'LOCATION:' . self::icsEsc($o['address']);
            if ($st === 'Cancelled') $lines[] = 'STATUS:CANCELLED';
            $lines[] = 'END:VEVENT';
        }
        $lines[] = 'END:VCALENDAR';
        return implode("\r\n", array_map([self::class, 'fold'], $lines)) . "\r\n";
    }

    // ───────── Sample data (first run) ─────────
    public static function sampleData(): array
    {
        $products = array_map(fn($r) => ['product' => $r[0], 'size' => $r[1], 'price' => $r[2], 'choice1' => $r[3], 'choice2' => $r[4]], [
            ['Cake', '6" round', 85, 'Cake Flavor', 'Filling'], ['Cake', '8" round', 120, 'Cake Flavor', 'Filling'], ['Cake', '10" round', 165, 'Cake Flavor', 'Filling'],
            ['Cookies', '1 dozen', 48, 'Cookie Flavor', ''], ['Cake Pops', '1 dozen', 42, 'Cake Flavor', 'Coating'],
            ['Rice Krispie Pops', '1 dozen', 40, '', 'Coating'], ['Dessert Cups', '1 dozen', 45, 'Cake Flavor', 'Filling'],
        ]);
        $choices = array_map(fn($r) => ['list' => $r[0], 'choice' => $r[1]], [
            ['Cake Flavor', 'Vanilla'], ['Cake Flavor', 'Chocolate'], ['Cake Flavor', 'Red Velvet'], ['Cake Flavor', 'Funfetti'],
            ['Filling', 'Vanilla Buttercream'], ['Filling', 'Chocolate Ganache'], ['Filling', 'Raspberry'], ['Filling', 'Cookies & Cream'],
            ['Cookie Flavor', 'Vanilla Sugar Cookie'], ['Cookie Flavor', 'Chocolate Sugar Cookie'], ['Coating', 'White Chocolate'], ['Coating', 'Milk Chocolate'],
        ]);
        $inventory = array_map(fn($r) => ['ingredient' => $r[0], 'unit' => $r[1], 'on_hand' => $r[2], 'keep_at_least' => $r[3]], [
            ['Flour', 'cups', 40, 10], ['Sugar', 'cups', 30, 8], ['Eggs', 'each', 36, 12], ['Butter', 'sticks', 24, 8], ['Milk', 'cups', 12, 4],
            ['Cocoa powder', 'cups', 6, 2], ['Powdered sugar', 'cups', 30, 10], ['Heavy cream', 'cups', 8, 2], ['Chocolate chips', 'cups', 10, 3],
            ['Raspberry jam', 'cups', 4, 1], ['Oreo cookies', 'packs', 2, 1], ['Red food coloring', 'oz', 4, 1], ['Sprinkles', 'cups', 3, 1],
            ['Candy melts', 'lbs', 6, 2], ['Rice Krispies cereal', 'cups', 24, 6], ['Marshmallows', 'bags', 4, 2], ['Lollipop sticks', 'each', 150, 50],
            ['Treat bags', 'each', 150, 50], ['Cake boards', 'each', 10, 4], ['Cake boxes', 'each', 10, 4],
        ]);
        $sizes = ['6" round' => 0.6, '8" round' => 1, '10" round' => 1.6];
        $cakes = [
            'Vanilla' => [['Flour', 2.5], ['Sugar', 2], ['Eggs', 4], ['Butter', 2], ['Milk', 1]],
            'Chocolate' => [['Flour', 2], ['Sugar', 2], ['Eggs', 3], ['Cocoa powder', 0.75], ['Milk', 1], ['Butter', 1]],
            'Red Velvet' => [['Flour', 2.5], ['Sugar', 2], ['Eggs', 3], ['Cocoa powder', 0.25], ['Red food coloring', 1], ['Butter', 2]],
            'Funfetti' => [['Flour', 2.5], ['Sugar', 2], ['Eggs', 4], ['Butter', 2], ['Milk', 1], ['Sprinkles', 0.5]],
        ];
        $fillings = [
            'Vanilla Buttercream' => [['Butter', 2], ['Powdered sugar', 4]], 'Chocolate Ganache' => [['Chocolate chips', 1.5], ['Heavy cream', 1]],
            'Raspberry' => [['Raspberry jam', 0.75]], 'Cookies & Cream' => [['Butter', 2], ['Powdered sugar', 3], ['Oreo cookies', 0.5]],
        ];
        $R = [];
        $add = function ($recipe, $size, $ingredient, $amount, $notes = '') use (&$R) {
            $R[] = ['recipe' => $recipe, 'size' => $size, 'ingredient' => $ingredient, 'amount' => self::r2($amount), 'notes' => $notes];
        };
        foreach ($sizes as $size => $m) {
            $add('Cake', $size, 'Cake boards', 1, 'Every cake'); $add('Cake', $size, 'Cake boxes', 1, 'Every cake');
            $add('Cake', $size, 'Butter', 4 * $m, 'Outside buttercream'); $add('Cake', $size, 'Powdered sugar', 8 * $m, 'Outside buttercream');
            foreach ([$cakes, $fillings] as $g) foreach ($g as $name => $ings) foreach ($ings as [$i, $a]) $add($name, $size, $i, $a * $m);
        }
        $dz = '1 dozen';
        $add('Cookies', $dz, 'Treat bags', 12);
        foreach ([['Vanilla Sugar Cookie', []], ['Chocolate Sugar Cookie', [['Cocoa powder', 0.5]]]] as [$n, $extra]) {
            foreach (array_merge([['Flour', str_starts_with($n, 'Choc') ? 2.5 : 3], ['Sugar', 1], ['Butter', 2], ['Eggs', 1]], $extra) as [$i, $a]) $add($n, $dz, $i, $a);
            $add($n, $dz, 'Powdered sugar', 2, 'Royal icing');
        }
        $add('Cake Pops', $dz, 'Lollipop sticks', 12); $add('Cake Pops', $dz, 'Treat bags', 12);
        foreach ([['Rice Krispies cereal', 6], ['Marshmallows', 1], ['Butter', 1], ['Lollipop sticks', 12], ['Treat bags', 12]] as [$i, $a]) $add('Rice Krispie Pops', $dz, $i, $a);
        $add('White Chocolate', $dz, 'Candy melts', 0.75, 'Coating'); $add('Milk Chocolate', $dz, 'Candy melts', 0.75, 'Coating');
        foreach ($cakes as $name => $ings) foreach ($ings as [$i, $a]) $add($name, $dz, $i, $a * 0.4, 'Cake pops / dessert cups');
        foreach ($fillings as $name => $ings) foreach ($ings as [$i, $a]) $add($name, $dz, $i, $a * 0.5, 'Dessert cups');
        return ['products' => $products, 'choices' => $choices, 'inventory' => $inventory, 'recipes' => $R];
    }

    /** JSON encoding that matches JSON.stringify output as closely as possible. */
    public static function json($data): string
    {
        $flags = JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_LINE_TERMINATORS | JSON_INVALID_UTF8_SUBSTITUTE | JSON_PARTIAL_OUTPUT_ON_ERROR;
        $s = json_encode(self::forJson($data), $flags);
        return $s === false ? 'null' : $s;
    }

    /** Strip object markers; -0 → 0 (JSON.stringify prints 0). */
    private static function forJson($v)
    {
        if (is_array($v)) {
            $isObj = isset($v[self::OBJ]);
            unset($v[self::OBJ]);
            foreach ($v as $k => $x) $v[$k] = self::forJson($x);
            return ($isObj && array_is_list($v)) ? (object)$v : $v;
        }
        if ($v instanceof stdClass) { foreach (get_object_vars($v) as $k => $x) $v->$k = self::forJson($x); return $v; }
        if (is_float($v) && $v == 0) return 0.0;
        return $v;
    }
}
