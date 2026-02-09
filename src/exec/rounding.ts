import Decimal from "decimal.js";

/**
 * Polymarket tick size = 0.01
 * Prices must be in [0.01 .. 0.99].
 */
export const TICK = 0.01;
export const MIN_PRICE = 0.01;
export const MAX_PRICE = 0.99;

/** Round to nearest tick (0.01). */
export function roundPrice(price: number): number {
  const d = new Decimal(price).div(TICK).round().times(TICK);
  return clamp(d.toNumber());
}

/** Round UP (conservative for buy-side asks). */
export function roundPriceUp(price: number): number {
  const d = new Decimal(price).div(TICK).ceil().times(TICK);
  return clamp(d.toNumber());
}

/** Round DOWN (conservative for sell-side bids). */
export function roundPriceDown(price: number): number {
  const d = new Decimal(price).div(TICK).floor().times(TICK);
  return clamp(d.toNumber());
}

/** Adjust price by ±N ticks. */
export function adjustByTicks(price: number, ticks: number): number {
  const d = new Decimal(price).plus(new Decimal(ticks).times(TICK));
  return clamp(d.toNumber());
}

export function clamp(p: number): number {
  return Math.max(MIN_PRICE, Math.min(MAX_PRICE, p));
}
