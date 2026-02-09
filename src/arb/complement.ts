import { OrderBook } from "../clob/types.js";
import { computeCostBreakdown, computeCostBreakdownVwap, computeOptimalSize, isSpreadAcceptable } from "./math.js";

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
  takerFeeBps?: number;
  slippageBps: number;
  minProfit: number;
  maxExposureUsd: number;
  perMarketMaxUsd: number;
  minTopSizeUsd: number;
  stalenessMs: number;
  currentGlobalExposureUsd?: number;
  maxSpreadBps?: number;            // #8
  useBookDepthForDetection?: boolean;  // #1
  bankrollUsd?: number;             // #5
  kellyFraction?: number;           // #5
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

  // #8 — Spread filter: reject if either side has a wide spread
  const maxSpread = cfg.maxSpreadBps ?? 9999;
  if (!isSpreadAcceptable(askYes, yesBook.bestBidPrice, maxSpread)) return null;
  if (!isSpreadAcceptable(askNo, noBook.bestBidPrice, maxSpread)) return null;

  // Use effective fee: takerFeeBps takes priority over legacy feeBps
  const effectiveFee = cfg.takerFeeBps ?? cfg.feeBps;

  // Full cost breakdown (top-of-book first for quick reject)
  const bd = computeCostBreakdown([askYes, askNo], effectiveFee, cfg.slippageBps);
  if (bd.expectedProfit < cfg.minProfit) return null;

  // Liquidity: must have enough USD-size on each side
  const yesUsd = yesBook.bestAskSize * askYes;
  const noUsd = noBook.bestAskSize * askNo;
  if (yesUsd < cfg.minTopSizeUsd || noUsd < cfg.minTopSizeUsd) return null;

  // Optimal sizing
  const remainingExposure = Math.max(0, cfg.maxExposureUsd - (cfg.currentGlobalExposureUsd ?? 0));
  let targetShares = computeOptimalSize(
    [askYes, askNo],
    [yesBook.bestAskSize, noBook.bestAskSize],
    effectiveFee,
    cfg.slippageBps,
    cfg.perMarketMaxUsd,
    remainingExposure,
    cfg.bankrollUsd ?? 1000,
    cfg.kellyFraction ?? 0.25
  );

  if (targetShares <= 0) return null;

  // #1 — VWAP re-check: use full book depth to confirm profitability at target size
  let finalBd = bd;
  if (cfg.useBookDepthForDetection && yesBook.asks.length > 0 && noBook.asks.length > 0) {
    const vwapBd = computeCostBreakdownVwap(
      [yesBook.asks, noBook.asks],
      targetShares,
      effectiveFee,
      cfg.slippageBps
    );

    // Re-check profitability with VWAP prices
    if (vwapBd.expectedProfit < cfg.minProfit) return null;

    // Shrink size if we can't fill fully
    const fillable = Math.min(...vwapBd.fillableSizes);
    if (fillable < targetShares) {
      targetShares = Math.floor(fillable);
      if (targetShares <= 0) return null;
    }

    finalBd = vwapBd;
  }

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
    totalCost: finalBd.totalCost,
    feeCost: finalBd.feeCost,
    slippageCost: finalBd.slippageCost,
    allInCost: finalBd.allInCost,
    expectedProfit: finalBd.expectedProfit,
    expectedProfitBps: finalBd.expectedProfitBps,
    targetSizeShares: targetShares,
    detectedAt: now,
  };
}
