# Polymarket CLOB Arbitrage Bot

A production-ready TypeScript/Node.js bot for detecting and executing risk-managed arbitrage opportunities on Polymarket's CLOB.

## Features

- **Binary Complement Arbitrage**: Buy YES/NO pairs when ask(YES) + ask(NO) + buffers < 1.0
- **Multi-Outcome Arbitrage**: Buy baskets when Σ ask(outcome) + buffers < 1.0
- **Risk Management**: Global exposure limits, per-market caps, kill switch, safe mode
- **Three Modes**:
  - `dry`: Detect opportunities and alert only
  - `paper`: Simulate fills with configurable slippage
  - `live`: Real execution (disabled by default)
- **Rate Limiting**: Token bucket limiter with exponential backoff
- **Legging**: Sequential order placement with automatic hedging on failure
- **Monitoring**: Telegram alerts, SQLite logging, structured JSON logs

## Prerequisites

- Node.js 20+
- Polymarket account with API credentials
- (Optional) Telegram bot for notifications

## Installation

```bash
pnpm install
```

## Configuration

### Environment Variables (.env)

Create a `.env` file in the project root:

```bash
# Polymarket API credentials (L1 signing key)
POLYMARKET_PRIVATE_KEY=0x...

# Polymarket API credentials (L2, if required by client)
POLYMARKET_API_KEY=
POLYMARKET_API_SECRET=
POLYMARKET_API_PASSPHRASE=

# Telegram notifications (optional)
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

# Execution mode: dry | paper | live
MODE=dry

# Logging: debug | info | warn | error
LOG_LEVEL=info

# Kill switch (if set to 1, stops all trading immediately)
KILL_SWITCH=0
```

### Config File (config.json)

Create a `config.json` in the project root:

```json
{
  "marketsFile": "./markets.json",
  "pollingIntervalMs": 400,
  "minProfit": 0.002,
  "feeBps": 5,
  "slippageBps": 10,
  "maxExposureUsd": 500,
  "perMarketMaxUsd": 150,
  "dailyStopLossUsd": 100,
  "maxOpenOrders": 10,
  "orderTimeoutMs": 1500,
  "cooldownMs": 2500,
  "minTopSizeUsd": 20,
  "priceImprovementTicks": 0,
  "enableLiveTrading": false,
  "enableTelegram": true,
  "paper": {
    "fillProbability": 0.85,
    "extraSlippageBps": 5
  }
}
```

**Config Field Reference**:

| Field | Type | Description |
|-------|------|-------------|
| `marketsFile` | string | Path to markets.json watchlist |
| `pollingIntervalMs` | number | Milliseconds between book polling |
| `minProfit` | number | Min expected profit in probability terms (0.002 = 0.2%) |
| `feeBps` | number | Estimated taker fee in basis points |
| `slippageBps` | number | Slippage buffer in basis points |
| `maxExposureUsd` | number | Max global open position exposure |
| `perMarketMaxUsd` | number | Max per-market exposure |
| `dailyStopLossUsd` | number | Daily stop-loss threshold |
| `maxOpenOrders` | number | Max open orders across all markets |
| `orderTimeoutMs` | number | Timeout before canceling unfilled orders |
| `cooldownMs` | number | Cooldown after failed trade before retrying |
| `minTopSizeUsd` | number | Min notional size required on best ask |
| `priceImpactTicks` | number | Ticks to improve/worsen order price |
| `enableLiveTrading` | boolean | **MUST be true to place real orders** |
| `enableTelegram` | boolean | Enable Telegram notifications |
| `paper.fillProbability` | number | Simulated fill rate in paper mode (0-1) |
| `paper.extraSlippageBps` | number | Extra slippage in paper mode |

### Markets Watchlist (markets.json)

Create a `markets.json` in the project root:

