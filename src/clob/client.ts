import pino from "pino";
import { OrderBook, Order } from "./types.js";
import { retry, CircuitBreaker } from "../utils/retry.js";
import { AdaptiveRateLimiter } from "./rateLimit.js";
import { Env } from "../config/schema.js";

const logger = pino({ name: "ClobClient" });

/**
 * Wrapper around @polymarket/clob-client.
 *
 * In production you would instantiate the real ClobOrderUtils / ClobClient
 * from the SDK.  This wrapper adds:
 *  – rate limiting (adaptive token bucket)
 *  – retry with exponential backoff + 429 handling
 *  – circuit breaker to avoid hammering a failing endpoint
 *
 * The methods below are thin pass-throughs; swap the body for real SDK calls.
 */
export class ClobClient {
  private limiter: AdaptiveRateLimiter;
  private breaker: CircuitBreaker;

  constructor(private env: Env) {
    this.limiter = new AdaptiveRateLimiter(10, 20);
    this.breaker = new CircuitBreaker(5, 2, 30_000);
  }

  async initialize(): Promise<void> {
    if (!this.env.POLYMARKET_PRIVATE_KEY || this.env.POLYMARKET_PRIVATE_KEY === "0x") {
      throw new Error("POLYMARKET_PRIVATE_KEY is not set or empty");
    }
    logger.info("CLOB client initialised (mock mode — swap for real SDK)");
  }

  /* ---- Order book ---- */

  async getOrderBook(tokenId: string): Promise<OrderBook> {
    await this.limiter.acquire();
    return this.breaker.execute(() =>
      retry(
        async () => {
          // TODO: replace with real SDK call
          //   const book = await realClient.getOrderBook(tokenId);
          return {
            tokenId,
            bestBidPrice: 0.48,
            bestBidSize: 200,
            bestAskPrice: 0.49,
            bestAskSize: 200,
            bids: [{ price: 0.48, size: 200 }],
            asks: [{ price: 0.49, size: 200 }],
            lastUpdatedMs: Date.now(),
          } satisfies OrderBook;
        },
        {
          maxAttempts: 3,
          initialDelayMs: 150,
          onRetry: (attempt, err, delay) => {
            if (err.message.includes("429")) this.limiter.recordError(429);
            logger.warn({ tokenId, attempt, delay }, "Retrying getOrderBook");
          },
        }
      )
    );
  }

  async getMultipleOrderBooks(tokenIds: string[]): Promise<Map<string, OrderBook>> {
    const results = new Map<string, OrderBook>();
    for (const id of tokenIds) {
      try {
        results.set(id, await this.getOrderBook(id));
        this.limiter.recordSuccess();
      } catch (err) {
        logger.error({ tokenId: id, err: String(err) }, "getOrderBook failed");
        this.limiter.recordError(500);
      }
    }
    return results;
  }

  /* ---- Orders ---- */

  async placeOrder(
    tokenId: string,
    side: "buy" | "sell",
    price: number,
    size: number
  ): Promise<Order> {
    await this.limiter.acquire(2);
    return this.breaker.execute(() =>
      retry(
        async () => {
          logger.info({ tokenId, side, price, size }, "Placing order");
          // TODO: replace with real SDK call
          const order: Order = {
            id: `ord_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            tokenId,
            side,
            price,
            size,
            filledSize: 0,
            status: "open",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          return order;
        },
        {
          maxAttempts: 2,
          initialDelayMs: 200,
          onRetry: (attempt, err) => {
            if (err.message.includes("429")) this.limiter.recordError(429);
            logger.warn({ tokenId, side, attempt }, "Retrying placeOrder");
          },
        }
      )
    );
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.limiter.acquire();
    await this.breaker.execute(() =>
      retry(
        async () => {
          logger.info({ orderId }, "Cancelling order");
          // TODO: replace with real SDK call
        },
        { maxAttempts: 2, initialDelayMs: 100 }
      )
    );
  }

  async getOrderStatus(_orderId: string): Promise<Order | null> {
    await this.limiter.acquire();
    return this.breaker.execute(() =>
      retry(
        async () => {
          // TODO: replace with real SDK call — query order by _orderId
          return null;
        },
        { maxAttempts: 2, initialDelayMs: 100 }
      )
    );
  }

  async cancelAllOpenOrders(): Promise<void> {
    logger.warn("Cancelling ALL open orders via API");
    // TODO: replace with real SDK call
  }

  getCircuitBreakerState(): "closed" | "open" | "half-open" {
    return this.breaker.getState();
  }
}
