import pino from "pino";
import { loadConfig, loadMarkets, loadEnv } from "./config/load.js";
import type { Env, Config, Market, MarketBinary, MarketMulti } from "./config/schema.js";
import { ClobClient } from "./clob/client.js";
import { OrderBookManager } from "./clob/books.js";
import { OrderManager } from "./clob/orders.js";
import { PositionManager } from "./clob/positions.js";
import { WsManager } from "./clob/wsManager.js";
import { detectBinaryComplementArb } from "./arb/complement.js";
import { detectMultiOutcomeArb } from "./arb/multiOutcome.js";
import { bestOpportunity, filterByMinProfitBps, OppCooldownTracker, filterSuppressed } from "./arb/filters.js";
import { Opportunity, oppSummary, isComplement } from "./arb/opportunity.js";
import { MarketScanner } from "./arb/marketScanner.js";
import { RiskManager } from "./exec/risk.js";
import { Executor, ExecutionResult } from "./exec/executor.js";
import { PositionMonitor, ExitResult } from "./exec/positionMonitor.js";
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
  let markets: Market[] = loadMarkets();

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
    perMarketCooldownMs: cfg.perMarketCooldownMs,       // #10
    minBalanceUsd: cfg.perMarketMaxUsd * 0.5,           // #12 — floor at 50% of per-market max
  });

  const executor = new Executor(clobClient, riskMgr, {
    orderTimeoutMs: cfg.orderTimeoutMs,
    priceImprovementTicks: cfg.priceImprovementTicks,
    enableLiveTrading: cfg.enableLiveTrading,
    mode,
    concurrentLegs: cfg.concurrentLegs,                 // #6
    adaptiveTimeoutEnabled: cfg.adaptiveTimeoutEnabled,  // #15
    adaptiveTimeoutMinMs: cfg.adaptiveTimeoutMinMs,      // #15
    adaptiveTimeoutMaxMs: cfg.adaptiveTimeoutMaxMs,      // #15
    feeBps: cfg.takerFeeBps,                             // #13
    slippageBps: cfg.slippageBps,                        // for revalidation
    minProfit: cfg.minProfit,                            // for revalidation
  });

  // #11 — Opportunity cooldown tracker
  const oppTracker = new OppCooldownTracker(cfg.oppCooldownMs);

  const paperBroker = mode === "paper" ? new PaperBroker() : null;

  const telegram = new TelegramNotifier({
    botToken: env.TELEGRAM_BOT_TOKEN ?? "",
    chatId: env.TELEGRAM_CHAT_ID ?? "",
    enabled: !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
  });

  const health = new HealthMonitor();
  const metrics = new Metrics();

  // #14 — Position monitor with trailing stop + age exit
  const posMonitor = new PositionMonitor(clobClient, bookMgr, riskMgr, {
    positionMaxAgeMs: cfg.positionMaxAgeMs,
    trailingStopBps: cfg.trailingStopBps,
    checkIntervalMs: Math.min(cfg.pollingIntervalMs, 2000),
  });

  posMonitor.start((exitResult: ExitResult) => {
    logger.info({ ...exitResult }, "Position auto-exited");
    metrics.inc("position_exits");
    telegram.notifyTrade(exitResult.tradeId, "exit", exitResult.pnl, 1).catch(() => {});
  });

  // #7 — WebSocket book feed (optional)
  let wsManager: WsManager | null = null;
  if (cfg.wsEnabled) {
    const allTokenIds = collectAllTokenIds(markets);
    wsManager = new WsManager({
      wsUrl: cfg.wsUrl,
      reconnectIntervalMs: 5000,
      tokenIds: allTokenIds,
    });
    wsManager.on("book", (tokenId: string, book: import("./clob/types.js").OrderBook) => {
      bookMgr.set(tokenId, book);
    });
    wsManager.start();
  }

  // #9 — Market discovery (optional)
  let scanner: MarketScanner | null = null;
  if (cfg.marketDiscoveryEnabled) {
    scanner = new MarketScanner({
      intervalMs: cfg.marketDiscoveryIntervalMs,
      minLiquidityUsd: cfg.marketDiscoveryMinLiquidityUsd,
    });
    scanner.start((newMarkets: Market[]) => {
      markets = [...markets, ...newMarkets];
      logger.info({ count: newMarkets.length, total: markets.length }, "Markets updated via discovery");

      // If WS is active, subscribe to new token IDs
      if (wsManager) {
        const newIds = collectAllTokenIds(newMarkets);
        wsManager.stop();
        const allIds = collectAllTokenIds(markets);
        wsManager = new WsManager({
          wsUrl: cfg.wsUrl,
          reconnectIntervalMs: 5000,
          tokenIds: allIds,
        });
        wsManager.on("book", (tokenId: string, book: import("./clob/types.js").OrderBook) => {
          bookMgr.set(tokenId, book);
        });
        wsManager.start();
        logger.info({ newIds: newIds.length }, "WS resubscribed for new markets");
      }
    });
  }

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

    posMonitor.stop();
    if (wsManager) wsManager.stop();
    if (scanner) scanner.stop();

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
  const METRICS_LOG_INTERVAL = 60;
  const BALANCE_CHECK_INTERVAL = 10;  // #12 — check balance every N loops

  while (running) {
    health.markLoopStart();
    loopCount++;

    try {
      // #12 — Periodic balance refresh
      if (loopCount % BALANCE_CHECK_INTERVAL === 1) {
        try {
          const bal = await clobClient.getBalance();
          riskMgr.updateBalance(bal);
          metrics.gauge("balance_usd", bal);
        } catch (err) {
          logger.debug({ err: String(err) }, "Balance check failed");
        }
      }

      // 1. Refresh order books (skip if WS is feeding them)
      if (!cfg.wsEnabled) {
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
      }

      const freshBooks = bookMgr.getAll();
      metrics.gauge("fresh_books", freshBooks.size);

      // 2. Detect opportunities across all markets
      const opps: Opportunity[] = [];

      // Use effective fee throughout
      const effectiveFee = cfg.takerFeeBps;

      for (const market of markets) {
        if (isBinary(market)) {
          const yesBook = bookMgr.get(market.yesTokenId);
          const noBook = bookMgr.get(market.noTokenId);
          if (yesBook && noBook) {
            const opp = detectBinaryComplementArb(market.name, yesBook, noBook, {
              feeBps: effectiveFee,
              takerFeeBps: cfg.takerFeeBps,
              slippageBps: cfg.slippageBps,
              minProfit: cfg.minProfit,
              maxExposureUsd: cfg.maxExposureUsd,
              perMarketMaxUsd: cfg.perMarketMaxUsd,
              minTopSizeUsd: cfg.minTopSizeUsd,
              stalenessMs: cfg.pollingIntervalMs * 2 + 200,
              currentGlobalExposureUsd: positionMgr.totalExposureUsd(),
              maxSpreadBps: cfg.maxSpreadBps,                      // #8
              useBookDepthForDetection: cfg.useBookDepthForDetection, // #1
              bankrollUsd: cfg.bankrollUsd,                         // #5
              kellyFraction: cfg.kellyFraction,                     // #5
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
              feeBps: effectiveFee,
              takerFeeBps: cfg.takerFeeBps,
              slippageBps: cfg.slippageBps,
              minProfit: cfg.minProfit,
              maxExposureUsd: cfg.maxExposureUsd,
              perMarketMaxUsd: cfg.perMarketMaxUsd,
              minTopSizeUsd: cfg.minTopSizeUsd,
              stalenessMs: cfg.pollingIntervalMs * 2 + 200,
              currentGlobalExposureUsd: positionMgr.totalExposureUsd(),
              maxSpreadBps: cfg.maxSpreadBps,                      // #8
              useBookDepthForDetection: cfg.useBookDepthForDetection, // #1
              bankrollUsd: cfg.bankrollUsd,                         // #5
              kellyFraction: cfg.kellyFraction,                     // #5
            });
            if (opp) opps.push(opp);
          }
        }
      }

      metrics.inc("scan_cycles");

      // 3. Filter: min profit, dedup/cooldown, then pick best
      let qualified = filterByMinProfitBps(opps, cfg.minProfit * 10_000);
      qualified = filterSuppressed(qualified, oppTracker);   // #11
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
            legsPartial: 0,
            hedged: false,
            lossUsd: 0,
            filledSizes: trades.map(() => best.targetSizeShares),
          };

          metrics.inc("paper_trades");
          logger.info({ totalCost, trades: trades.length }, "Paper trade executed");
        } else {
          execResult = await executor.execute(best, freshBooks);
        }

        // #11 — Record this opp in cooldown tracker
        oppTracker.record(best);

        // #10 — Per-market cooldown after execution
        riskMgr.activateMarketCooldown(best.marketName);

        // #14 — Track positions for auto-exit
        if (execResult.success) {
          const tokenIds = isComplement(best)
            ? [best.yesTokenId, best.noTokenId]
            : best.legs.map((l: { tokenId: string }) => l.tokenId);
          const askPrices = isComplement(best)
            ? [best.askYes, best.askNo]
            : best.legs.map((l: { askPrice: number }) => l.askPrice);

          for (let i = 0; i < tokenIds.length; i++) {
            posMonitor.track({
              tradeId: `${best.tradeId}_leg${i}`,
              marketName: best.marketName,
              tokenId: tokenIds[i],
              entryPrice: askPrices[i],
              size: execResult.filledSizes[i] ?? best.targetSizeShares,
              enteredAt: Date.now(),
            });
          }
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

    // #11 — Prune stale cooldown entries periodically
    if (loopCount % METRICS_LOG_INTERVAL === 0) {
      oppTracker.prune();
    }

    // Periodic metrics log
    if (loopCount % METRICS_LOG_INTERVAL === 0) {
      metrics.gauge("memory_mb", Math.round(process.memoryUsage().rss / 1024 / 1024));
      metrics.gauge("open_orders", orderMgr.openCount());
      metrics.gauge("exposure_usd", positionMgr.totalExposureUsd());
      metrics.gauge("tracked_positions", posMonitor.getTracked().length);
      if (paperBroker) {
        metrics.gauge("paper_pnl", paperBroker.realizedPnl);
      }
      metrics.log();
    }

    // Pause between scans
    await sleep(cfg.pollingIntervalMs);
  }
}

/* ---- helpers ---- */

function collectAllTokenIds(mkts: Market[]): string[] {
  const ids: string[] = [];
  for (const m of mkts) {
    if (isBinary(m)) {
      ids.push(m.yesTokenId, m.noTokenId);
    } else {
      for (const o of m.outcomes) ids.push(o.tokenId);
    }
  }
  return ids;
}
