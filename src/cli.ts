#!/usr/bin/env node

import { main } from "./index.js";
import { MarketScanner } from "./arb/marketScanner.js";

const cmd = process.argv[2];

async function runScan(): Promise<void> {
  const minLiq = Number(process.argv[3]) || 5_000;
  const maxLiq = Number(process.argv[4]) || 500_000;
  const minScore = Number(process.argv[5]) || 20;

  console.log(`\n🔍 Scanning Gamma API for inefficient markets...`);
  console.log(`   Liquidity range: $${minLiq.toLocaleString()} — $${maxLiq.toLocaleString()}`);
  console.log(`   Min score: ${minScore}\n`);

  const scanner = new MarketScanner({
    intervalMs: 300_000,
    minLiquidityUsd: minLiq,
    maxLiquidityUsd: maxLiq,
    minScore,
    includeNegRisk: true,
    includeBinary: true,
  });

  const candidates = await scanner.preview();
  console.log(MarketScanner.formatPreview(candidates));

  // Summary stats
  const negRiskCount = candidates.filter((c) => c.negRisk).length;
  const binaryCount = candidates.filter((c) => !c.negRisk).length;
  const withPositiveGap = candidates.filter((c) => c.gapPct !== null && c.gapPct > 0).length;

  console.log(`\n📊 Summary: ${candidates.length} candidates`);
  console.log(`   🎯 NegRisk multi-outcome: ${negRiskCount}`);
  console.log(`   📊 Binary: ${binaryCount}`);
  console.log(`   ✅ Positive gap (sum < $1): ${withPositiveGap}`);

  if (candidates.length > 0) {
    console.log(`\n💡 To use these markets, add them to markets.json or enable marketDiscoveryEnabled in config.json`);
  }
}

async function run(): Promise<void> {
  switch (cmd) {
    case "run":
    case undefined:
      await main();
      break;

    case "scan":
      await runScan();
      break;

    case "version":
      console.log("polyarb v1.0.0");
      break;

    case "help":
    default:
      console.log(`
PolyArb — Polymarket Arbitrage Bot

Usage:
  npx tsx src/cli.ts run                          Start the bot (default)
  npx tsx src/cli.ts scan [minLiq] [maxLiq] [minScore]
                                                  Scan for inefficient markets
  npx tsx src/cli.ts version                      Print version
  npx tsx src/cli.ts help                         Show this help

Scan Examples:
  npx tsx src/cli.ts scan                     Default: $5K-$500K, score >= 20
  npx tsx src/cli.ts scan 1000 100000         $1K-$100K liquidity range
  npx tsx src/cli.ts scan 500 200000 15       $500-$200K, score >= 15

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
