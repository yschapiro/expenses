-- Cloudflare D1 schema for the order system
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY, product TEXT, size TEXT, price REAL, choice1 TEXT, choice2 TEXT, tiered TEXT, addon TEXT);
CREATE TABLE IF NOT EXISTS choices (id INTEGER PRIMARY KEY, list TEXT, choice TEXT);
CREATE TABLE IF NOT EXISTS inventory (id INTEGER PRIMARY KEY, ingredient TEXT, unit TEXT, on_hand REAL, keep_at_least REAL);
CREATE TABLE IF NOT EXISTS recipes (id INTEGER PRIMARY KEY, recipe TEXT, size TEXT, ingredient TEXT, amount REAL, notes TEXT);
CREATE TABLE IF NOT EXISTS zones (id INTEGER PRIMARY KEY, zone TEXT, fee REAL, zips TEXT);
CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, data TEXT);
CREATE TABLE IF NOT EXISTS feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT, page TEXT, note TEXT, screenshot TEXT, status TEXT, reply TEXT);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT, status TEXT, name TEXT, email TEXT, phone TEXT, event_type TEXT, event_date TEXT,
  fulfillment TEXT, time TEXT, address TEXT, items TEXT, allergies TEXT, notes TEXT, payment_method TEXT,
  subtotal REAL, fee REAL, total REAL, initials TEXT, terms_text TEXT, terms_accepted_at TEXT, signature TEXT,
  client_info TEXT, square_invoice_id TEXT, square_invoice_url TEXT, deducted_at TEXT,
  token TEXT, design_summary TEXT, images TEXT, prefill_items TEXT, changes TEXT, needs_review INTEGER DEFAULT 0,
  zip TEXT, delivery_zone TEXT, delivery_fee REAL DEFAULT 0, payment_status TEXT, submitted_at TEXT, confirmed_email_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS orders_token ON orders(token) WHERE token <> '';
CREATE INDEX IF NOT EXISTS orders_event_date ON orders(event_date);
