<?php
// Loads config.php and builds the handler context (storage, email, Square, URLs). Used by api.php and cron.php.
require_once __DIR__ . '/core.php';
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/api.php';

function orders_config(): array
{
    static $cfg = null;
    if ($cfg !== null) return $cfg;
    $path = getenv('ORDERS_CONFIG') ?: dirname(__DIR__) . '/config.php';
    $loaded = is_file($path) ? require $path : [];
    $cfg = array_merge([
        'ADMIN_PASSWORD' => '', 'SQUARE_ACCESS_TOKEN' => '', 'FROM_EMAIL' => '',
        'DB_DSN' => '', 'DB_USER' => '', 'DB_PASS' => '', 'PUBLIC_URL' => '',
    ], is_array($loaded) ? $loaded : []);
    return $cfg;
}

function orders_uuid(): string
{
    $b = random_bytes(16);
    $b[6] = chr((ord($b[6]) & 0x0f) | 0x40);
    $b[8] = chr((ord($b[8]) & 0x3f) | 0x80);
    return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($b), 4));
}

/** Like JS new Date().toISOString(): 2026-11-17T03:15:00.123Z */
function orders_now_iso(): string
{
    return (new DateTime('now', new DateTimeZone('UTC')))->format('Y-m-d\TH:i:s.v\Z');
}

/** URL of the folder that holds api.php, with a trailing slash ('' when unknown, e.g. on the command line). */
function orders_public_url(array $cfg): string
{
    $fixed = trim((string)$cfg['PUBLIC_URL']);
    if ($fixed !== '') return rtrim($fixed, '/') . '/';
    if (empty($_SERVER['HTTP_HOST'])) return '';
    $https = (!empty($_SERVER['HTTPS']) && strtolower((string)$_SERVER['HTTPS']) !== 'off')
        || strtolower((string)($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '')) === 'https'
        || (string)($_SERVER['SERVER_PORT'] ?? '') === '443';
    $host = preg_replace('/[^A-Za-z0-9.\-:\[\]]/', '', (string)$_SERVER['HTTP_HOST']);
    $dir = str_replace('\\', '/', dirname((string)($_SERVER['SCRIPT_NAME'] ?? '/api.php')));
    $dir = rtrim($dir, '/') . '/';
    return ($https ? 'https' : 'http') . '://' . $host . $dir;
}

// ───────── Email via PHP mail() ─────────
function orders_header_value(string $v): string { return trim(str_replace(["\r", "\n", "\0"], ' ', $v)); }

/** RFC 2047 encode a header text if it is not plain ASCII (split on character boundaries). */
function orders_encode_header(string $text): string
{
    $text = orders_header_value($text);
    if (!preg_match('/[^\x20-\x7E]/', $text)) return $text;
    $chunks = [];
    $cur = '';
    foreach (preg_split('//u', $text, -1, PREG_SPLIT_NO_EMPTY) ?: str_split($text) as $ch) {
        if (strlen($cur . $ch) > 45) { $chunks[] = $cur; $cur = ''; }
        $cur .= $ch;
    }
    if ($cur !== '') $chunks[] = $cur;
    return implode("\r\n ", array_map(fn($c) => '=?UTF-8?B?' . base64_encode($c) . '?=', $chunks));
}

/** "Name <a@b.c>" or "a@b.c" → [display name, address]. */
function orders_parse_address(string $s): array
{
    $s = orders_header_value($s);
    if (preg_match('/^(.*)<([^<>\s]+@[^<>\s]+)>$/', $s, $m)) return [trim(trim($m[1]), '"'), $m[2]];
    return ['', $s];
}

function orders_format_address(string $s): string
{
    [$name, $addr] = orders_parse_address($s);
    if ($name === '') return $addr;
    $enc = preg_match('/[^\x20-\x7E]/', $name) ? orders_encode_header($name) : '"' . str_replace(['\\', '"'], ['\\\\', '\\"'], $name) . '"';
    return $enc . ' <' . $addr . '>';
}

