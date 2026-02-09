import { OrderBook } from "../clob/types.js";
import {
  calculateBinaryComplementCost,
  calculateExpectedProfit,
  usdToShares,
} from "./math.js";

export interface ComplementOpportunity {
  type: "binary_complement";
  yesTokenId: string;
  noTokenId: string;
  marketName: string;
  askYes: number;
  askNo: number;
  bidYes: number;
  bidNo: number;
  sizeYes: number;
  sizeNo: number;
  totalCost: number;
  expectedProfit: number;
  expectedProfitBps: number;
  targetSize: number;
  feeCost: number;
  slippageCost: number;
  detectedAt: number;
}

export function detectBinaryComplementArb(
  marketName: string,
  yesBook: OrderBook | null,
  noBook: OrderBook | null,
  config: {
    feeBps: number;
    slippageBps: number;
    minProfit: number;
    maxExposureUsd: number;
    minTopSizeUsd: number;
  }
): ComplementOpportunity | null {
  if (!yesBook || !noBook) {
    return null;
  }

  // Check if books are fresh
  const now = Date.now();
  const maxAgeMs = 2000;
  if (now - yesBook.lastUpdatedMs > maxAgeMs || now - noBook.lastUpdatedMs > maxAgeMs) {
    return null;
  }

  const askYes = yesBook.bestAskPrice;
  const askNo = noBook.bestAskPrice;
  const totalCost = askYes + askNo;

  // Check raw cost first
  if (totalCost >= 1.0) {
    return null;
  }

  // Calculate fees and slippage
  const { feeCost, slippageCost } = calculateBinaryComplementCost(
    askYes,
    askNo,
    config.feeBps,
    config.slippageBps
  );

  const expectedProfit = calculateExpectedProfit(totalCost, feeCost, slippageCost);

  // Check profitability
  if (expectedProfit < config.minProfit) {
    return null;
  }

  // Check liquidity
  const sizeYes = yesBook.bestAskSize;
  const sizeNo = noBook.bestAskSize;

  // Use average price for USD conversion (0.5 is reasonable for YES/NO at equilibrium)
  const avgPrice = (askYes + askNo) / 2;
  const targetSize = usdToShares(config.maxExposureUsd / 2, avgPrice);

  if (sizeYes < targetSize * 0.5 || sizeNo < targetSize * 0.5) {
    return null;
  }

  // Check min size on top
  const yesUsd = sizeYes * askYes;
  const noUsd = sizeNo * askNo;
  if (yesUsd < config.minTopSizeUsd || noUsd < config.minTopSizeUsd) {
    return null;
  }

  return {
    type: "binary_complement",
    yesTokenId: yesBook.tokenId,
    noTokenId: noBook.tokenId,
    marketName,
    askYes,
    askNo,
    bidYes: yesBook.bestBidPrice,
    bidNo: noBook.bestBidPrice,
    sizeYes,
    sizeNo,
    totalCost,
    expectedProfit,
    expectedProfitBps: expectedProfit * 10000,
    targetSize,
    feeCost,
    slippageCost,
    detectedAt: now,
  };
}
