import pino from "pino";
import { ClobClient } from "../clob/client.js";
import { OrderBook } from "../clob/types.js";
import { Opportunity, isComplement, oppSummary } from "../arb/opportunity.js";
import { computeCostBreakdown } from "../arb/math.js";
import { roundPriceUp, adjustByTicks } from "./rounding.js";
import { RiskManager } from "./risk.js";
import { Hedger, HedgeResult } from "./hedger.js";
import { sleep } from "../utils/sleep.js";

const logger = pino({ name: "Executor" });

export interface LegSpec {
  tokenId: string;
  askPrice: number;
  bidPrice: number;
}

export interface ExecutionResult {
  success: boolean;
  tradeId: string;
  legsAttempted: number;
  legsFilled: number;
  legsPartial: number;           // #3 partial fill tracking
  hedged: boolean;
  lossUsd: number;
  filledSizes: number[];         // #3 actual filled sizes per leg
  error?: string;
}

export interface ExecutorConfig {
  orderTimeoutMs: number;
  priceImprovementTicks: number;
  enableLiveTrading: boolean;
  mode: "dry" | "paper" | "live";
  concurrentLegs: boolean;          // #6
  adaptiveTimeoutEnabled: boolean;  // #15
  adaptiveTimeoutMinMs: number;     // #15
  adaptiveTimeoutMaxMs: number;     // #15
  feeBps: number;                   // for pre-trade revalidation
  slippageBps: number;              // for pre-trade revalidation
  minProfit: number;                // for pre-trade revalidation
}

/**
 * Adaptive timeout tracker — adjusts timeout based on recent fill latencies.
 * Learns from actual fill times: uses p75 × 2 as timeout, clamped.
 */
class AdaptiveTimeout {
  private latencies: number[] = [];
  private readonly maxSamples = 50;

  constructor(
    private minMs: number,
    private maxMs: number,
    private defaultMs: number
  ) {}

  record(latencyMs: number): void {
    this.latencies.push(latencyMs);
    if (this.latencies.length > this.maxSamples) this.latencies.shift();
  }

  get(): number {
    if (this.latencies.length < 3) return this.defaultMs;
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const p75 = sorted[Math.floor(sorted.length * 0.75)];
    return Math.min(this.maxMs, Math.max(this.minMs, Math.round(p75 * 2)));
  }
}

export class Executor {
  private hedger: Hedger;
  private adaptiveTimeout: AdaptiveTimeout;

  constructor(
    private client: ClobClient,
    private risk: RiskManager,
    private cfg: ExecutorConfig
  ) {
    this.hedger = new Hedger(client);
    this.adaptiveTimeout = new AdaptiveTimeout(
      cfg.adaptiveTimeoutMinMs,
      cfg.adaptiveTimeoutMaxMs,
      cfg.orderTimeoutMs
    );
  }

  /* ---- public entry point ---- */

  async execute(opp: Opportunity, books: Map<string, OrderBook>): Promise<ExecutionResult> {
    const id = opp.tradeId;

    // 1. Risk gate
    const check = this.risk.canTrade(opp.marketName, opp.allInCost * opp.targetSizeShares);
    if (!check.allowed) {
      return result(id, false, 0, 0, 0, false, 0, [], check.reason);
    }

    // 2. LIVE guard
    if (this.cfg.mode === "live" && !this.cfg.enableLiveTrading) {
      return result(id, false, 0, 0, 0, false, 0, [], "enableLiveTrading is false — refusing to trade");
    }

    // 3. DRY_RUN — only log
    if (this.cfg.mode === "dry" || this.risk.isSafeMode()) {
      logger.info({ tradeId: id, opp: oppSummary(opp) }, "DRY_RUN: opportunity detected");
      return result(id, true, 0, 0, 0, false, 0, []);
    }

    // #2 — Pre-trade revalidation: re-fetch books and confirm profitability
    const revalidated = await this.revalidate(opp, books);
    if (!revalidated) {
      logger.info({ tradeId: id }, "Pre-trade revalidation failed — stale opportunity");
      return result(id, false, 0, 0, 0, false, 0, [], "Revalidation failed");
    }

    // 4. Build leg specs
    const legs = this.buildLegs(opp);
    const size = opp.targetSizeShares;

    // 5. Execute — concurrent (#6) or sequential
    if (this.cfg.concurrentLegs && legs.length > 1) {
      return this.executeLegsConcurrent(id, opp.marketName, legs, size, books);
    }
    return this.executeLegSequence(id, opp.marketName, legs, size, books);
  }

  /* ---- pre-trade revalidation (#2) ---- */

  private async revalidate(opp: Opportunity, books: Map<string, OrderBook>): Promise<boolean> {
    try {
      const legs = this.buildLegs(opp);
      const freshPrices: number[] = [];

      for (const leg of legs) {
        const book = await this.client.getOrderBook(leg.tokenId);
        if (!book) return false;
        books.set(leg.tokenId, book); // update cache
        freshPrices.push(book.bestAskPrice);
      }

      // Check profitability with fresh prices
      const bd = computeCostBreakdown(freshPrices, this.cfg.feeBps, this.cfg.slippageBps);
      return bd.expectedProfit >= this.cfg.minProfit;
    } catch (err) {
      logger.warn({ err: String(err) }, "Revalidation error — skipping trade");
      return false;
    }
  }

