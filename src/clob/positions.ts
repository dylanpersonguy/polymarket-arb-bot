import Decimal from "decimal.js";
import { Position } from "./types.js";

export class PositionManager {
  private positions = new Map<string, Position>();

  /** Add to a position (positive size = buy, negative = sell). */
  update(tokenId: string, deltaSizeShares: number, price: number): void {
    const existing = this.positions.get(tokenId);
    if (!existing) {
      this.positions.set(tokenId, {
        tokenId,
        size: deltaSizeShares,
        avgPrice: price,
        unrealizedPnL: 0,
        updatedAt: Date.now(),
      });
      return;
    }

    const oldCost = new Decimal(existing.size).times(existing.avgPrice);
    const newCost = new Decimal(deltaSizeShares).times(price);
    const totalSize = new Decimal(existing.size).plus(deltaSizeShares);

    if (totalSize.isZero()) {
      existing.size = 0;
      existing.avgPrice = 0;
    } else {
      existing.avgPrice = oldCost.plus(newCost).div(totalSize).toNumber();
      existing.size = totalSize.toNumber();
    }
    existing.updatedAt = Date.now();
  }

  get(tokenId: string): Position | null {
    return this.positions.get(tokenId) ?? null;
  }

  getAll(): Position[] {
    return [...this.positions.values()];
  }

  /** Sum of |size * avgPrice| across all positions. */
  totalExposureUsd(): number {
    let total = new Decimal(0);
    for (const p of this.positions.values()) {
      total = total.plus(new Decimal(Math.abs(p.size)).times(p.avgPrice));
    }
    return total.toNumber();
  }

  clear(): void {
    this.positions.clear();
  }
}