```json
[
  {
    "name": "BTC up this hour?",
    "kind": "binary",
    "yesTokenId": "123456789",
    "noTokenId": "987654321",
    "resolutionGroup": "optional_cross_market_id"
  },
  {
    "name": "Election Winner",
    "kind": "multi",
    "outcomes": [
      { "label": "Candidate A", "tokenId": "111" },
      { "label": "Candidate B", "tokenId": "222" },
      { "label": "Candidate C", "tokenId": "333" }
    ]
  }
]
```

**How to Find Token IDs**:
1. Visit [Polymarket](https://polymarket.com)
2. Search for your market of interest
3. Click to view the market details
4. Token IDs are visible in the order book or API responses
5. Alternatively, use `pnpm bot:book --token <id>` to query the API directly

## Getting API Credentials

### Private Key (L1 Signer)

The Polymarket CLOB client requires an Ethereum private key for signing transactions:

1. Use an account you control (MetaMask, hardware wallet export, etc.)
2. Export the private key (ensure it has testnet/mainnet funds as needed)
3. Add to `.env` as `POLYMARKET_PRIVATE_KEY=0x...`

### Verify Credentials

```bash
pnpm bot:keys
```

This will validate your API credentials against Polymarket's endpoints.

## Usage

### Dry Run (Recommended First)

Detect opportunities without placing orders:

```bash
MODE=dry pnpm bot:run
```

Watch the logs for detected arbitrage opportunities. Telegram alerts (if configured) will notify you of each opportunity.

### Paper Trading

Simulate fills with slippage model:

```bash
MODE=paper pnpm bot:run
```

Orders will be "filled" according to `fillProbability` and slippage. Results are logged to SQLite.

### Live Trading

**IMPORTANT**: Only enable live trading after thorough testing.

1. Set `"enableLiveTrading": true` in `config.json`
2. Start with small exposure limits
3. Run:

```bash
MODE=live pnpm bot:run
```

### CLI Tools

**View order book**:
```bash
pnpm bot:book --token 123456789
```

**Validate credentials**:
```bash
pnpm bot:keys
```

## Build & Run

```bash
# Development (with auto-reload)
pnpm dev

# Build TypeScript
pnpm build

# Run compiled binary
pnpm start

# Run tests
pnpm test

# Run tests with UI
pnpm test:ui
```

## Safety Features

### Kill Switch

Stop all trading immediately:

```bash
# Option 1: Create a file
touch ./KILL_SWITCH

# Option 2: Set env var
KILL_SWITCH=1 pnpm bot:run
```

The bot checks for this on every cycle and will:
- Cancel all open orders
- Exit gracefully
- Log all events to SQLite

### Exposure Limits

The bot enforces:
- **Global**: `maxExposureUsd` across all open positions
- **Per-Market**: `perMarketMaxUsd` per market
- **Daily Stop-Loss**: `dailyStopLossUsd` in losses per day

If limits are exceeded, the bot will not place new orders and will hedge existing positions.

### Safe Mode

If the bot encounters repeated errors:
- Automatically switches from LIVE to DRY_RUN
- Logs the event
- Sends Telegram alert
- Requires manual restart to resume live trading

### Timeout & Hedging

For each arbitrage leg:
1. Place order A at best ask (or better per config)
2. Wait up to `orderTimeoutMs` for a fill
3. If filled, immediately place order B
4. If B fails to fill within timeout:
   - **Hedge** A by selling at best bid (market order)
   - Log the loss
   - Increment cooldown before next trade in that market

## Architecture

```
src/
├── index.ts                 # Main loop
├── cli.ts                   # CLI commands
├── config/
│   ├── schema.ts           # Zod validation schemas
│   └── load.ts             # Config loading
├── clob/
│   ├── client.ts           # Polymarket CLOB client wrapper
│   ├── books.ts            # Order book management
│   ├── orders.ts           # Order placement/cancellation
│   ├── positions.ts        # Position tracking
│   ├── rateLimit.ts        # Token bucket rate limiter
│   └── types.ts            # Type definitions
├── arb/
│   ├── math.ts             # Arbitrage math (profit calc)
│   ├── complement.ts       # Binary complement detection
│   ├── multiOutcome.ts     # Multi-outcome detection
│   ├── opportunity.ts      # Opportunity aggregation
│   └── filters.ts          # Filtering logic
├── exec/
│   ├── rounding.ts         # Price rounding to ticks
│   ├── risk.ts             # Risk enforcement
│   ├── executor.ts         # Order execution engine
│   └── hedger.ts           # Hedging on failure
├── sim/
│   ├── paperBroker.ts      # Paper trading simulation
│   └── slippage.ts         # Slippage models
├── storage/
│   ├── db.ts               # SQLite initialization
│   ├── migrations.sql      # Schema
│   └── repositories.ts     # Data access layer
├── monitoring/
│   ├── telegram.ts         # Telegram notifications
│   ├── health.ts           # Health checks
│   └── metrics.ts          # Metrics collection
└── utils/
    ├── sleep.ts            # Sleep utility
    ├── retry.ts            # Retry logic with backoff
    └── time.ts             # Time utilities
```

## Logging

Logs are written to:
1. **Console**: Pretty-printed JSON (development)
2. **SQLite**: `events` table for persistent audit trail
3. **Telegram**: Critical events and trade summaries

Each log entry includes:
- `timestamp`: ISO 8601
- `level`: debug | info | warn | error
- `tradeId`: Trade attempt identifier
- `message`: Human-readable summary
- Context fields (market, price, size, etc.)

## Data Persistence

SQLite database (`arb.db`) stores:

- **opportunities**: Detected arb opportunities with details
- **orders**: Placed orders with status tracking
- **fills**: Executed fills with prices and fees
- **positions**: Current open positions
- **events**: All log events for audit trail

## Testing

Unit tests cover critical math and risk logic:

```bash
pnpm test
```

Tests use fixtures and snapshot comparisons to ensure:
- Arbitrage profit calculations are correct
- Risk limits are properly enforced
- Price rounding works correctly
- Order execution flows are safe

## Troubleshooting

### "429 Too Many Requests"

The bot implements exponential backoff with jitter. If persistent:
- Increase `pollingIntervalMs` in config.json
- Reduce number of monitored markets
- Check for other scripts hitting the API

### "Order not filled"

Common causes:
- Price too aggressive (improve `minProfit` to be more competitive)
- Market illiquid (check `minTopSizeUsd` and book depth)
- Timeout too short (increase `orderTimeoutMs`)

### "Telegram not sending"

Check:
- `TELEGRAM_BOT_TOKEN` is valid
- `TELEGRAM_CHAT_ID` is correct (numeric ID)
- Bot has permission to send messages in chat
- `enableTelegram: true` in config.json

### Database locked

SQLite can lock during concurrent writes. The bot handles this with automatic retry. If persistent:
- Check for other processes accessing `arb.db`
- Ensure single bot instance is running

## Production Deployment

1. **Secrets Management**: Use a secrets manager (HashiCorp Vault, AWS Secrets Manager, etc.)
   - Never commit `.env` to version control
   - Rotate API keys periodically

2. **Monitoring**: Set up alerting on:
   - Safe mode activation
   - Daily stop-loss triggered
   - Kill switch activated
   - Error rate anomalies

3. **Limits**: Conservative initial settings:
   - `maxExposureUsd`: 200–500
   - `dailyStopLossUsd`: 50–100
   - `minProfit`: 0.003–0.005 (0.3–0.5%)

4. **Backups**: Regularly backup `arb.db` for audit trail

5. **Testing**: Run in `paper` mode for 24–48 hours before going live

## License

MIT

## Support

For issues or questions:
1. Check logs: `sqlite3 arb.db "SELECT * FROM events ORDER BY timestamp DESC LIMIT 20;"`
2. Review README sections above
3. Enable `LOG_LEVEL=debug` for detailed traces