  /* ---- internals ---- */

  private buildLegs(opp: Opportunity): LegSpec[] {
    if (isComplement(opp)) {
      return [
        { tokenId: opp.yesTokenId, askPrice: opp.askYes, bidPrice: opp.bidYes },
        { tokenId: opp.noTokenId, askPrice: opp.askNo, bidPrice: opp.bidNo },
      ];
    }
    return opp.legs.map((l: { tokenId: string; askPrice: number; bidPrice: number }) => ({
      tokenId: l.tokenId,
      askPrice: l.askPrice,
      bidPrice: l.bidPrice,
    }));
  }

  /**
   * #6 — Concurrent leg execution: fire all legs at once.
   * If any fail, cancel the rest and hedge fills.
   */
  private async executeLegsConcurrent(
    tradeId: string,
    marketName: string,
    legs: LegSpec[],
    size: number,
    books: Map<string, OrderBook>
  ): Promise<ExecutionResult> {
    const timeout = this.getTimeout();

    // Fire all legs simultaneously
    const orderPromises = legs.map(async (leg) => {
      const orderPrice = this.computeOrderPrice(leg.askPrice);
      this.risk.recordOrderPlaced();
      logger.info({ tradeId, tokenId: leg.tokenId, orderPrice, size }, "Placing leg (concurrent)");
      const order = await this.client.placeOrder(leg.tokenId, "buy", orderPrice, size);
      return { order, leg, orderPrice };
    });

    let orders: { order: import("../clob/types.js").Order; leg: LegSpec; orderPrice: number }[];
    try {
      orders = await Promise.all(orderPromises);
    } catch (err) {
      // Some placements failed
      logger.error({ tradeId, err: String(err) }, "Concurrent leg placement error");
      this.risk.recordError();
      return result(tradeId, false, legs.length, 0, 0, false, 0, [], String(err));
    }

    // Poll all for fills concurrently
    const fillResults = await Promise.all(
      orders.map(async ({ order, leg, orderPrice }) => {
        const startMs = Date.now();
        const fillResult = await this.pollForFillDetailed(order.id, timeout);
        const elapsed = Date.now() - startMs;
        if (fillResult.filled) this.adaptiveTimeout.record(elapsed);
        return { order, leg, orderPrice, ...fillResult };
      })
    );

    const filled: { tokenId: string; price: number; size: number; filledSize: number }[] = [];
    const unfilled: { orderId: string }[] = [];
    let partialCount = 0;
    const filledSizes: number[] = [];

    for (const fr of fillResults) {
      this.risk.recordOrderClosed();
      if (fr.filled) {
        const actualSize = fr.filledSize > 0 ? fr.filledSize : size;
        filled.push({ tokenId: fr.leg.tokenId, price: fr.orderPrice, size, filledSize: actualSize });
        filledSizes.push(actualSize);
        if (fr.partial) partialCount++;
        this.risk.recordSuccess();
      } else {
        unfilled.push({ orderId: fr.order.id });
        filledSizes.push(0);
      }
    }

    // Cancel unfilled
    for (const uf of unfilled) {
      try { await this.client.cancelOrder(uf.orderId); } catch {}
    }

    // If not all filled, hedge the filled ones
    if (unfilled.length > 0) {
      const hedgeLoss = await this.hedgeAll(
        filled.map(f => ({ tokenId: f.tokenId, price: f.price, size: f.filledSize })),
        books
      );
      this.risk.recordLoss(hedgeLoss);
      this.risk.activateCooldown();
      return result(tradeId, false, legs.length, filled.length, partialCount, hedgeLoss > 0, hedgeLoss, filledSizes, "Some legs unfilled");
    }

    // All filled — update exposure
    const totalExposure = filled.reduce((s, l) => s + l.price * l.filledSize, 0);
    this.risk.updateExposure(marketName, totalExposure, totalExposure);

    logger.info({ tradeId, legs: filled.length, partialCount }, "All legs filled (concurrent)");
    return result(tradeId, true, legs.length, legs.length, partialCount, false, 0, filledSizes);
  }

