import pino from "pino";
import { Position } from "./types.js";

const logger = pino({ name: "Positions" });

export class PositionManager {
  private positions = new Map<string, Position>();

  update(
    tokenId: string,
    size: number,
    price: number,
    mark?: number
  ): void {
    let position = this.positions.get(tokenId);

    if (!position) {
      position = {
        tokenId,
        size,
        avgPrice: price,
        unrealizedPnL: 0,
        updatedAt: Date.now(),
      };
    } else {
      // Update average price
      const totalCost = position.size * position.avgPrice + size * price;
      const totalSize = position.size + size;

      if (totalSize !== 0) {
        position.avgPrice = totalCost / totalSize;
        position.size = totalSize;
      } else {
        position.size = 0;
        position.avgPrice = 0;
      }
    }

    if (mark) {
      position.unrealizedPnL = position.size * (mark - position.avgPrice);
    }

    position.updatedAt = Date.now();
    this.positions.set(tokenId, position);

    logger.debug(
      { tokenId, size, avgPrice: position.avgPrice, unrealizedPnL: position.unrealizedPnL },
      "Position updated"
    );
  }

  get(tokenId: string): Position | null {
    return this.positions.get(tokenId) || null;
  }

  getAll(): Position[] {
    return Array.from(this.positions.values());
  }

  getExposureUsd(markPrices: Map<string, number>): number {
    let totalExposure = 0;

    for (const position of this.positions.values()) {
      const mark = markPrices.get(position.tokenId) || position.avgPrice;
      totalExposure += Math.abs(position.size * mark);
    }

    return totalExposure;
  }

  getNetExposureUsd(markPrices: Map<string, number>): number {
    let totalValue = 0;

    for (const position of this.positions.values()) {
      const mark = markPrices.get(position.tokenId) || position.avgPrice;
      totalValue += position.size * mark;
    }

    return totalValue;
  }

  close(tokenId: string): void {
    const position = this.positions.get(tokenId);
    if (position) {
      position.size = 0;
      position.unrealizedPnL = 0;
      position.updatedAt = Date.now();
    }
  }

  clear(): void {
    this.positions.clear();
  }

  size(): number {
    return this.positions.size;
  }
}
