import pino from "pino";
import { ClobClient } from "../clob/client.js";
import { OrderBook } from "../clob/types.js";
import { Opportunity } from "../arb/opportunity.js";
import { calculateMaxLoss } from "../arb/math.js";
import { roundPrice, roundPriceUp } from "./rounding.js";
import { RiskManager } from "./risk.js";
import { sleep } from "../utils/sleep.js";

const logger = pino({ name: "Executor" });

export interface ExecutionResult {
  success: boolean;
  opportunityId: string;
  ordersPlaced: string[];
  realized: boolean;
  loss?: number;
  error?: string;
}

export class Executor {
  constructor(
    private client: ClobClient,
    private riskManager: RiskManager,
    private config: {
      orderTimeoutMs: number;
      priceImprovementTicks: number;
      enableLiveTrading: boolean;
      mode: "dry" | "paper" | "live";
    }
  ) {}

  async executeOpportunity(opp: Opportunity, books: Map<string, OrderBook>): Promise<ExecutionResult> {
    const oppId = `${opp.type}_${opp.detectedAt}`;

    // Check if we can trade
    const canTradeCheck = this.riskManager.canTrade(opp.marketName, opp.targetSize * 0.5);
    if (!canTradeCheck.allowed) {
      return {
        success: false,
        opportunityId: oppId,
        ordersPlaced: [],
        realized: false,
        error: canTradeCheck.reason,
      };
    }

    // Verify live trading is enabled
    if (this.config.mode === "live" && !this.config.enableLiveTrading) {
      return {
        success: false,
        opportunityId: oppId,
        ordersPlaced: [],
        realized: false,
        error: "Live trading is disabled",
      };
    }

    // In DRY_RUN, just log
    if (this.config.mode === "dry") {
      logger.info({ opportunity: opp }, "DRY_RUN: Would execute opportunity");
      return {
        success: true,
        opportunityId: oppId,
        ordersPlaced: [],
        realized: false,
      };
    }

    // Place orders (leg A, then leg B)
    const legA = await this.placeLegA(opp);
    if (!legA.success) {
      return {
        success: false,
        opportunityId: oppId,
        ordersPlaced: legA.orderId ? [legA.orderId] : [],
        realized: false,
        error: legA.error,
      };
    }

    // Wait for leg A to fill
    const legAFilled = await this.waitForFill(legA.orderId, this.config.orderTimeoutMs);
    if (!legAFilled) {
      // Timeout: cancel leg A
      await this.client.cancelOrder(legA.orderId);
      this.riskManager.activateCooldown();
      return {
        success: false,
        opportunityId: oppId,
        ordersPlaced: [legA.orderId],
        realized: false,
        error: "Leg A timeout",
      };
    }

    // Place leg B
    const legB = await this.placeLegB(opp);
    if (!legB.success) {
      // Leg B failed: hedge leg A
      const maxLoss = await this.hedgeLegA(legA.tokenId, legA.size, books);
      this.riskManager.recordLoss(maxLoss);
      this.riskManager.activateCooldown();

      return {
        success: false,
        opportunityId: oppId,
        ordersPlaced: [legA.orderId],
        realized: true,
        loss: maxLoss,
        error: "Leg B failed, hedged leg A",
      };
    }

    // Wait for leg B to fill
    const legBFilled = await this.waitForFill(legB.orderId, this.config.orderTimeoutMs);
    if (!legBFilled) {
      // Timeout on leg B: hedge both
      await this.client.cancelOrder(legB.orderId);
      const loss = await this.hedgeBothLegs(legA, legB, books);
      this.riskManager.recordLoss(loss);
      this.riskManager.activateCooldown();

      return {
        success: false,
        opportunityId: oppId,
        ordersPlaced: [legA.orderId, legB.orderId],
        realized: true,
        loss,
        error: "Leg B timeout, hedged both",
      };
    }

    // Success
    this.riskManager.recordFill(2);
    return {
      success: true,
      opportunityId: oppId,
      ordersPlaced: [legA.orderId, legB.orderId],
      realized: true,
    };
  }

  private async placeLegA(opp: Opportunity): Promise<{ success: boolean; orderId: string; tokenId: string; size: number; error?: string }> {
    // Determine which leg is A and its details
    let tokenId: string;
    let askPrice: number;

    if (opp.type === "binary_complement") {
      tokenId = opp.yesTokenId;
      askPrice = opp.askYes;
    } else {
      tokenId = opp.outcomes[0].tokenId;
      askPrice = opp.outcomes[0].ask;
    }

    const orderPrice = roundPriceUp(askPrice, 0.0001);

    try {
      const order = await this.client.placeOrder(tokenId, "buy", orderPrice, opp.targetSize);
      return { success: true, orderId: order.id, tokenId, size: opp.targetSize };
    } catch (error) {
      return {
        success: false,
        orderId: "",
        tokenId,
        size: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async placeLegB(opp: Opportunity): Promise<{ success: boolean; orderId: string; tokenId: string; size: number; error?: string }> {
    // Determine which leg is B
    let tokenId: string;
    let askPrice: number;

    if (opp.type === "binary_complement") {
      tokenId = opp.noTokenId;
      askPrice = opp.askNo;
    } else {
      tokenId = opp.outcomes[1].tokenId;
      askPrice = opp.outcomes[1].ask;
    }

    const orderPrice = roundPriceUp(askPrice, 0.0001);

    try {
      const order = await this.client.placeOrder(tokenId, "buy", orderPrice, opp.targetSize);
      return { success: true, orderId: order.id, tokenId, size: opp.targetSize };
    } catch (error) {
      return {
        success: false,
        orderId: "",
        tokenId,
        size: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async waitForFill(orderId: string, timeoutMs: number): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const order = await this.client.getOrderStatus(orderId);
      if (order && order.status === "filled") {
        return true;
      }
      await sleep(100);
    }

    return false;
  }

  private async hedgeLegA(
    tokenId: string,
    size: number,
    books: Map<string, OrderBook>
  ): Promise<number> {
    const book = books.get(tokenId);
    if (!book) {
      logger.error({ tokenId }, "No book available for hedging");
      return size * 0.01; // Assume 1% loss
    }

    const hedgePrice = roundPrice(book.bestBidPrice, 0.0001);
    try {
      await this.client.placeOrder(tokenId, "sell", hedgePrice, size);
      const loss = calculateMaxLoss(size, 0.5, hedgePrice); // Conservative estimate
      return Math.abs(loss);
    } catch (error) {
      logger.error({ tokenId, error }, "Failed to hedge leg A");
      return size * 0.01; // Estimate loss
    }
  }

  private async hedgeBothLegs(
    legA: { tokenId: string; size: number },
    legB: { tokenId: string; size: number },
    books: Map<string, OrderBook>
  ): Promise<number> {
    let totalLoss = 0;

    const loss1 = await this.hedgeLegA(legA.tokenId, legA.size, books);
    const loss2 = await this.hedgeLegA(legB.tokenId, legB.size, books);

    totalLoss = loss1 + loss2;
    logger.warn({ totalLoss }, "Both legs hedged due to timeout");
    return totalLoss;
  }
}
