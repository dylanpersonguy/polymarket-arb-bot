import pino from "pino";
import { ClobClient } from "../clob/client.js";
import { OrderBook } from "../clob/types.js";
import { roundPriceDown } from "./rounding.js";
import { calculateMaxLoss } from "../arb/math.js";

const logger = pino({ name: "Hedger" });

export interface HedgeResult {
  success: boolean;
  price?: number;
  size?: number;
  lossUsd?: number;
  reason?: string;
}

/**
 * Hedger — when a later leg fails, immediately sell the earlier leg(s)
 * at best available bid to bound loss.
 */
export class Hedger {
  constructor(private client: ClobClient) {}

  /**
   * Sell `size` shares of `tokenId` at the current best bid.
   */
  async hedge(
    tokenId: string,
    size: number,
    entryPrice: number,
    book: OrderBook | null
  ): Promise<HedgeResult> {
    if (!book || book.bestBidSize <= 0) {
      return { success: false, reason: "No bid available to hedge" };
    }

    const hedgePrice = roundPriceDown(book.bestBidPrice);
    const lossUsd = calculateMaxLoss(size, entryPrice, hedgePrice);

    try {
      logger.warn({ tokenId, size, entryPrice, hedgePrice, lossUsd }, "Hedging — selling at market bid");
      await this.client.placeOrder(tokenId, "sell", hedgePrice, size);
      return { success: true, price: hedgePrice, size, lossUsd };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.error({ tokenId, err: reason }, "Hedge order failed");
      return { success: false, reason, lossUsd };
    }
  }
}
