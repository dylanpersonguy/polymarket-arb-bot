import { OrderBook } from "../clob/types.js";
import { computeCostBreakdown, computeOptimalSize } from "./math.js";

export interface ComplementOpportunity {
  type: "binary_complement";
  tradeId: string;
  marketName: string;
  yesTokenId: string;
  noTokenId: string;
  askYes: number;
  askNo: number;
  bidYes: number;
  bidNo: number;
  sizeYes: number;
  sizeNo: number;
  totalCost: number;
  feeCost: number;
  slippageCost: number;
  allInCost: number;
  expectedProfit: number;
  expectedProfitBps: number;
  targetSizeShares: number;
  detectedAt: number;
}

export interface ComplementDetectorConfig {
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
 * Detect binary complement arbitrage.
 *
 * Profitable when ask(YES) + ask(NO) + fees + slippage < 1.0
 * because owning one share of YES + one share of NO resolves to exactly $1.
 */
export function detectBinaryComplementArb(
  marketName: string,
  yesBook: OrderBook | null,
  noBook: OrderBook | null,
  cfg: ComplementDetectorConfig
): ComplementOpportunity | null {
  if (!yesBook || !noBook) return null;

  // Staleness check
  const now = Date.now();
  if (now - yesBook.lastUpdatedMs > cfg.stalenessMs) return null;
  if (now - noBook.lastUpdatedMs > cfg.stalenessMs) return null;

  const askYes = yesBook.bestAskPrice;
  const askNo = noBook.bestAskPrice;

  // Quick reject: raw cost already ≥ 1
  if (askYes + askNo >= 1.0) return null;

  // Full cost breakdown
  const bd = computeCostBreakdown([askYes, askNo], cfg.feeBps, cfg.slippageBps);
  if (bd.expectedProfit < cfg.minProfit) return null;

  // Liquidity: must have enough USD-size on each side
  const yesUsd = yesBook.bestAskSize * askYes;
  const noUsd = noBook.bestAskSize * askNo;
  if (yesUsd < cfg.minTopSizeUsd || noUsd < cfg.minTopSizeUsd) return null;

  // Optimal sizing
  const remainingExposure = Math.max(0, cfg.maxExposureUsd - (cfg.currentGlobalExposureUsd ?? 0));
  const targetShares = computeOptimalSize(
    [askYes, askNo],
    [yesBook.bestAskSize, noBook.bestAskSize],
    cfg.feeBps,
    cfg.slippageBps,
    cfg.perMarketMaxUsd,
    remainingExposure
  );

  if (targetShares <= 0) return null;

  return {
    type: "binary_complement",
    tradeId: `comp_${now}_${Math.random().toString(36).slice(2, 8)}`,
    marketName,
    yesTokenId: yesBook.tokenId,
    noTokenId: noBook.tokenId,
    askYes,
    askNo,
    bidYes: yesBook.bestBidPrice,
    bidNo: noBook.bestBidPrice,
    sizeYes: yesBook.bestAskSize,
    sizeNo: noBook.bestAskSize,
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
