import pino from "pino";
import { ClobClient } from "../clob/client.js";
import { OrderBook } from "../clob/types.js";
import { Opportunity, isComplement, oppSummary } from "../arb/opportunity.js";
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
  hedged: boolean;
  lossUsd: number;
  error?: string;
}

export class Executor {
  private hedger: Hedger;

  constructor(
    private client: ClobClient,
    private risk: RiskManager,
    private cfg: {
      orderTimeoutMs: number;
      priceImprovementTicks: number;
      enableLiveTrading: boolean;
      mode: "dry" | "paper" | "live";
    }
  ) {
    this.hedger = new Hedger(client);
  }

  /* ---- public entry point ---- */

  async execute(opp: Opportunity, books: Map<string, OrderBook>): Promise<ExecutionResult> {
    const id = isComplement(opp) ? opp.tradeId : opp.tradeId;

    // 1. Risk gate
    const check = this.risk.canTrade(opp.marketName, opp.allInCost * opp.targetSizeShares);
    if (!check.allowed) {
      return result(id, false, 0, 0, false, 0, check.reason);
    }

    // 2. LIVE guard
    if (this.cfg.mode === "live" && !this.cfg.enableLiveTrading) {
      return result(id, false, 0, 0, false, 0, "enableLiveTrading is false — refusing to trade");
    }

    // 3. DRY_RUN — only log
    if (this.cfg.mode === "dry" || this.risk.isSafeMode()) {
      logger.info({ tradeId: id, opp: oppSummary(opp) }, "DRY_RUN: opportunity detected");
      return result(id, true, 0, 0, false, 0);
    }

    // 4. Build leg specs
    const legs = this.buildLegs(opp);
    const size = opp.targetSizeShares;

    // 5. Execute legs sequentially with hedging
    return this.executeLegSequence(id, opp.marketName, legs, size, books);
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
   * Place legs one-by-one.  If leg N fails, hedge legs 0..(N-1).
   */
  private async executeLegSequence(
    tradeId: string,
    marketName: string,
    legs: LegSpec[],
    size: number,
    books: Map<string, OrderBook>
  ): Promise<ExecutionResult> {
    const filledLegs: { tokenId: string; price: number; size: number }[] = [];

    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      const orderPrice = this.computeOrderPrice(leg.askPrice);

      this.risk.recordOrderPlaced();
      logger.info({ tradeId, leg: i, tokenId: leg.tokenId, orderPrice, size }, "Placing leg");

      try {
        const order = await this.client.placeOrder(leg.tokenId, "buy", orderPrice, size);

        // Wait for fill
        const filled = await this.pollForFill(order.id, this.cfg.orderTimeoutMs);

        if (!filled) {
          // Timeout — cancel and try once more if still profitable
          await this.client.cancelOrder(order.id);
          this.risk.recordOrderClosed();

          logger.warn({ tradeId, leg: i }, "Leg timed out — cancelled");

          // Hedge all previously-filled legs
          const hedgeLoss = await this.hedgeAll(filledLegs, books);
          this.risk.recordLoss(hedgeLoss);
          this.risk.activateCooldown();

          return result(tradeId, false, i + 1, filledLegs.length, hedgeLoss > 0, hedgeLoss, "Leg timeout");
        }

        // Filled
        filledLegs.push({ tokenId: leg.tokenId, price: orderPrice, size });
        this.risk.recordOrderClosed();
        this.risk.recordSuccess();

      } catch (err) {
        this.risk.recordOrderClosed();
        this.risk.recordError();

        logger.error({ tradeId, leg: i, err: String(err) }, "Leg placement failed");

        const hedgeLoss = await this.hedgeAll(filledLegs, books);
        this.risk.recordLoss(hedgeLoss);
        this.risk.activateCooldown();

        return result(tradeId, false, i + 1, filledLegs.length, hedgeLoss > 0, hedgeLoss, String(err));
      }
    }

    // All legs filled — update exposure
    const totalExposure = filledLegs.reduce((s, l) => s + l.price * l.size, 0);
    this.risk.updateExposure(marketName, totalExposure, totalExposure);

    logger.info({ tradeId, legs: filledLegs.length }, "All legs filled — arb locked in");
    return result(tradeId, true, legs.length, legs.length, false, 0);
  }

  private computeOrderPrice(askPrice: number): number {
    const improved = adjustByTicks(askPrice, this.cfg.priceImprovementTicks);
    return roundPriceUp(improved);
  }

  private async pollForFill(orderId: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const order = await this.client.getOrderStatus(orderId);
      if (order && (order.status === "filled" || order.status === "partial")) {
        return true;
      }
      await sleep(Math.min(150, timeoutMs / 10));
    }
    return false;
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
  hedged: boolean,
  lossUsd: number,
  error?: string
): ExecutionResult {
  return { success, tradeId, legsAttempted, legsFilled, hedged, lossUsd, error };
}
