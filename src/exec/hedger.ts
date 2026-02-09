import pino from "pino";
import Decimal from "decimal.js";
import { ClobClient } from "../clob/client.js";
import { OrderBook } from "../clob/types.js";

const logger = pino({ name: "Hedger" });

export interface HedgeResult {
  success: boolean;
  price?: number;
  size?: number;
  loss?: number;
  reason?: string;
}

/**
 * Hedger - attempts to close a position at market on failure
 *
 * When a leg B fails to fill, we use the hedger to sell the leg A position
 * at the best available bid, limiting losses.
 */
export class Hedger {
  constructor(private client: ClobClient) {}

  async hedgePosition(
    tokenId: string,
    side: "buy" | "sell",
    size: number,
    entryPrice: number,
    book: OrderBook
  ): Promise<HedgeResult> {
    try {
      // If we bought, sell at best bid
      // If we sold, buy at best ask
      const isClosing = side === "buy"; // If we bought, we close by selling

      if (isClosing) {
        // Sell at best bid
        const hedgePrice = book.bestBidPrice;
        const loss = new Decimal(size)
          .times(new Decimal(entryPrice).minus(new Decimal(hedgePrice)))
          .toNumber();

        logger.warn(
          {
            tokenId,
            size,
            entryPrice,
            hedgePrice,
            loss,
          },
          "Hedging position by selling at market"
        );

        // Place market order (worst case: immediate fill at or worse than bestBid)
        await this.client.placeOrder(tokenId, "sell", hedgePrice, size);

        return {
          success: true,
          price: hedgePrice,
          size,
          loss,
        };
      } else {
        // Buy at best ask
        const hedgePrice = book.bestAskPrice;
        const loss = new Decimal(hedgePrice)
          .minus(new Decimal(entryPrice))
          .times(new Decimal(size))
          .toNumber();

        logger.warn(
          {
            tokenId,
            size,
            entryPrice,
            hedgePrice,
            loss,
          },
          "Hedging position by buying at market"
        );

        await this.client.placeOrder(tokenId, "buy", hedgePrice, size);

        return {
          success: true,
          price: hedgePrice,
          size,
          loss,
        };
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.error(
        {
          tokenId,
          side,
          size,
          error: reason,
        },
        "Hedge failed"
      );

      return {
        success: false,
        reason,
      };
    }
  }

  /**
   * Calculate maximum acceptable loss for a hedge
   */
  calculateMaxAcceptableLoss(
    size: number,
    entryPrice: number,
    bestExitPrice: number,
    maxLossPercentage: number = 0.01
  ): number {
    const idealLoss = new Decimal(size)
      .times(new Decimal(entryPrice).minus(new Decimal(bestExitPrice)))
      .abs()
      .toNumber();

    const maxLoss = new Decimal(size)
      .times(new Decimal(entryPrice))
      .times(new Decimal(maxLossPercentage))
      .toNumber();

    return Math.max(idealLoss, maxLoss);
  }
}
