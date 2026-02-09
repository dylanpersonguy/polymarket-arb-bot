import { OrderBook } from "../clob/types.js";
import { computeCostBreakdown, computeOptimalSize } from "./math.js";

export interface MultiOutcomeLeg {
  label: string;
  tokenId: string;
  askPrice: number;
  bidPrice: number;
  askSize: number;
}

export interface MultiOutcomeOpportunity {
  type: "multi_outcome";
  tradeId: string;
  marketName: string;
  legs: MultiOutcomeLeg[];
  totalCost: number;
  feeCost: number;
  slippageCost: number;
  allInCost: number;
  expectedProfit: number;
  expectedProfitBps: number;
  targetSizeShares: number;
  detectedAt: number;
}

export interface MultiDetectorConfig {
  feeBps: number;
  slippageBps: number;
  minProfit: number;
  maxExposureUsd: number;
  perMarketMaxUsd: number;
  minTopSizeUsd: number;
  stalenessMs: number;
  currentGlobalExposureUsd?: number;
}

/**
 * Detect multi-outcome arbitrage.
 *
 * If the sum of all outcome ask prices + fees + slippage < 1.0 we can buy one
 * share of every outcome for a guaranteed payout of $1 on resolution.
 */
export function detectMultiOutcomeArb(
  marketName: string,
  books: Map<string, OrderBook>,
  labels: Map<string, string>,
  cfg: MultiDetectorConfig
): MultiOutcomeOpportunity | null {
  if (books.size < 2) return null;

  const now = Date.now();
  const legs: MultiOutcomeLeg[] = [];
  const askPrices: number[] = [];
  const askSizes: number[] = [];

  for (const [tokenId, book] of books) {
    if (now - book.lastUpdatedMs > cfg.stalenessMs) return null;

    const leg: MultiOutcomeLeg = {
      label: labels.get(tokenId) ?? tokenId,
      tokenId,
      askPrice: book.bestAskPrice,
      bidPrice: book.bestBidPrice,
      askSize: book.bestAskSize,
    };

    // Check min USD size on this leg
    if (leg.askPrice * leg.askSize < cfg.minTopSizeUsd) return null;

    legs.push(leg);
    askPrices.push(leg.askPrice);
    askSizes.push(leg.askSize);
  }

  // Quick reject
  const rawSum = askPrices.reduce((a, b) => a + b, 0);
  if (rawSum >= 1.0) return null;

  // Full cost breakdown
  const bd = computeCostBreakdown(askPrices, cfg.feeBps, cfg.slippageBps);
  if (bd.expectedProfit < cfg.minProfit) return null;

  // Sizing
  const remaining = Math.max(0, cfg.maxExposureUsd - (cfg.currentGlobalExposureUsd ?? 0));
  const targetShares = computeOptimalSize(
    askPrices,
    askSizes,
    cfg.feeBps,
    cfg.slippageBps,
    cfg.perMarketMaxUsd,
    remaining
  );

  if (targetShares <= 0) return null;

  return {
    type: "multi_outcome",
    tradeId: `multi_${now}_${Math.random().toString(36).slice(2, 8)}`,
    marketName,
    legs,
    totalCost: bd.totalCost,
    feeCost: bd.feeCost,
    slippageCost: bd.slippageCost,
    allInCost: bd.allInCost,
    expectedProfit: bd.expectedProfit,
    expectedProfitBps: bd.expectedProfitBps,
    targetSizeShares: targetShares,
    detectedAt: now,
  };
}
