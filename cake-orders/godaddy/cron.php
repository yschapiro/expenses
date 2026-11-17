<?php
// Weekly shopping-list email. Run from a cPanel cron job, e.g. every Sunday at 7am:
//   0 7 * * 0  /usr/local/bin/php /home/USERNAME/public_html/orders/cron.php
// Command line only — refuses to run over the web.
if (php_sapi_name() !== 'cli') {
    http_response_code(403);
    header('Content-Type: text/plain');
    echo "Forbidden\n";
    exit;
}
require_once __DIR__ . '/lib/bootstrap.php';

try {
    $res = Api::weeklyEmail(orders_context(''));
    echo $res['sent'] ? "Weekly email sent.\n" : 'Weekly email not sent: ' . $res['reason'] . "\n";
    exit($res['sent'] ? 0 : 1);
} catch (Throwable $e) {
    fwrite(STDERR, 'Weekly email failed: ' . $e->getMessage() . "\n");
    exit(2);
}
