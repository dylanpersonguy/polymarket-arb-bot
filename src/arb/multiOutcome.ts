import { OrderBook } from "../clob/types.js";
import { computeCostBreakdown, computeCostBreakdownVwap, computeOptimalSize, isSpreadAcceptable } from "./math.js";

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
  takerFeeBps?: number;
  slippageBps: number;
  minProfit: number;
  maxExposureUsd: number;
  perMarketMaxUsd: number;
  minTopSizeUsd: number;
  stalenessMs: number;
  currentGlobalExposureUsd?: number;
  maxSpreadBps?: number;              // #8
  useBookDepthForDetection?: boolean;  // #1
  bankrollUsd?: number;               // #5
  kellyFraction?: number;             // #5
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

  // Use effective fee: takerFeeBps takes priority
  const effectiveFee = cfg.takerFeeBps ?? cfg.feeBps;
  const maxSpread = cfg.maxSpreadBps ?? 9999;

  for (const [tokenId, book] of books) {
    if (now - book.lastUpdatedMs > cfg.stalenessMs) return null;

    // #8 — Spread filter per leg
    if (!isSpreadAcceptable(book.bestAskPrice, book.bestBidPrice, maxSpread)) return null;

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

  // Full cost breakdown (top-of-book for quick reject)
  const bd = computeCostBreakdown(askPrices, effectiveFee, cfg.slippageBps);
  if (bd.expectedProfit < cfg.minProfit) return null;

  // Sizing
  const remaining = Math.max(0, cfg.maxExposureUsd - (cfg.currentGlobalExposureUsd ?? 0));
  let targetShares = computeOptimalSize(
    askPrices,
    askSizes,
    effectiveFee,
    cfg.slippageBps,
    cfg.perMarketMaxUsd,
    remaining,
    cfg.bankrollUsd ?? 1000,
    cfg.kellyFraction ?? 0.25
  );

  if (targetShares <= 0) return null;

  // #1 — VWAP re-check using full book depth
  let finalBd = bd;
  if (cfg.useBookDepthForDetection) {
    const allAsks = [...books.values()].map(b => b.asks);
    const hasDepth = allAsks.every(a => a.length > 0);
    if (hasDepth) {
      const vwapBd = computeCostBreakdownVwap(allAsks, targetShares, effectiveFee, cfg.slippageBps);
      if (vwapBd.expectedProfit < cfg.minProfit) return null;

      // Shrink to fillable
      const fillable = Math.min(...vwapBd.fillableSizes);
      if (fillable < targetShares) {
        targetShares = Math.floor(fillable);
        if (targetShares <= 0) return null;
      }

      finalBd = vwapBd;
    }
  }

  return {
    type: "multi_outcome",
    tradeId: `multi_${now}_${Math.random().toString(36).slice(2, 8)}`,
    marketName,
    legs,
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
