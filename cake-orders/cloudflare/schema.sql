-- Cloudflare D1 schema for the order system
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY, product TEXT, size TEXT, price REAL, choice1 TEXT, choice2 TEXT);
CREATE TABLE IF NOT EXISTS choices (id INTEGER PRIMARY KEY, list TEXT, choice TEXT);
CREATE TABLE IF NOT EXISTS inventory (id INTEGER PRIMARY KEY, ingredient TEXT, unit TEXT, on_hand REAL, keep_at_least REAL);
CREATE TABLE IF NOT EXISTS recipes (id INTEGER PRIMARY KEY, recipe TEXT, size TEXT, ingredient TEXT, amount REAL, notes TEXT);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT, status TEXT, name TEXT, email TEXT, phone TEXT, event_type TEXT, event_date TEXT,
  fulfillment TEXT, time TEXT, address TEXT, items TEXT, allergies TEXT, notes TEXT, payment_method TEXT,
  subtotal REAL, fee REAL, total REAL, initials TEXT, terms_text TEXT, terms_accepted_at TEXT, signature TEXT,
  client_info TEXT, square_invoice_id TEXT, square_invoice_url TEXT, deducted_at TEXT
);
CREATE INDEX IF NOT EXISTS orders_event_date ON orders(event_date);
