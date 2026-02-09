import Decimal from "decimal.js";

/**
 * Rounds a price to the nearest tick
 * Polymarket typically uses 4 decimal places, so tick = 0.0001
 */
export function roundPrice(price: number, tickSize: number = 0.0001): number {
  const ticks = new Decimal(price).div(new Decimal(tickSize));
  const rounded = ticks.round().times(new Decimal(tickSize));
  return rounded.toNumber();
}

/**
 * Round up (ask prices)
 */
export function roundPriceUp(price: number, tickSize: number = 0.0001): number {
  const decimal = new Decimal(price);
  const ticks = decimal.div(new Decimal(tickSize));
  const rounded = ticks.ceil().times(new Decimal(tickSize));
  return rounded.toNumber();
}

/**
 * Round down (bid prices)
 */
export function roundPriceDown(price: number, tickSize: number = 0.0001): number {
  const decimal = new Decimal(price);
  const ticks = decimal.div(new Decimal(tickSize));
  const rounded = ticks.floor().times(new Decimal(tickSize));
  return rounded.toNumber();
}

/**
 * Adjust price by N ticks
 */
export function adjustPriceByTicks(
  price: number,
  ticks: number,
  tickSize: number = 0.0001
): number {
  const adjusted = new Decimal(price).plus(new Decimal(ticks).times(new Decimal(tickSize)));
  return adjusted.toNumber();
}

/**
 * Clamp price to valid range [0, 1]
 */
export function clampPrice(price: number): number {
  return Math.max(0, Math.min(1, price));
}
