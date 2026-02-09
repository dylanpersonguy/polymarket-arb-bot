import { OrderBook } from "../clob/types.js";
import Decimal from "decimal.js";

/**
 * Walk the order book to estimate effective execution price for a
 * given `sizeShares` of buying (take asks) or selling (take bids).
 *
 * Returns the volume-weighted average price (VWAP) and total cost.
 */
export interface SlippageEstimate {
  vwap: number;
  totalCost: number;
  filledSize: number;
  priceImpactBps: number;
}

export function estimateBuySlippage(book: OrderBook, sizeShares: number): SlippageEstimate {
  return walkSide(book.asks, sizeShares);
}

export function estimateSellSlippage(book: OrderBook, sizeShares: number): SlippageEstimate {
  return walkSide(book.bids, sizeShares);
}

function walkSide(
  levels: { price: number; size: number }[],
  sizeShares: number
): SlippageEstimate {
  if (levels.length === 0 || sizeShares <= 0) {
    return { vwap: 0, totalCost: 0, filledSize: 0, priceImpactBps: 0 };
  }

  let remaining = new Decimal(sizeShares);
  let cost = new Decimal(0);
  let filled = new Decimal(0);
  const bestPrice = new Decimal(levels[0].price);

  for (const level of levels) {
    if (remaining.lte(0)) break;
    const take = Decimal.min(remaining, new Decimal(level.size));
    cost = cost.plus(take.mul(new Decimal(level.price)));
    filled = filled.plus(take);
    remaining = remaining.minus(take);
  }

  if (filled.isZero()) {
    return { vwap: 0, totalCost: 0, filledSize: 0, priceImpactBps: 0 };
  }

  const vwap = cost.div(filled);
  const impactBps = bestPrice.isZero()
    ? 0
    : vwap.minus(bestPrice).div(bestPrice).mul(10_000).toNumber();

  return {
    vwap: vwap.toNumber(),
    totalCost: cost.toNumber(),
    filledSize: filled.toNumber(),
    priceImpactBps: Math.abs(impactBps),
  };
}
