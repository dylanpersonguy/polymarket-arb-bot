import pino from "pino";
import { OrderBook } from "./types.js";

const logger = pino({ name: "OrderBooks" });

export class OrderBookManager {
  private books = new Map<string, OrderBook>();
  private readonly maxAgeMs: number;

  constructor(maxAgeMs: number = 2000) {
    this.maxAgeMs = maxAgeMs;
  }

  set(tokenId: string, book: OrderBook): void {
    this.books.set(tokenId, { ...book, lastUpdatedMs: Date.now() });
  }

  get(tokenId: string): OrderBook | null {
    const book = this.books.get(tokenId);
    if (!book) return null;

    // Check if stale
    if (Date.now() - book.lastUpdatedMs > this.maxAgeMs) {
      logger.warn({ tokenId, ageMs: Date.now() - book.lastUpdatedMs }, "Stale order book");
      return null;
    }

    return book;
  }

  getAll(): Map<string, OrderBook> {
    const result = new Map<string, OrderBook>();

    for (const [tokenId, book] of this.books) {
      if (Date.now() - book.lastUpdatedMs <= this.maxAgeMs) {
        result.set(tokenId, book);
      }
    }

    return result;
  }

  has(tokenId: string): boolean {
    const book = this.books.get(tokenId);
    if (!book) return false;
    return Date.now() - book.lastUpdatedMs <= this.maxAgeMs;
  }

  clear(): void {
    this.books.clear();
  }

  size(): number {
    return this.books.size;
  }
}
