import { OrderBook } from "../clob/types.js";
import {
  calculateMultiOutcomeCost,
  calculateExpectedProfit,
  usdToShares,
} from "./math.js";

export interface MultiOutcomeOpportunity {
  type: "multi_outcome";
  marketName: string;
  outcomes: Array<{
    label: string;
    tokenId: string;
    ask: number;
    bid: number;
    size: number;
  }>;
  totalCost: number;
  expectedProfit: number;
  expectedProfitBps: number;
  targetSize: number;
  feeCost: number;
  slippageCost: number;
  detectedAt: number;
}

export function detectMultiOutcomeArb(
  marketName: string,
  books: Map<string, OrderBook>,
  labels: Map<string, string>, // tokenId -> label
  config: {
    feeBps: number;
    slippageBps: number;
    minProfit: number;
    maxExposureUsd: number;
    minTopSizeUsd: number;
  }
): MultiOutcomeOpportunity | null {
  if (books.size < 2) {
    return null;
  }

  // Check freshness
  const now = Date.now();
  const maxAgeMs = 2000;
  for (const book of books.values()) {
    if (now - book.lastUpdatedMs > maxAgeMs) {
      return null;
    }
  }

  const outcomes: Array<{
    label: string;
    tokenId: string;
    ask: number;
    bid: number;
    size: number;
  }> = [];

  let totalCost = 0;
  let minSize = Infinity;
  let minUsd = Infinity;

  for (const [tokenId, book] of books) {
    const ask = book.bestAskPrice;
    const size = book.bestAskSize;
    const usd = size * ask;

    totalCost += ask;
    minSize = Math.min(minSize, size);
    minUsd = Math.min(minUsd, usd);

    outcomes.push({
      label: labels.get(tokenId) || tokenId,
      tokenId,
      ask,
      bid: book.bestBidPrice,
      size,
    });
  }

  // Check raw cost
  if (totalCost >= 1.0) {
    return null;
  }

  // Calculate fees and slippage
  const asks = outcomes.map((o) => o.ask);
  const { feeCost, slippageCost } = calculateMultiOutcomeCost(asks, config.feeBps, config.slippageBps);

  const expectedProfit = calculateExpectedProfit(totalCost, feeCost, slippageCost);

  // Check profitability
  if (expectedProfit < config.minProfit) {
    return null;
  }

  // Check liquidity
  const avgPrice = totalCost / outcomes.length;
  const targetSize = usdToShares(config.maxExposureUsd / outcomes.length, avgPrice);

  if (minSize < targetSize * 0.5) {
    return null;
  }

  if (minUsd < config.minTopSizeUsd) {
    return null;
  }

  return {
    type: "multi_outcome",
    marketName,
    outcomes,
    totalCost,
    expectedProfit,
    expectedProfitBps: expectedProfit * 10000,
    targetSize,
    feeCost,
    slippageCost,
    detectedAt: now,
  };
}
