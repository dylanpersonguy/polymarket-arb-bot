import Decimal from "decimal.js";

/**
 * Arbitrage math module
 * 
 * Handles conversion between USD and shares, profit calculations, and rounding.
 * Uses Decimal.js for precision.
 */

export function calculateBinaryComplementCost(
  askYes: number,
  askNo: number,
  feeBps: number,
  slippageBps: number
): { totalCost: number; feeCost: number; slippageCost: number } {
  const totalCost = new Decimal(askYes).plus(new Decimal(askNo));
  const feeCost = totalCost.times(new Decimal(feeBps).div(10000));
  const slippageCost = totalCost.times(new Decimal(slippageBps).div(10000));

  return {
    totalCost: totalCost.toNumber(),
    feeCost: feeCost.toNumber(),
    slippageCost: slippageCost.toNumber(),
  };
}

export function calculateMultiOutcomeCost(
  asks: number[],
  feeBps: number,
  slippageBps: number
): { totalCost: number; feeCost: number; slippageCost: number } {
  let totalCost = new Decimal(0);
  for (const ask of asks) {
    totalCost = totalCost.plus(new Decimal(ask));
  }

  const feeCost = totalCost.times(new Decimal(feeBps).div(10000));
  const slippageCost = totalCost.times(new Decimal(slippageBps).div(10000));

  return {
    totalCost: totalCost.toNumber(),
    feeCost: feeCost.toNumber(),
    slippageCost: slippageCost.toNumber(),
  };
}

export function calculateExpectedProfit(
  totalCost: number,
  feeCost: number,
  slippageCost: number
): number {
  // Profit = 1 - (cost + fees + slippage)
  const profit = new Decimal(1)
    .minus(new Decimal(totalCost))
    .minus(new Decimal(feeCost))
    .minus(new Decimal(slippageCost));

  return profit.toNumber();
}

/**
 * Check if an arbitrage opportunity is profitable
 */
export function isProfitable(
  totalCost: number,
  feeBps: number,
  slippageBps: number,
  minProfit: number
): boolean {
  const { feeCost, slippageCost } = calculateBinaryComplementCost(0, totalCost, feeBps, slippageBps);
  const profit = calculateExpectedProfit(totalCost, feeCost, slippageCost);
  return profit >= minProfit;
}

/**
 * Convert USD notional to shares assuming a market with 0-1 price range
 */
export function usdToShares(usdAmount: number, price: number = 0.5): number {
  // If price is 0.5 (typical middle), 1 USD = 2 shares
  // More generally: shares = USD / price
  if (price <= 0 || price > 1) {
    throw new Error(`Invalid price: ${price}`);
  }
  return new Decimal(usdAmount).div(new Decimal(price)).toNumber();
}

/**
 * Convert shares to USD notional
 */
export function sharesToUsd(shares: number, price: number = 0.5): number {
  if (price <= 0 || price > 1) {
    throw new Error(`Invalid price: ${price}`);
  }
  return new Decimal(shares).times(new Decimal(price)).toNumber();
}

/**
 * Calculate potential loss if we can't hedge a position
 */
export function calculateMaxLoss(
  targetSize: number,
  entryPrice: number,
  exitBid: number
): number {
  const lossPerShare = new Decimal(entryPrice).minus(new Decimal(exitBid));
  const totalLoss = new Decimal(targetSize).times(lossPerShare);
  return totalLoss.toNumber();
}
