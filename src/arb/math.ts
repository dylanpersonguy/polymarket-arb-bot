import Decimal from "decimal.js";

/** Polymarket uses 0.01 tick size (prices 0.01 – 0.99). */
export const TICK_SIZE = 0.01;

/* ------------------------------------------------------------------ */
/*  Cost breakdown                                                     */
/* ------------------------------------------------------------------ */

export interface CostBreakdown {
  totalCost: number;
  feeCost: number;
  slippageCost: number;
  allInCost: number;
  expectedProfit: number;
  expectedProfitBps: number;
}

/**
 * Unified cost calculator for any basket of asks.
 *
 * totalCost      = Σ askPrice_i
 * feeCost        = totalCost × feeBps / 10 000
 * slippageCost   = totalCost × (slippageBps + extraSlippageBps) / 10 000
 * allInCost      = totalCost + feeCost + slippageCost
 * expectedProfit = 1 − allInCost    (basket resolves to exactly 1.0)
 */
export function computeCostBreakdown(
  askPrices: number[],
  feeBps: number,
  slippageBps: number,
  extraSlippageBps: number = 0
): CostBreakdown {
  let sum = new Decimal(0);
  for (const p of askPrices) sum = sum.plus(p);

  const totalSlipBps = new Decimal(slippageBps).plus(extraSlippageBps);
  const feeCost = sum.times(new Decimal(feeBps).div(10000));
  const slippageCost = sum.times(totalSlipBps.div(10000));
  const allInCost = sum.plus(feeCost).plus(slippageCost);
  const expectedProfit = new Decimal(1).minus(allInCost);
  const expectedProfitBps = expectedProfit.times(10000);

  return {
    totalCost: sum.toNumber(),
    feeCost: feeCost.toNumber(),
    slippageCost: slippageCost.toNumber(),
    allInCost: allInCost.toNumber(),
    expectedProfit: expectedProfit.toNumber(),
    expectedProfitBps: expectedProfitBps.toNumber(),
  };
}

/**
 * Quick profitability check.
 */
export function isProfitable(
  askPrices: number[],
  feeBps: number,
  slippageBps: number,
  minProfit: number,
  extraSlippageBps: number = 0
): boolean {
  return computeCostBreakdown(askPrices, feeBps, slippageBps, extraSlippageBps).expectedProfit >= minProfit;
}

/* ------------------------------------------------------------------ */
/*  Optimal sizing                                                     */
/* ------------------------------------------------------------------ */

/**
 * Determine the maximum safe number of shares to buy per leg.
 *
 * We cap at the MINIMUM of:
 *   1. Available top-of-book liquidity on the thinnest leg
 *   2. perMarketMaxUsd / allInCostPerShare
 *   3. Remaining global exposure headroom / allInCostPerShare
 *   4. Fractional Kelly (25 %) to avoid over-betting on thin edges
 *
 * Returns 0 if the opportunity is not profitable or there is no room.
 */
export function computeOptimalSize(
  askPrices: number[],
  askSizes: number[],
  feeBps: number,
  slippageBps: number,
  perMarketMaxUsd: number,
  remainingGlobalExposureUsd: number
): number {
  if (askPrices.length !== askSizes.length) {
    throw new Error("askPrices and askSizes must have the same length");
  }

  const bd = computeCostBreakdown(askPrices, feeBps, slippageBps);
  if (bd.expectedProfit <= 0) return 0;

  const allIn = new Decimal(bd.allInCost);
  if (allIn.lte(0)) return 0;

  const minLiquidityShares = Math.min(...askSizes);
  const perMarketShares = new Decimal(perMarketMaxUsd).div(allIn).toNumber();
  const globalShares = new Decimal(remainingGlobalExposureUsd).div(allIn).toNumber();

  // Fractional Kelly: f* = edge / variance; for complementary arb variance ≈ edge,
  // so full Kelly ≈ 1 share.  We use 25 % Kelly on the per-market cap.
  const kellyShares = new Decimal(perMarketMaxUsd)
    .times(bd.expectedProfit)
    .times(0.25)
    .div(allIn)
    .toNumber();

  const optimal = Math.min(minLiquidityShares, perMarketShares, globalShares, kellyShares);
  return Math.max(0, Math.floor(optimal));
}

/* ------------------------------------------------------------------ */
/*  Conversions                                                        */
/* ------------------------------------------------------------------ */

export function usdToShares(usd: number, price: number): number {
  if (price <= 0 || price > 1) throw new Error(`Invalid price: ${price}`);
  return new Decimal(usd).div(price).toNumber();
}

export function sharesToUsd(shares: number, price: number): number {
  if (price <= 0 || price > 1) throw new Error(`Invalid price: ${price}`);
  return new Decimal(shares).times(price).toNumber();
}

/**
 * Worst-case loss if we must exit at `exitBid`.
 */
export function calculateMaxLoss(size: number, entryPrice: number, exitBid: number): number {
  return new Decimal(size)
    .times(new Decimal(entryPrice).minus(exitBid))
    .abs()
    .toNumber();
}
