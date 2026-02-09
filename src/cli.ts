#!/usr/bin/env node

import { main } from "./index.js";

const cmd = process.argv[2];

async function run(): Promise<void> {
  switch (cmd) {
    case "run":
    case undefined:
      await main();
      break;

    case "version":
      console.log("polyarb v1.0.0");
      break;

    case "help":
    default:
      console.log(`
PolyArb — Polymarket Arbitrage Bot

Usage:
  npx tsx src/cli.ts run       Start the bot (default)
  npx tsx src/cli.ts version   Print version
  npx tsx src/cli.ts help      Show this help

Environment Variables:
  CLOB_API_KEY       Polymarket CLOB API key
  CLOB_SECRET        CLOB secret
  CLOB_PASSPHRASE    CLOB passphrase
  CLOB_HOST          CLOB host (defaults to mainnet)
  TELEGRAM_BOT_TOKEN Telegram bot token for notifications
  TELEGRAM_CHAT_ID   Telegram chat ID for notifications

Config Files:
  config.json        Bot configuration (fees, risk limits, etc.)
  markets.json       Market definitions (token IDs, types)

See README.md for full documentation.
`);
      break;
  }
}

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
