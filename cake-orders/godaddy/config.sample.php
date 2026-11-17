<?php
// Copy this file to config.php and fill it in. config.php is never served to the web (see .htaccess).
return [
    // Password for the dashboard (admin.html). Required.
    'ADMIN_PASSWORD' => '',

    // Square access token for draft invoices (optional; leave empty to skip Square).
    'SQUARE_ACCESS_TOKEN' => '',

    // Sender for emails, e.g. 'Sweet Creations <orders@yourdomain.com>'. Use an address on your own
    // GoDaddy domain so mail is delivered. Leave empty to turn email off.
    'FROM_EMAIL' => '',

    // Database. Leave DB_DSN empty to use SQLite in data/orders.sqlite (created automatically).
    // MySQL (cPanel → MySQL Databases): 'mysql:host=localhost;dbname=cpuser_orders;charset=utf8mb4'
    'DB_DSN' => '',
    'DB_USER' => '',
    'DB_PASS' => '',

    // Optional: public URL of this folder (e.g. 'https://example.com/orders/'). Detected automatically when empty.
    'PUBLIC_URL' => '',
];
