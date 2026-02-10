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
import { startDashboard, type ScanSnapshot } from "./monitoring/dashboard.js";
import {
  IncidentTracker,
  FunnelTracker,
  TradeTimeline,
  MarketPerfTracker,
  CircuitBreakerTracker,
  PnlTracker,
  ExecQualityTracker,
  DataQualityTracker,
} from "./monitoring/collectors.js";
import type { BotStatus, BotState } from "./monitoring/types.js";

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
  const clobClient = new ClobClient(env);
  await clobClient.initialize();

  // Count total token IDs to scale staleness window
  const totalTokenIds = markets.reduce((n, m) => {
    if (isBinary(m)) return n + 2;
    return n + m.outcomes.length;
  }, 0);
  // Allow ~120ms per API call (rate limit) + generous buffer
  const bookMaxAgeMs = Math.max(
    cfg.pollingIntervalMs * 2 + 200,
    totalTokenIds * 150 + 2000,
  );
  logger.info({ totalTokenIds, bookMaxAgeMs }, "Book staleness window");
  const bookMgr = new OrderBookManager(bookMaxAgeMs);
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
      maxLiquidityUsd: cfg.marketDiscoveryMaxLiquidityUsd,
      includeNegRisk: cfg.marketDiscoveryIncludeNegRisk,
      includeBinary: cfg.marketDiscoveryIncludeBinary,
      minScore: cfg.marketDiscoveryMinScore,
      maxOutcomes: cfg.marketDiscoveryMaxOutcomes,
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

  /* ---- Dashboard ---- */
  const scanState: ScanSnapshot = {
    cycle: 0,
    freshBooks: 0,
    totalTokenIds,
    opps: 0,
    qualified: 0,
    lastOpp: null,
    marketGaps: [],
  };

  // Collectors
  const incidents = new IncidentTracker();
  const funnel = new FunnelTracker();
  const timeline = new TradeTimeline();
  const marketPerf = new MarketPerfTracker();
  const cbTracker = new CircuitBreakerTracker();
  const pnlTracker = new PnlTracker();
  const execQuality = new ExecQualityTracker();
  const dataQuality = new DataQualityTracker();

  // Track WS connection state
  if (wsManager) {
    dataQuality.setWsConnected(true);
  }

  // Bot status
  const botStartedAt = Date.now();
  let botState: BotState = "RUNNING";
  let lastError: string | null = null;
  let lastErrorAt: number | null = null;
  let lastRecoveryAction: string | null = null;

  const botStatus = (): BotStatus => ({
    state: botState,
    mode: mode as "dry" | "paper" | "live",
    liveArmed: cfg.enableLiveTrading,
    lastError,
    lastErrorAt,
    lastRecoveryAction,
    startedAt: botStartedAt,
  });

  const DASHBOARD_PORT = parseInt(env.DASHBOARD_PORT ?? "3456", 10);
  const dashboardServer = startDashboard(DASHBOARD_PORT, {
    metrics,
    health,
    bookMgr,
    riskMgr,
    positionMgr,
    orderMgr,
    posMonitor,
    markets: () => markets,
    mode,
    enableLiveTrading: cfg.enableLiveTrading,
    scanState: () => scanState,
    botStatus,
    incidents,
    funnel,
    timeline,
    marketPerf,
    cbTracker,
    pnlTracker,
    execQuality,
    dataQuality,
  });

  /* ---- Graceful shutdown ---- */
  let running = true;
  const shutdown = async () => {
    logger.info("Shutting down…");
    running = false;

    posMonitor.stop();
    if (wsManager) wsManager.stop();
    if (scanner) scanner.stop();
    dashboardServer.close();

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
  const METRICS_LOG_INTERVAL = 10;
  const BALANCE_CHECK_INTERVAL = 10;  // #12 — check balance every N loops

  while (running) {
    health.markLoopStart();
    loopCount++;

    try {
      // #12 — Periodic balance refresh (skip in dry mode — no auth needed)
      if (mode !== "dry" && loopCount % BALANCE_CHECK_INTERVAL === 1) {
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
        const t0 = Date.now();
        let fetched = 0;
        let failed = 0;
        for (const market of markets) {
          const tokenIds: string[] = isBinary(market)
            ? [market.yesTokenId, market.noTokenId]
            : market.outcomes.map((o) => o.tokenId);

          for (const tid of tokenIds) {
            try {
              const t1 = Date.now();
              const book = await clobClient.getOrderBook(tid);
              dataQuality.recordLatency(Date.now() - t1);
              if (book) { bookMgr.set(tid, book); fetched++; }
            } catch (err) {
              failed++;
              dataQuality.recordRetry();
              logger.debug({ tokenId: tid, err: String(err) }, "Book fetch failed");
            }
          }
        }
        const elapsed = Date.now() - t0;
        if (loopCount <= 3 || loopCount % 10 === 0) {
          logger.info({ cycle: loopCount, fetched, failed, elapsedMs: elapsed }, "Book fetch pass");
        }
      }

      const freshBooks = bookMgr.getAll();
      metrics.gauge("fresh_books", freshBooks.size);

      // 2. Detect opportunities across all markets
      const opps: Opportunity[] = [];

      // Use effective fee throughout
      const effectiveFee = cfg.takerFeeBps;

      // Track closest-to-arb binary market for diagnostics
      let bestRawGap = Infinity;
      let bestGapMarket = "";
      let bestGapAskYes = 0;
      let bestGapAskNo = 0;

      for (const market of markets) {
        if (isBinary(market)) {
          const yesBook = bookMgr.get(market.yesTokenId);
          const noBook = bookMgr.get(market.noTokenId);
          if (yesBook && noBook) {
            // Raw gap: how far from arb (askYes + askNo - 1)
            const rawGap = yesBook.bestAskPrice + noBook.bestAskPrice - 1;
            if (rawGap < bestRawGap) {
              bestRawGap = rawGap;
              bestGapMarket = market.name;
              bestGapAskYes = yesBook.bestAskPrice;
              bestGapAskNo = noBook.bestAskPrice;
            }
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

      // Feed funnel: record all detected opps
      for (let _i = 0; _i < opps.length; _i++) funnel.record("detected");

      // 3. Filter: min profit, dedup/cooldown, then pick best
      let qualified = filterByMinProfitBps(opps, cfg.minProfit * 10_000);
      qualified = filterSuppressed(qualified, oppTracker);   // #11

      // Feed funnel: record passed filters
      for (let _i = 0; _i < qualified.length; _i++) funnel.record("passed_filters");

      // Log every cycle for visibility
      if (loopCount <= 3 || loopCount % 10 === 0) {
        logger.info(
          {
            cycle: loopCount,
            fresh_books: freshBooks.size,
            opps: opps.length,
            qualified: qualified.length,
            closest_arb: bestGapMarket
              ? { market: bestGapMarket, gap: +(bestRawGap * 100).toFixed(2), askYes: bestGapAskYes, askNo: bestGapAskNo }
              : undefined,
          },
          "Scan cycle complete",
        );
      }

      // Update dashboard scan state
      const marketGaps: ScanSnapshot["marketGaps"] = [];
      for (const market of markets) {
        if (isBinary(market)) {
          const yb = bookMgr.get(market.yesTokenId);
          const nb = bookMgr.get(market.noTokenId);
          if (yb && nb) {
            marketGaps.push({
              market: market.name,
              kind: "binary",
              askYes: yb.bestAskPrice,
              askNo: nb.bestAskPrice,
              gap: +((yb.bestAskPrice + nb.bestAskPrice - 1) * 100).toFixed(3),
              bidYes: yb.bestBidPrice,
              bidNo: nb.bestBidPrice,
              spreadYes: +((yb.bestAskPrice - yb.bestBidPrice) * 100).toFixed(2),
              spreadNo: +((nb.bestAskPrice - nb.bestBidPrice) * 100).toFixed(2),
              yesAge: Date.now() - yb.lastUpdatedMs,
              noAge: Date.now() - nb.lastUpdatedMs,
            });
          }
        }
      }
      scanState.cycle = loopCount;
      scanState.freshBooks = freshBooks.size;
      scanState.opps = opps.length;
      scanState.qualified = qualified.length;
      scanState.marketGaps = marketGaps;

      const best = bestOpportunity(qualified);

      if (best) {
        metrics.inc("opportunities_found");
        funnel.record("passed_risk");  // if we got here, risk check passed

        // Start trade timeline
        timeline.start(
          best.tradeId,
          best.marketName,
          best.type === "binary_complement" ? "binary_complement" : "multi_outcome",
          best.expectedProfitBps,
        );
        timeline.addEvent(best.tradeId, "validated");
        timeline.addEvent(best.tradeId, "risk_checked");

        scanState.lastOpp = {
          marketName: best.marketName,
          expectedProfit: best.expectedProfit,
          expectedProfitBps: best.expectedProfitBps,
          totalCost: best.totalCost,
          detectedAt: best.detectedAt,
          type: best.type,
          summary: oppSummary(best),
        };
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
          funnel.record("orders_placed");
          funnel.record("fully_filled");
          timeline.addEvent(best.tradeId, "leg_a_filled");
          timeline.addEvent(best.tradeId, "leg_b_filled");
          timeline.finalize(best.tradeId, true, best.expectedProfitBps);

          // Track per-market performance
          marketPerf.recordTrade(best.marketName, best.expectedProfit, true, false, 0, best.expectedProfitBps);

          // PnL attribution (approximate)
          pnlTracker.record(best.expectedProfit, best.totalCost * (cfg.takerFeeBps / 10_000), 0, 0);

          funnel.record("net_profitable");

          await telegram.notifyTrade(
            execResult.tradeId,
            best.marketName,
            best.expectedProfit,
            execResult.legsFilled
          );
        } else {
          metrics.inc("failed_trades");
          funnel.record("orders_placed");
          timeline.addEvent(best.tradeId, "leg_a_placed");
          if (execResult.hedged) {
            metrics.inc("hedged_trades");
            metrics.observe("hedge_loss", execResult.lossUsd);
            funnel.record("hedged");
            timeline.addEvent(best.tradeId, "hedge_triggered", `loss: $${execResult.lossUsd.toFixed(2)}`);
            marketPerf.recordTrade(best.marketName, -execResult.lossUsd, false, true, 0, best.expectedProfitBps);
            pnlTracker.record(0, 0, 0, execResult.lossUsd);
          } else {
            marketPerf.recordTrade(best.marketName, 0, false, false, 0, best.expectedProfitBps);
          }
          timeline.finalize(best.tradeId, false);
          if (execResult.error) {
            await telegram.notifyError("Execution", execResult.error);
          }
        }
      }
    } catch (err) {
      metrics.inc("loop_errors");
      logger.error({ err: String(err) }, "Main loop error");
      riskMgr.recordError();
      cbTracker.recordError();
      lastError = String(err);
      lastErrorAt = Date.now();
      incidents.add("MED", "loop_error", String(err));

      // Update bot state if safe mode triggered
      const rs = riskMgr.getState();
      if (rs.safeModeActive) {
        botState = "SAFE_MODE";
        lastRecoveryAction = "safe mode activated";
      }
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
