-- trades table
CREATE TABLE IF NOT EXISTS trades (
  id          TEXT PRIMARY KEY,
  market_name TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('complement','multi_outcome')),
  legs        TEXT NOT NULL,  -- JSON array of {tokenId, price, size, side}
  total_cost  REAL NOT NULL,
  expected_profit REAL NOT NULL,
  expected_profit_bps REAL NOT NULL,
  actual_profit REAL,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','filled','partial','hedged','failed')),
  hedged      INTEGER NOT NULL DEFAULT 0,
  hedge_loss  REAL NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
CREATE INDEX IF NOT EXISTS idx_trades_created ON trades(created_at);

-- daily summary
CREATE TABLE IF NOT EXISTS daily_stats (
  date         TEXT PRIMARY KEY,
  trades_count INTEGER NOT NULL DEFAULT 0,
  wins         INTEGER NOT NULL DEFAULT 0,
  losses       INTEGER NOT NULL DEFAULT 0,
  gross_pnl    REAL NOT NULL DEFAULT 0,
  fees_paid    REAL NOT NULL DEFAULT 0,
  net_pnl      REAL NOT NULL DEFAULT 0,
  max_drawdown REAL NOT NULL DEFAULT 0
);

-- configuration snapshots for audit
CREATE TABLE IF NOT EXISTS config_snapshots (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  config     TEXT NOT NULL,  -- JSON blob
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
