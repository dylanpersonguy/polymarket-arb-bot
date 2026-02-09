export function calculateSlippage(
  price: number,
  size: number,
  depth: Map<number, number>,
  side: "buy" | "sell"
): number {
  let remainingSize = size;
  let totalCost = 0;

  // Sort price levels (descending for sell, ascending for buy)
  const pricePoints = Array.from(depth.keys()).sort((a, b) => (side === "buy" ? a - b : b - a));

  for (const level of pricePoints) {
    const availableSize = depth.get(level) || 0;
    if (availableSize === 0) continue;

    const sizeToFill = Math.min(remainingSize, availableSize);
    totalCost += sizeToFill * level;
    remainingSize -= sizeToFill;

    if (remainingSize === 0) break;
  }

  if (remainingSize > 0) {
    // Unable to fill entire size, estimate slippage
    return 0.01; // 1% slippage as fallback
  }

  const averagePrice = totalCost / size;
  const expectedPrice = side === "buy" ? price : price;
  return Math.abs(averagePrice - expectedPrice) / price;
}
