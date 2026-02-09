import pino from "pino";
import { OrderBook, Position } from "../clob/types.js";
import { estimateBuySlippage, estimateSellSlippage } from "./slippage.js";
import { tradeId as genTradeId } from "../utils/time.js";
import Decimal from "decimal.js";

const logger = pino({ name: "PaperBroker" });

export interface PaperTrade {
  id: string;
  tokenId: string;
  side: "buy" | "sell";
  price: number;
  size: number;
  filledAt: number;
}

/**
 * Paper-trading broker that simulates fills using order-book slippage.
 * Maintains virtual positions and P&L.
 */
export class PaperBroker {
  private trades: PaperTrade[] = [];
  private positions = new Map<string, { size: Decimal; avgCost: Decimal }>();
  private _realizedPnl = new Decimal(0);

  get realizedPnl(): number {
    return this._realizedPnl.toNumber();
  }

  get tradeCount(): number {
    return this.trades.length;
  }

  getPosition(tokenId: string): { size: number; avgCost: number } {
    const pos = this.positions.get(tokenId);
    if (!pos) return { size: 0, avgCost: 0 };
    return { size: pos.size.toNumber(), avgCost: pos.avgCost.toNumber() };
  }

  getAllPositions(): Position[] {
    const out: Position[] = [];
    for (const [tokenId, p] of this.positions) {
      if (p.size.isZero()) continue;
      out.push({
        tokenId,
        size: p.size.toNumber(),
        avgPrice: p.avgCost.toNumber(),
        unrealizedPnL: 0,
      });
    }
    return out;
  }

  /**
   * Simulate a market order, fill at VWAP from the book.
   */
  simulateMarketOrder(
    tokenId: string,
    side: "buy" | "sell",
    size: number,
    book: OrderBook | null
  ): PaperTrade | null {
    if (!book) {
      logger.warn({ tokenId, side }, "No book for paper trade — skipping");
      return null;
    }

    const slip =
      side === "buy"
        ? estimateBuySlippage(book, size)
        : estimateSellSlippage(book, size);

    if (slip.filledSize <= 0) {
      logger.warn({ tokenId, side, size }, "Insufficient liquidity for paper trade");
      return null;
    }

    const fillPrice = slip.vwap;
    const fillSize = slip.filledSize;

    // Update position
    this.updatePosition(tokenId, side, fillPrice, fillSize);

    const trade: PaperTrade = {
      id: genTradeId(),
      tokenId,
      side,
      price: fillPrice,
      size: fillSize,
      filledAt: Date.now(),
    };

    this.trades.push(trade);
    logger.info({ trade }, "Paper trade filled");
    return trade;
  }

  /**
   * Simulate a full arb: buy all legs at ask VWAP.
   * Returns total cost.
   */
  simulateArbBuy(
    legs: { tokenId: string; size: number }[],
    books: Map<string, OrderBook>
  ): { totalCost: number; trades: PaperTrade[] } {
    let totalCost = 0;
    const trades: PaperTrade[] = [];

    for (const leg of legs) {
      const book = books.get(leg.tokenId) ?? null;
      const t = this.simulateMarketOrder(leg.tokenId, "buy", leg.size, book);
      if (t) {
        totalCost += t.price * t.size;
        trades.push(t);
      }
    }

    return { totalCost, trades };
  }

  private updatePosition(
    tokenId: string,
    side: "buy" | "sell",
    price: number,
    size: number
  ): void {
    const existing = this.positions.get(tokenId) ?? {
      size: new Decimal(0),
      avgCost: new Decimal(0),
    };

    const priceDec = new Decimal(price);
    const sizeDec = new Decimal(size);

    if (side === "buy") {
      const newTotalCost = existing.avgCost.mul(existing.size).plus(priceDec.mul(sizeDec));
      const newSize = existing.size.plus(sizeDec);
      const newAvg = newSize.isZero() ? new Decimal(0) : newTotalCost.div(newSize);
      this.positions.set(tokenId, { size: newSize, avgCost: newAvg });
    } else {
      // Sell — realize P&L
      const sellSize = Decimal.min(sizeDec, existing.size);
      const pnl = sellSize.mul(priceDec.minus(existing.avgCost));
      this._realizedPnl = this._realizedPnl.plus(pnl);

      const newSize = existing.size.minus(sellSize);
      this.positions.set(tokenId, {
        size: newSize,
        avgCost: newSize.isZero() ? new Decimal(0) : existing.avgCost,
      });
    }
  }

  toJSON() {
    return {
      tradeCount: this.trades.length,
      realizedPnl: this._realizedPnl.toNumber(),
      positions: this.getAllPositions(),
      recentTrades: this.trades.slice(-20),
    };
  }
}
