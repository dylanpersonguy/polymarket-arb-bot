import pino from "pino";
import { OrderBook } from "./types.js";
import { isStale } from "../utils/time.js";

const logger = pino({ name: "OrderBooks" });

/**
 * In-memory top-of-book cache with staleness checking.
 * maxAgeMs is derived from config (2 * pollingIntervalMs + 200).
 */
export class OrderBookManager {
  private books = new Map<string, OrderBook>();

  constructor(private readonly maxAgeMs: number) {}

  set(tokenId: string, book: OrderBook): void {
    this.books.set(tokenId, { ...book, lastUpdatedMs: Date.now() });
  }

  /** Returns book only if fresh; null otherwise. */
  get(tokenId: string): OrderBook | null {
    const book = this.books.get(tokenId);
    if (!book) return null;
    if (isStale(book.lastUpdatedMs, this.maxAgeMs)) {
      logger.debug({ tokenId, ageMs: Date.now() - book.lastUpdatedMs }, "Stale book ignored");
      return null;
    }
    return book;
  }

  /** All fresh books. */
  getAll(): Map<string, OrderBook> {
    const result = new Map<string, OrderBook>();
    for (const [id, book] of this.books) {
      if (!isStale(book.lastUpdatedMs, this.maxAgeMs)) {
        result.set(id, book);
      }
    }
    return result;
  }

  has(tokenId: string): boolean {
    return this.get(tokenId) !== null;
  }

  clear(): void {
    this.books.clear();
  }
}