function orders_send_mail(array $cfg, string $to, string $subject, string $html, array $attachments = [], $replyTo = null): void
{
    [, $toAddr] = orders_parse_address($to);
    if (!filter_var($toAddr, FILTER_VALIDATE_EMAIL)) throw new RuntimeException('Email failed: bad recipient address');
    [, $fromAddr] = orders_parse_address((string)$cfg['FROM_EMAIL']);
    $eol = "\r\n";
    $headers = [
        'From: ' . orders_format_address((string)$cfg['FROM_EMAIL']),
        'MIME-Version: 1.0',
        'Date: ' . date(DATE_RFC2822),
        'Message-ID: <' . bin2hex(random_bytes(12)) . '@' . (preg_replace('/^.*@/', '', $fromAddr) ?: 'localhost') . '>',
    ];
    if (is_string($replyTo) && $replyTo !== '') {
        [, $rAddr] = orders_parse_address($replyTo);
        if (filter_var($rAddr, FILTER_VALIDATE_EMAIL)) $headers[] = 'Reply-To: ' . $rAddr;
    }
    $htmlPart = 'Content-Type: text/html; charset=UTF-8' . $eol . 'Content-Transfer-Encoding: base64' . $eol . $eol . chunk_split(base64_encode($html), 76, $eol);
    if (!$attachments) {
        $headers[] = 'Content-Type: text/html; charset=UTF-8';
        $headers[] = 'Content-Transfer-Encoding: base64';
        $body = chunk_split(base64_encode($html), 76, $eol);
    } else {
        $boundary = '=_orders_' . bin2hex(random_bytes(12));
        $headers[] = 'Content-Type: multipart/mixed; boundary="' . $boundary . '"';
        $body = 'This is a multi-part message in MIME format.' . $eol . $eol . '--' . $boundary . $eol . $htmlPart;
        foreach ($attachments as $a) {
            $fname = preg_replace('/[^A-Za-z0-9._-]/', '_', (string)($a['filename'] ?? 'attachment'));
            $type = preg_replace('/[^A-Za-z0-9.\/+-]/', '', (string)($a['type'] ?? 'application/octet-stream'));
            $ctype = $type . '; charset=UTF-8' . ($type === 'text/calendar' ? '; method=PUBLISH' : '') . '; name="' . $fname . '"';
            $body .= '--' . $boundary . $eol . 'Content-Type: ' . $ctype . $eol . 'Content-Transfer-Encoding: base64' . $eol .
                'Content-Disposition: attachment; filename="' . $fname . '"' . $eol . $eol . chunk_split(base64_encode((string)($a['content'] ?? '')), 76, $eol);
        }
        $body .= '--' . $boundary . '--' . $eol;
    }
    $params = filter_var($fromAddr, FILTER_VALIDATE_EMAIL) ? '-f' . $fromAddr : '';
    $ok = @mail($toAddr, orders_encode_header($subject), $body, implode($eol, $headers), $params);
    if (!$ok) throw new RuntimeException('Email failed: mail() returned false');
}

function orders_context(string $publicUrl): array
{
    $cfg = orders_config();
    $db = new Db($cfg, dirname(__DIR__) . '/data/orders.sqlite');
    $db->ensureSeeded();
    return [
        'db' => $db,
        'adminPassword' => (string)$cfg['ADMIN_PASSWORD'],
        'squareToken' => (string)$cfg['SQUARE_ACCESS_TOKEN'],
        'sendEmail' => trim((string)$cfg['FROM_EMAIL']) !== ''
            ? fn($to, $subject, $html, $attachments = [], $replyTo = null) => orders_send_mail($cfg, (string)$to, (string)$subject, (string)$html, $attachments ?: [], $replyTo)
            : null,
        'uuid' => 'orders_uuid',
        'nowIso' => 'orders_now_iso',
        'publicUrl' => $publicUrl,
        'backendName' => 'GoDaddy',
    ];
}
