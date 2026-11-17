<?php
// PDO storage adapter — same methods as the Cloudflare D1 adapter (cloudflare/src/index.js).
// SQLite by default (data/orders.sqlite); MySQL when DB_DSN starts with "mysql:".
require_once __DIR__ . '/core.php';

final class Db
{
    const ORDER_COLS = ['created_at', 'status', 'name', 'email', 'phone', 'event_type', 'event_date', 'fulfillment', 'time', 'address', 'items',
        'allergies', 'notes', 'payment_method', 'subtotal', 'fee', 'total', 'initials', 'terms_text', 'terms_accepted_at', 'signature',
        'client_info', 'square_invoice_id', 'square_invoice_url', 'deducted_at'];
    const INT_COLS = ['id' => 1];
    const REAL_COLS = ['price' => 1, 'on_hand' => 1, 'keep_at_least' => 1, 'amount' => 1, 'subtotal' => 1, 'fee' => 1, 'total' => 1];

    const SCHEMA_SQLITE = [
        'CREATE TABLE IF NOT EXISTS settings (`key` TEXT PRIMARY KEY, `value` TEXT)',
        'CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY, product TEXT, size TEXT, price REAL, choice1 TEXT, choice2 TEXT)',
        'CREATE TABLE IF NOT EXISTS choices (id INTEGER PRIMARY KEY, `list` TEXT, choice TEXT)',
        'CREATE TABLE IF NOT EXISTS inventory (id INTEGER PRIMARY KEY, ingredient TEXT, unit TEXT, on_hand REAL, keep_at_least REAL)',
        'CREATE TABLE IF NOT EXISTS recipes (id INTEGER PRIMARY KEY, recipe TEXT, size TEXT, ingredient TEXT, amount REAL, notes TEXT)',
        'CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT, status TEXT, name TEXT, email TEXT, phone TEXT, event_type TEXT, event_date TEXT,
            fulfillment TEXT, `time` TEXT, address TEXT, items TEXT, allergies TEXT, notes TEXT, payment_method TEXT,
            subtotal REAL, fee REAL, total REAL, initials TEXT, terms_text TEXT, terms_accepted_at TEXT, signature TEXT,
            client_info TEXT, square_invoice_id TEXT, square_invoice_url TEXT, deducted_at TEXT
        )',
        'CREATE INDEX IF NOT EXISTS orders_event_date ON orders(event_date)',
    ];

    // MySQL / MariaDB variant. MEDIUMTEXT where values can exceed 64 KB (signature ≤ 600 KB, items, terms).
    const SCHEMA_MYSQL = [
        'CREATE TABLE IF NOT EXISTS `settings` (`key` VARCHAR(191) NOT NULL PRIMARY KEY, `value` MEDIUMTEXT) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
        'CREATE TABLE IF NOT EXISTS `products` (`id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY, `product` TEXT, `size` TEXT, `price` DOUBLE, `choice1` TEXT, `choice2` TEXT) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
        'CREATE TABLE IF NOT EXISTS `choices` (`id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY, `list` TEXT, `choice` TEXT) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
        'CREATE TABLE IF NOT EXISTS `inventory` (`id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY, `ingredient` TEXT, `unit` TEXT, `on_hand` DOUBLE, `keep_at_least` DOUBLE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
        'CREATE TABLE IF NOT EXISTS `recipes` (`id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY, `recipe` TEXT, `size` TEXT, `ingredient` TEXT, `amount` DOUBLE, `notes` TEXT) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
        'CREATE TABLE IF NOT EXISTS `orders` (
            `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
            `created_at` VARCHAR(40), `status` VARCHAR(40), `name` TEXT, `email` TEXT, `phone` TEXT, `event_type` TEXT, `event_date` VARCHAR(32),
            `fulfillment` TEXT, `time` VARCHAR(32), `address` TEXT, `items` MEDIUMTEXT, `allergies` TEXT, `notes` TEXT, `payment_method` TEXT,
            `subtotal` DOUBLE, `fee` DOUBLE, `total` DOUBLE, `initials` TEXT, `terms_text` MEDIUMTEXT, `terms_accepted_at` VARCHAR(40), `signature` MEDIUMTEXT,
            `client_info` TEXT, `square_invoice_id` TEXT, `square_invoice_url` TEXT, `deducted_at` VARCHAR(40),
            KEY `orders_event_date` (`event_date`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
    ];

    private PDO $pdo;
    private bool $mysql;
    private bool $seeded = false;

    public function __construct(array $config, string $defaultSqlitePath)
    {
        $dsn = trim((string)($config['DB_DSN'] ?? ''));
        if ($dsn === '') {
            $dir = dirname($defaultSqlitePath);
            if (!is_dir($dir)) @mkdir($dir, 0700, true);
            $dsn = 'sqlite:' . $defaultSqlitePath;
        }
        $this->mysql = stripos($dsn, 'mysql:') === 0;
        if ($this->mysql && stripos($dsn, 'charset=') === false) $dsn .= ';charset=utf8mb4';
        $opts = [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC, PDO::ATTR_TIMEOUT => 10];
        $this->pdo = new PDO($dsn, $this->mysql ? (string)($config['DB_USER'] ?? '') : null, $this->mysql ? (string)($config['DB_PASS'] ?? '') : null, $opts);
        if (!$this->mysql) $this->pdo->exec('PRAGMA busy_timeout = 10000');
    }

    // ───────── helpers ─────────
    private static function q(string $id): string { return '`' . str_replace('`', '', $id) . '`'; }

    private function run(string $sql, array $params = []): PDOStatement
    {
        $st = $this->pdo->prepare($sql);
        $i = 1;
        foreach ($params as $v) {
            if ($v === null) $st->bindValue($i++, null, PDO::PARAM_NULL);
            elseif (is_int($v)) $st->bindValue($i++, $v, PDO::PARAM_INT);
            elseif (is_float($v)) $st->bindValue($i++, C::jsNum($v), PDO::PARAM_STR); // full precision
            elseif (is_bool($v)) $st->bindValue($i++, $v ? 'true' : 'false', PDO::PARAM_STR);
            elseif (is_array($v)) $st->bindValue($i++, C::jsString($v), PDO::PARAM_STR);
            else $st->bindValue($i++, (string)$v, PDO::PARAM_STR);
        }
        $st->execute();
        return $st;
    }

    /** Drivers may return numbers as strings (MySQL); give them the JS types D1 returns. */
    private static function typed(array $r): array
    {
        foreach ($r as $k => $v) {
            if ($v === null || !is_string($v) || !is_numeric($v)) continue;
            if (isset(self::INT_COLS[$k])) $r[$k] = (int)$v;
            elseif (isset(self::REAL_COLS[$k])) $r[$k] = (float)$v;
        }
        if (isset($r['id']) && is_float($r['id'])) $r['id'] = (int)$r['id'];
        return $r;
    }

    private static function rowToOrder($r): ?array
    {
        if (!$r) return null;
        $r = self::typed($r);
        $items = json_decode((string)($r['items'] ?? '') !== '' ? (string)$r['items'] : '[]', true);
        $r['items'] = is_array($items) ? $items : [];
        return $r;
    }

    // ───────── schema & first-run seed (like ensureSeeded) ─────────
    public function ensureSeeded(): void
    {
        if ($this->seeded) return;
        try {
            $flag = $this->run('SELECT `value` FROM settings WHERE `key` = ?', ['_seeded'])->fetchColumn();
        } catch (PDOException $e) {
            foreach ($this->mysql ? self::SCHEMA_MYSQL : self::SCHEMA_SQLITE as $sql) $this->pdo->exec($sql);
            $flag = false;
        }
        if ($flag === false || $flag === null) {
            $sample = C::sampleData();
            foreach (array_keys(C::TABLES) as $t) $this->replaceTable($t, $sample[$t]);
            $this->run('REPLACE INTO settings (`key`, `value`) VALUES (?, ?)', ['_seeded', '1']);
        }
        $this->seeded = true;
    }

    // ───────── adapter interface ─────────
    public function getSettings(): array
    {
        $out = [];
        foreach ($this->run('SELECT `key`, `value` FROM settings')->fetchAll() as $r) $out[(string)$r['key']] = $r['value'];
        return $out;
    }

    public function saveSettings(array $obj): void
    {
        $this->pdo->beginTransaction();
        try {
            foreach ($obj as $k => $v) {
                if ($k === C::OBJ) continue;
                // REPLACE INTO works on both SQLite and MySQL (settings has only key + value).
                $this->run('REPLACE INTO settings (`key`, `value`) VALUES (?, ?)', [(string)$k, C::s($v)]);
            }
            $this->pdo->commit();
        } catch (Throwable $e) { $this->pdo->rollBack(); throw $e; }
    }

    public function getTable(string $name): array
    {
        $cols = C::TABLES[$name];
        $sql = 'SELECT ' . implode(', ', array_map([self::class, 'q'], $cols)) . ' FROM ' . self::q($name) . ' ORDER BY id';
        return array_map([self::class, 'typed'], $this->run($sql)->fetchAll());
    }

    public function replaceTable(string $name, array $rows): void
    {
        $cols = C::TABLES[$name];
        $ins = 'INSERT INTO ' . self::q($name) . ' (' . implode(', ', array_map([self::class, 'q'], $cols)) . ') VALUES (' . implode(', ', array_fill(0, count($cols), '?')) . ')';
        $this->pdo->beginTransaction();
        try {
            $this->pdo->exec('DELETE FROM ' . self::q($name));
            foreach ($rows as $r) $this->run($ins, array_map(fn($c) => $r[$c] ?? null, $cols));
            $this->pdo->commit();
        } catch (Throwable $e) { $this->pdo->rollBack(); throw $e; }
    }

    public function insertOrder(array $o): int
    {
        $vals = array_map(fn($c) => $c === 'items' ? C::json($o['items']) : ($o[$c] ?? ''), self::ORDER_COLS);
        $this->run('INSERT INTO orders (' . implode(', ', array_map([self::class, 'q'], self::ORDER_COLS)) . ') VALUES (' . implode(', ', array_fill(0, count(self::ORDER_COLS), '?')) . ')', $vals);
        return (int)$this->pdo->lastInsertId();
    }

    public function updateOrder(int $id, array $patch): void
    {
        $keys = array_values(array_filter(array_keys($patch), fn($k) => in_array($k, self::ORDER_COLS, true)));
        if (!$keys) return;
        $vals = array_map(fn($k) => $k === 'items' ? C::json($patch[$k]) : $patch[$k], $keys);
        $vals[] = $id;
        $this->run('UPDATE orders SET ' . implode(', ', array_map(fn($k) => self::q($k) . ' = ?', $keys)) . ' WHERE id = ?', $vals);
    }

    public function getOrder(int $id): ?array
    {
        return self::rowToOrder($this->run('SELECT * FROM orders WHERE id = ?', [$id])->fetch());
    }

    /** All orders without signature / terms_text, ordered by event date then time. */
    public function listOrders(): array
    {
        $cols = array_values(array_filter(self::ORDER_COLS, fn($c) => $c !== 'signature' && $c !== 'terms_text'));
        $sql = 'SELECT id, ' . implode(', ', array_map([self::class, 'q'], $cols)) . ' FROM orders ORDER BY event_date, `time`';
        return array_map([self::class, 'rowToOrder'], $this->run($sql)->fetchAll());
    }

    public function adjustInventory(string $ingredient, float $delta): void
    {
        $this->run('UPDATE inventory SET on_hand = ROUND(on_hand + ?, 3) WHERE lower(trim(ingredient)) = lower(trim(?))', [$delta, $ingredient]);
    }
}
