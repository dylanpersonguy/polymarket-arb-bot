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
 * feeCost        = totalCost × takerFeeBps / 10 000
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
/*  VWAP cost from full book depth  (#1)                               */
/* ------------------------------------------------------------------ */

export interface BookLevel {
  price: number;
  size: number;
}

/**
 * Walk asks to compute the VWAP for buying `sizeShares` from a single book side.
 * Returns the effective fill price (VWAP) and the maximum fillable size.
 */
export function computeVwap(levels: BookLevel[], sizeShares: number): { vwap: number; fillableSize: number } {
  if (levels.length === 0 || sizeShares <= 0) return { vwap: 0, fillableSize: 0 };

  let remaining = new Decimal(sizeShares);
  let cost = new Decimal(0);
  let filled = new Decimal(0);

  for (const lvl of levels) {
    if (remaining.lte(0)) break;
    const take = Decimal.min(remaining, new Decimal(lvl.size));
    cost = cost.plus(take.times(lvl.price));
    filled = filled.plus(take);
    remaining = remaining.minus(take);
  }

  if (filled.isZero()) return { vwap: 0, fillableSize: 0 };
  return { vwap: cost.div(filled).toNumber(), fillableSize: filled.toNumber() };
}

/**
 * Compute cost breakdown using VWAP prices from full book depth.
 * Each leg gets its effective price for `sizeShares`.
 */
export function computeCostBreakdownVwap(
  askBooks: BookLevel[][],
  sizeShares: number,
  feeBps: number,
  slippageBps: number
): CostBreakdown & { vwapPrices: number[]; fillableSizes: number[] } {
  const vwapPrices: number[] = [];
  const fillableSizes: number[] = [];

  for (const asks of askBooks) {
    const { vwap, fillableSize } = computeVwap(asks, sizeShares);
    vwapPrices.push(vwap);
    fillableSizes.push(fillableSize);
  }

  const bd = computeCostBreakdown(vwapPrices, feeBps, slippageBps);
  return { ...bd, vwapPrices, fillableSizes };
}

/* ------------------------------------------------------------------ */
/*  Spread filter  (#8)                                                */
/* ------------------------------------------------------------------ */

/**
 * Returns true if the bid/ask spread on this leg is within `maxSpreadBps`.
 * Rejects illiquid legs where the hedge would be catastrophic.
 */
export function isSpreadAcceptable(askPrice: number, bidPrice: number, maxSpreadBps: number): boolean {
  if (askPrice <= 0) return false;
  const spreadBps = ((askPrice - bidPrice) / askPrice) * 10_000;
  return spreadBps <= maxSpreadBps;
}

/* ------------------------------------------------------------------ */
/*  Optimal sizing  (#5 fixed Kelly, #13 per-leg sizing)               */
/* ------------------------------------------------------------------ */

/**
 * Determine the maximum safe number of shares to buy per leg.
 *
 * We cap at the MINIMUM of:
 *   1. Available top-of-book liquidity on the thinnest leg
 *   2. perMarketMaxUsd / allInCostPerShare
 *   3. Remaining global exposure headroom / allInCostPerShare
 *   4. Fractional Kelly: bankroll × edge × kellyFraction / allInCostPerShare  (#5)
 *
 * Returns 0 if the opportunity is not profitable or there is no room.
 */
export function computeOptimalSize(
  askPrices: number[],
  askSizes: number[],
  feeBps: number,
  slippageBps: number,
  perMarketMaxUsd: number,
  remainingGlobalExposureUsd: number,
  bankrollUsd: number = 1000,
  kellyFraction: number = 0.25
): number {
  if (askPrices.length !== askSizes.length) {
    throw new Error("askPrices and askSizes must have the same length");
  }

  const bd = computeCostBreakdown(askPrices, feeBps, slippageBps);
  if (bd.expectedProfit <= 0) return 0;

  const allIn = new Decimal(bd.allInCost);
  if (allIn.lte(0)) return 0;

  // #13 — Per-leg sizing: use the thinnest leg's liquidity
  const minLiquidityShares = Math.min(...askSizes);

  const perMarketShares = new Decimal(perMarketMaxUsd).div(allIn).toNumber();
  const globalShares = new Decimal(remainingGlobalExposureUsd).div(allIn).toNumber();

  // #5 — Fixed Kelly: f* = (edge / allInCost) × kellyFraction × bankroll / allInCost
  // edge = expectedProfit / allInCost  (proportional edge)
  // Kelly shares = bankroll × edge × kellyFraction / allInCost
  const edge = new Decimal(bd.expectedProfit).div(allIn);
  const kellyShares = new Decimal(bankrollUsd)
    .times(edge)
    .times(kellyFraction)
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
