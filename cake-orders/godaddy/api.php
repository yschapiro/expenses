<?php
// JSON API entry point: api.php?r=/config, api.php?r=/orders, api.php?r=/admin/..., api.php?r=/calendar.ics&key=...
// Same routes and responses as the Cloudflare Worker's /api/* (see site/public/js/api.js).
ini_set('display_errors', '0');
ini_set('log_errors', '1');
error_reporting(E_ALL);
ob_start();

function orders_respond(int $status, string $body, string $type): void
{
    while (ob_get_level() > 0) ob_end_clean(); // drop any stray output
    http_response_code($status);
    header('Content-Type: ' . $type);
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    echo $body;
}

function orders_json(int $status, $data): void { orders_respond($status, C::json($data), 'application/json; charset=utf-8'); }

register_shutdown_function(function () {
    $e = error_get_last();
    if ($e && in_array($e['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR], true) && !headers_sent()) {
        while (ob_get_level() > 0) ob_end_clean();
        http_response_code(500);
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store');
        echo json_encode(['error' => 'Server error: ' . $e['message']], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    }
});

require_once __DIR__ . '/lib/bootstrap.php';

$method = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));
$path = isset($_GET['r']) && is_string($_GET['r']) ? $_GET['r'] : '';
if ($path !== '' && $path[0] !== '/') $path = '/' . $path;

$body = null;
if ($method === 'POST' || $method === 'PUT') {
    $text = (string)file_get_contents('php://input', false, null, 0, 1000001);
    if (strlen($text) > 1000000) { orders_json(413, ['error' => 'Too large']); exit; }
    if ($text !== '') {
        $raw = json_decode($text, false);
        if ($raw === null && json_last_error() !== JSON_ERROR_NONE) { orders_json(400, ['error' => 'Bad JSON']); exit; }
        $body = C::fromJson($raw);
    }
}

try {
    $ctx = orders_context(orders_public_url(orders_config()));
} catch (Throwable $e) {
    error_log('[orders] startup: ' . $e);
    orders_json(500, ['error' => 'Server error: ' . $e->getMessage()]);
    exit;
}

$res = Api::handle([
    'method' => $method,
    'path' => $path,
    'query' => $_GET,
    'body' => $body,
    'adminKey' => (string)($_SERVER['HTTP_X_ADMIN_KEY'] ?? ''),
    'clientInfo' => implode(' | ', array_filter([(string)($_SERVER['REMOTE_ADDR'] ?? ''), (string)($_SERVER['HTTP_USER_AGENT'] ?? '')], fn($x) => $x !== '')),
], $ctx);

if (isset($res['raw'])) orders_respond($res['status'], $res['raw'], $res['contentType']);
else orders_json($res['status'], $res['data']);
