CREATE TABLE IF NOT EXISTS opportunities (
  id TEXT PRIMARY KEY,
  market_name TEXT NOT NULL,
  type TEXT NOT NULL,
  expected_profit_usd REAL NOT NULL,
  expected_profit_bps REAL NOT NULL,
  snapshot JSON NOT NULL,
  created_at INTEGER NOT NULL,
  detected_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  token_id TEXT NOT NULL,
  side TEXT NOT NULL,
  price REAL NOT NULL,
  size REAL NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  filled_size REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS fills (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  token_id TEXT NOT NULL,
  side TEXT NOT NULL,
  price REAL NOT NULL,
  size REAL NOT NULL,
  fee_usd REAL NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(order_id, token_id, price)
);

CREATE TABLE IF NOT EXISTS positions (
  token_id TEXT PRIMARY KEY,
  size REAL NOT NULL,
  avg_price REAL NOT NULL,
  unrealized_pnl REAL NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  context JSON,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_opportunities_created ON opportunities(created_at);
CREATE INDEX IF NOT EXISTS idx_opportunities_market ON opportunities(market_name);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_fills_order ON fills(order_id);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
