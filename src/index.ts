import pino from "pino";
import { loadConfig, loadMarkets, loadEnv } from "./config/load.js";
import type { Env, Config, Market, MarketBinary, MarketMulti } from "./config/schema.js";
import { ClobClient } from "./clob/client.js";
import { OrderBookManager } from "./clob/books.js";
import { OrderManager } from "./clob/orders.js";
import { PositionManager } from "./clob/positions.js";
import { detectBinaryComplementArb } from "./arb/complement.js";
import { detectMultiOutcomeArb } from "./arb/multiOutcome.js";
import { bestOpportunity, filterByMinProfitBps } from "./arb/filters.js";
import { Opportunity, oppSummary, isComplement } from "./arb/opportunity.js";
import { RiskManager } from "./exec/risk.js";
import { Executor, ExecutionResult } from "./exec/executor.js";
import { PaperBroker } from "./sim/paperBroker.js";
import { TelegramNotifier } from "./monitoring/telegram.js";
import { HealthMonitor } from "./monitoring/health.js";
import { Metrics } from "./monitoring/metrics.js";
import { TradeRepository, ConfigSnapshotRepository } from "./storage/repositories.js";
import { closeDb } from "./storage/db.js";
import { sleep } from "./utils/sleep.js";

const logger = pino({ name: "Main" });

function isBinary(m: Market): m is MarketBinary {
  return m.kind === "binary";
}
function isMulti(m: Market): m is MarketMulti {
  return m.kind === "multi";
}

