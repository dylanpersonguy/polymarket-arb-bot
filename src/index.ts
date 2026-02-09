import pino from "pino";
import { ClobClient } from "./clob/client.js";
import { loadEnv, loadConfig, loadMarkets } from "./config/load.js";
import { OrderBookManager } from "./clob/books.js";
import { detectBinaryComplementArb } from "./arb/complement.js";
import { detectMultiOutcomeArb } from "./arb/multiOutcome.js";
import { Opportunity } from "./arb/opportunity.js";
import { RiskManager } from "./exec/risk.js";
import { Executor } from "./exec/executor.js";
import { TelegramNotifier } from "./monitoring/telegram.js";
import { HealthMonitor } from "./monitoring/health.js";
import { MetricsCollector } from "./monitoring/metrics.js";
import { initializeDatabase } from "./storage/db.js";
import { OpportunitiesRepository } from "./storage/repositories.js";
import { sleep } from "./utils/sleep.js";
import { Market } from "./config/schema.js";

const logger = pino({ name: "Bot" });

interface MarketInfo {
  market: Market;
  tokenIds: string[];
}

async function main(): Promise<void> {
  // Load configuration
  const env = loadEnv();
  const config = loadConfig();
  const markets = loadMarkets(config.marketsFile);

  logger.info({ mode: env.MODE, markets: markets.length }, "Starting bot");

  // Initialize services
  const client = new ClobClient(env);
  await client.initialize();

  const bookManager = new OrderBookManager(2000);
  const riskManager = new RiskManager({
    maxExposureUsd: config.maxExposureUsd,
    perMarketMaxUsd: config.perMarketMaxUsd,
    dailyStopLossUsd: config.dailyStopLossUsd,
    cooldownMs: config.cooldownMs,
  });

  const executor = new Executor(client, riskManager, {
    orderTimeoutMs: config.orderTimeoutMs,
    priceImprovementTicks: config.priceImprovementTicks,
    enableLiveTrading: config.enableLiveTrading,
    mode: env.MODE,
  });

  const telegram = new TelegramNotifier({
    botToken: env.TELEGRAM_BOT_TOKEN || "",
    chatId: env.TELEGRAM_CHAT_ID || "",
    enabled: config.enableTelegram && !!env.TELEGRAM_BOT_TOKEN && !!env.TELEGRAM_CHAT_ID,
  });

  const healthMonitor = new HealthMonitor();
  const metrics = new MetricsCollector();
  const db = initializeDatabase();
  const oppRepo = new OpportunitiesRepository(db);

  // Parse markets
  const marketInfos: MarketInfo[] = markets.map((market) => {
    let tokenIds: string[] = [];
    if (market.kind === "binary") {
      tokenIds = [market.yesTokenId, market.noTokenId];
    } else {
      tokenIds = market.outcomes.map((o) => o.tokenId);
    }
    return { market, tokenIds };
  });

  // Main loop
  let lastCheckMs = 0;

  while (true) {
    // Check kill switch
    if (riskManager.isKillSwitchActive()) {
      logger.error("Kill switch detected, stopping all trading");
      await telegram.sendKillSwitch();
      break;
    }

    // Health check: reset daily metrics at midnight
    const now = Date.now();
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    if (now > midnight.getTime()) {
      riskManager.resetDaily();
      metrics.reset();
    }

    try {
      // Poll order books
      if (now - lastCheckMs > config.pollingIntervalMs) {
        const allTokenIds = new Set<string>();
        for (const info of marketInfos) {
          for (const tokenId of info.tokenIds) {
            allTokenIds.add(tokenId);
          }
        }

        const books = await client.getMultipleOrderBooks(Array.from(allTokenIds));
        for (const [tokenId, book] of books) {
          bookManager.set(tokenId, book);
        }

        // Detect opportunities
        const opportunities: Opportunity[] = [];

        for (const info of marketInfos) {
          if (info.market.kind === "binary") {
            const yesBook = bookManager.get(info.market.yesTokenId);
            const noBook = bookManager.get(info.market.noTokenId);

            const opp = detectBinaryComplementArb(info.market.name, yesBook, noBook, {
              feeBps: config.feeBps,
              slippageBps: config.slippageBps,
              minProfit: config.minProfit,
              maxExposureUsd: config.maxExposureUsd,
              minTopSizeUsd: config.minTopSizeUsd,
            });

            if (opp) {
              opportunities.push(opp);
              metrics.recordOpportunityDetected(opp.expectedProfitBps);
            }
          } else {
            const outcomeBooks = new Map<string, string>();
            const bookMap = new Map<string, any>();

            for (const outcome of info.market.outcomes) {
              const book = bookManager.get(outcome.tokenId);
              if (book) {
                outcomeBooks.set(outcome.tokenId, outcome.label);
                bookMap.set(outcome.tokenId, book);
              }
            }

            if (bookMap.size === info.market.outcomes.length) {
              const opp = detectMultiOutcomeArb(info.market.name, bookMap, outcomeBooks, {
                feeBps: config.feeBps,
                slippageBps: config.slippageBps,
                minProfit: config.minProfit,
                maxExposureUsd: config.maxExposureUsd,
                minTopSizeUsd: config.minTopSizeUsd,
              });

              if (opp) {
                opportunities.push(opp);
                metrics.recordOpportunityDetected(opp.expectedProfitBps);
              }
            }
          }
        }

        // Execute opportunities (limited to 1-2 concurrent)
        if (opportunities.length > 0) {
          logger.info({ count: opportunities.length }, "Opportunities detected");

          for (const opp of opportunities.slice(0, 2)) {
            const books = bookManager.getAll();
            const result = await executor.executeOpportunity(opp, books);

            if (result.success) {
              metrics.recordOpportunityExecuted();
              if (result.realized) {
                metrics.recordTradeSuccess(opp.expectedProfit);
              }
              await telegram.sendOpportunity(opp.marketName, opp.expectedProfit, opp.expectedProfitBps);
            } else {
              if (result.loss) {
                metrics.recordTradeFailed(result.loss);
              }
            }

            oppRepo.insert(opp);
          }
        }

        healthMonitor.recordSuccess();
        lastCheckMs = now;
      }
    } catch (error) {
      logger.error({ error }, "Error in main loop");
      healthMonitor.recordError();
      await telegram.sendError(error instanceof Error ? error.message : String(error));
    }

    await sleep(100);
  }

  db.close();
}

main().catch((error) => {
  logger.error({ error }, "Fatal error");
  process.exit(1);
});