  /**
   * Place legs one-by-one. If leg N fails, hedge legs 0..(N-1).
   */
  private async executeLegSequence(
    tradeId: string,
    marketName: string,
    legs: LegSpec[],
    size: number,
    books: Map<string, OrderBook>
  ): Promise<ExecutionResult> {
    const filledLegs: { tokenId: string; price: number; size: number; filledSize: number }[] = [];
    const filledSizes: number[] = [];
    let partialCount = 0;

    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      const orderPrice = this.computeOrderPrice(leg.askPrice);
      const timeout = this.getTimeout();

      this.risk.recordOrderPlaced();
      logger.info({ tradeId, leg: i, tokenId: leg.tokenId, orderPrice, size }, "Placing leg");

      try {
        const order = await this.client.placeOrder(leg.tokenId, "buy", orderPrice, size);

        // Wait for fill (#3 — partial fill aware)
        const startMs = Date.now();
        const fillResult = await this.pollForFillDetailed(order.id, timeout);
        const elapsed = Date.now() - startMs;

        if (!fillResult.filled) {
          // Timeout — cancel
          await this.client.cancelOrder(order.id);
          this.risk.recordOrderClosed();
          filledSizes.push(0);

          logger.warn({ tradeId, leg: i }, "Leg timed out — cancelled");

          const hedgeLoss = await this.hedgeAll(
            filledLegs.map(f => ({ tokenId: f.tokenId, price: f.price, size: f.filledSize })),
            books
          );
          this.risk.recordLoss(hedgeLoss);
          this.risk.activateCooldown();

          return result(tradeId, false, i + 1, filledLegs.length, partialCount, hedgeLoss > 0, hedgeLoss, filledSizes, "Leg timeout");
        }

        // #3 — Track actual filled size (may be partial)
        const actualSize = fillResult.filledSize > 0 ? fillResult.filledSize : size;
        if (fillResult.partial) partialCount++;

        this.adaptiveTimeout.record(elapsed);
        filledLegs.push({ tokenId: leg.tokenId, price: orderPrice, size, filledSize: actualSize });
        filledSizes.push(actualSize);
        this.risk.recordOrderClosed();
        this.risk.recordSuccess();

      } catch (err) {
        this.risk.recordOrderClosed();
        this.risk.recordError();
        filledSizes.push(0);

        logger.error({ tradeId, leg: i, err: String(err) }, "Leg placement failed");

        const hedgeLoss = await this.hedgeAll(
          filledLegs.map(f => ({ tokenId: f.tokenId, price: f.price, size: f.filledSize })),
          books
        );
        this.risk.recordLoss(hedgeLoss);
        this.risk.activateCooldown();

        return result(tradeId, false, i + 1, filledLegs.length, partialCount, hedgeLoss > 0, hedgeLoss, filledSizes, String(err));
      }
    }

    // All legs filled — update exposure using actual filled sizes
    const totalExposure = filledLegs.reduce((s, l) => s + l.price * l.filledSize, 0);
    this.risk.updateExposure(marketName, totalExposure, totalExposure);

    logger.info({ tradeId, legs: filledLegs.length, partialCount }, "All legs filled — arb locked in");
    return result(tradeId, true, legs.length, legs.length, partialCount, false, 0, filledSizes);
  }

  private computeOrderPrice(askPrice: number): number {
    const improved = adjustByTicks(askPrice, this.cfg.priceImprovementTicks);
    return roundPriceUp(improved);
  }

  /** #15 — Get current timeout: adaptive if enabled, else static config. */
  private getTimeout(): number {
    return this.cfg.adaptiveTimeoutEnabled ? this.adaptiveTimeout.get() : this.cfg.orderTimeoutMs;
  }

  /**
   * #3 — Enhanced poll that distinguishes full, partial, and unfilled.
   */
  private async pollForFillDetailed(
    orderId: string,
    timeoutMs: number
  ): Promise<{ filled: boolean; partial: boolean; filledSize: number }> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const order = await this.client.getOrderStatus(orderId);
      if (order) {
        if (order.status === "filled") {
          return { filled: true, partial: false, filledSize: order.filledSize ?? order.size };
        }
        if (order.status === "partial" && (order.filledSize ?? 0) > 0) {
          // Accept partial if >50% filled to avoid leaving money on table
          const pctFilled = (order.filledSize ?? 0) / order.size;
          if (pctFilled >= 0.5) {
            return { filled: true, partial: true, filledSize: order.filledSize ?? 0 };
          }
        }
      }
      await sleep(Math.min(150, timeoutMs / 10));
    }
    return { filled: false, partial: false, filledSize: 0 };
  }

  /** Sell all filled legs at best bid to limit loss. */
  private async hedgeAll(
    filledLegs: { tokenId: string; price: number; size: number }[],
    books: Map<string, OrderBook>
  ): Promise<number> {
    if (filledLegs.length === 0) return 0;

    let totalLoss = 0;
    for (const leg of filledLegs) {
      const book = books.get(leg.tokenId) ?? null;
      const hr: HedgeResult = await this.hedger.hedge(leg.tokenId, leg.size, leg.price, book);
      totalLoss += hr.lossUsd ?? 0;
    }

    logger.warn({ totalLoss, legs: filledLegs.length }, "Hedged open legs");
    return totalLoss;
  }
}

function result(
  tradeId: string,
  success: boolean,
  legsAttempted: number,
  legsFilled: number,
  legsPartial: number,
  hedged: boolean,
  lossUsd: number,
  filledSizes: number[],
  error?: string
): ExecutionResult {
  return { success, tradeId, legsAttempted, legsFilled, legsPartial, hedged, lossUsd, filledSizes, error };
}