export async function main(): Promise<void> {
  /* ---- Load env & config ---- */
  const env: Env = loadEnv();
  const cfg: Config = loadConfig();
  const markets: Market[] = loadMarkets();

  const mode = env.MODE; // "dry" | "paper" | "live"

  logger.info({ mode, markets: markets.length }, "Starting PolyArb bot");

  /* ---- Wire up services ---- */
  const clobClient = new ClobClient({
    POLYMARKET_PRIVATE_KEY: env.POLYMARKET_PRIVATE_KEY,
    MODE: env.MODE,
    LOG_LEVEL: env.LOG_LEVEL,
    KILL_SWITCH: env.KILL_SWITCH,
  });

  const bookMgr = new OrderBookManager(cfg.pollingIntervalMs * 2 + 200);
  const orderMgr = new OrderManager();
  const positionMgr = new PositionManager();

  const riskMgr = new RiskManager({
    maxExposureUsd: cfg.maxExposureUsd,
    perMarketMaxUsd: cfg.perMarketMaxUsd,
    dailyStopLossUsd: cfg.dailyStopLossUsd,
    cooldownMs: cfg.cooldownMs,
    maxOpenOrders: cfg.maxOpenOrders,
    safeModeErrorThreshold: cfg.safeModeErrorThreshold,
  });

  const executor = new Executor(clobClient, riskMgr, {
    orderTimeoutMs: cfg.orderTimeoutMs,
    priceImprovementTicks: cfg.priceImprovementTicks,
    enableLiveTrading: cfg.enableLiveTrading,
    mode,
  });

  const paperBroker = mode === "paper" ? new PaperBroker() : null;

  const telegram = new TelegramNotifier({
    botToken: env.TELEGRAM_BOT_TOKEN ?? "",
    chatId: env.TELEGRAM_CHAT_ID ?? "",
    enabled: !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
  });

  const health = new HealthMonitor();
  const metrics = new Metrics();

  // Persistence — only init in non-dry mode
  let tradeRepo: TradeRepository | null = null;
  let configRepo: ConfigSnapshotRepository | null = null;
  if (mode !== "dry") {
    try {
      tradeRepo = new TradeRepository();
      configRepo = new ConfigSnapshotRepository();
      configRepo.save(cfg);
    } catch (err) {
      logger.warn({ err: String(err) }, "DB init failed — running without persistence");
    }
  }

  /* ---- Graceful shutdown ---- */
  let running = true;
  const shutdown = async () => {
    logger.info("Shutting down…");
    running = false;

    // Cancel all open orders locally
    orderMgr.cancelAll();

    metrics.log();
    closeDb();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  /* ---- Main loop ---- */
  let loopCount = 0;
  const METRICS_LOG_INTERVAL = 60; // log metrics every N loops

  while (running) {
    health.markLoopStart();
    loopCount++;

    try {
      // 1. Refresh order books for all token IDs
      for (const market of markets) {
        const tokenIds: string[] = isBinary(market)
          ? [market.yesTokenId, market.noTokenId]
          : market.outcomes.map((o) => o.tokenId);

        for (const tid of tokenIds) {
          try {
            const book = await clobClient.getOrderBook(tid);
            if (book) bookMgr.set(tid, book);
          } catch (err) {
            logger.debug({ tokenId: tid, err: String(err) }, "Book fetch failed");
          }
        }
      }

      const freshBooks = bookMgr.getAll();
      metrics.gauge("fresh_books", freshBooks.size);

      // 2. Detect opportunities across all markets
      const opps: Opportunity[] = [];

      for (const market of markets) {
        if (isBinary(market)) {
          const yesBook = bookMgr.get(market.yesTokenId);
          const noBook = bookMgr.get(market.noTokenId);
          if (yesBook && noBook) {
            const opp = detectBinaryComplementArb(market.name, yesBook, noBook, {
              feeBps: cfg.feeBps,
              slippageBps: cfg.slippageBps,
              minProfit: cfg.minProfit,
              maxExposureUsd: cfg.maxExposureUsd,
              perMarketMaxUsd: cfg.perMarketMaxUsd,
              minTopSizeUsd: cfg.minTopSizeUsd,
              stalenessMs: cfg.pollingIntervalMs * 2 + 200,
              currentGlobalExposureUsd: positionMgr.totalExposureUsd(),
            });
            if (opp) opps.push(opp);
          }
        } else if (isMulti(market)) {
          const booksMap = new Map<string, import("./clob/types.js").OrderBook>();
          const labelsMap = new Map<string, string>();
          for (const o of market.outcomes) {
            const b = bookMgr.get(o.tokenId);
            if (b) {
              booksMap.set(o.tokenId, b);
              labelsMap.set(o.tokenId, o.label);
            }
          }

          if (booksMap.size === market.outcomes.length) {
            const opp = detectMultiOutcomeArb(market.name, booksMap, labelsMap, {
              feeBps: cfg.feeBps,
              slippageBps: cfg.slippageBps,
              minProfit: cfg.minProfit,
              maxExposureUsd: cfg.maxExposureUsd,
              perMarketMaxUsd: cfg.perMarketMaxUsd,
              minTopSizeUsd: cfg.minTopSizeUsd,
              stalenessMs: cfg.pollingIntervalMs * 2 + 200,
              currentGlobalExposureUsd: positionMgr.totalExposureUsd(),
            });
            if (opp) opps.push(opp);
          }
        }
      }

      metrics.inc("scan_cycles");

      // 3. Filter & pick best
      const qualified = filterByMinProfitBps(opps, cfg.minProfit * 10_000);
      const best = bestOpportunity(qualified);

      if (best) {
        metrics.inc("opportunities_found");
        logger.info({ opp: oppSummary(best) }, "Opportunity found");

        // 4. Execute
        let execResult: ExecutionResult;

        if (mode === "paper" && paperBroker) {
          // Paper mode: simulate fill
          const legs = isComplement(best)
              ? [
                  { tokenId: best.yesTokenId, size: best.targetSizeShares },
                  { tokenId: best.noTokenId, size: best.targetSizeShares },
                ]
              : best.legs.map((l: { tokenId: string }) => ({ tokenId: l.tokenId, size: best.targetSizeShares }));

          const { totalCost, trades } = paperBroker.simulateArbBuy(legs, freshBooks);

          execResult = {
            success: trades.length > 0,
            tradeId: best.tradeId,
            legsAttempted: legs.length,
            legsFilled: trades.length,
            hedged: false,
            lossUsd: 0,
          };

          metrics.inc("paper_trades");
          logger.info({ totalCost, trades: trades.length }, "Paper trade executed");
        } else {
          execResult = await executor.execute(best, freshBooks);
        }

        // 5. Record
        if (tradeRepo) {
          try {
            tradeRepo.insert({
              id: best.tradeId,
              marketName: best.marketName,
              type: best.type,
              legs: isComplement(best)
                  ? [
                      { tokenId: best.yesTokenId, side: "buy", price: best.askYes },
                      { tokenId: best.noTokenId, side: "buy", price: best.askNo },
                    ]
                  : best.legs,
              totalCost: best.allInCost,
              expectedProfit: best.expectedProfit,
              expectedProfitBps: best.expectedProfitBps,
            });

            tradeRepo.updateStatus(
              best.tradeId,
              execResult.success ? "filled" : "failed",
              execResult.success ? best.expectedProfit : -execResult.lossUsd,
              execResult.hedged,
              execResult.lossUsd
            );
          } catch (err) {
            logger.warn({ err: String(err) }, "Failed to persist trade");
          }
        }

        // 6. Notify
        if (execResult.success) {
          metrics.inc("successful_trades");
          await telegram.notifyTrade(
            execResult.tradeId,
            best.marketName,
            best.expectedProfit,
            execResult.legsFilled
          );
        } else {
          metrics.inc("failed_trades");
          if (execResult.hedged) {
            metrics.inc("hedged_trades");
            metrics.observe("hedge_loss", execResult.lossUsd);
          }
          if (execResult.error) {
            await telegram.notifyError("Execution", execResult.error);
          }
        }
      }
    } catch (err) {
      metrics.inc("loop_errors");
      logger.error({ err: String(err) }, "Main loop error");
      riskMgr.recordError();
    }

    health.markLoopEnd();

    // Periodic metrics log
    if (loopCount % METRICS_LOG_INTERVAL === 0) {
      metrics.gauge("memory_mb", Math.round(process.memoryUsage().rss / 1024 / 1024));
      metrics.gauge("open_orders", orderMgr.openCount());
      metrics.gauge("exposure_usd", positionMgr.totalExposureUsd());
      if (paperBroker) {
        metrics.gauge("paper_pnl", paperBroker.realizedPnl);
      }
      metrics.log();
    }

    // Pause between scans
    await sleep(cfg.pollingIntervalMs);
  }
}
