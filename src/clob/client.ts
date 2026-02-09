import pino from "pino";
import { OrderBook, Order, Position } from "./types.js";
import { retry, CircuitBreaker } from "../utils/retry.js";
import { AdaptiveRateLimiter } from "./rateLimit.js";
import { Env } from "../config/schema.js";

/**
 * CLOB Client Wrapper
 * 
 * This wraps the official @polymarket/clob-client with:
 * - Retry logic with exponential backoff
 * - Rate limiting and 429 handling
 * - Circuit breaker for cascading failures
 * - Structured logging
 * 
 * NOTE: In production, you would integrate the actual @polymarket/clob-client here.
 * For now, this is a minimal interface that maintains the contract.
 */
export class ClobClient {
  private logger: pino.Logger;
  private rateLimiter: AdaptiveRateLimiter;
  private circuitBreaker: CircuitBreaker;
  private books = new Map<string, OrderBook>();
  private orders = new Map<string, Order>();
  private positions = new Map<string, Position>();

  constructor(private env: Env) {
    this.logger = pino({ name: "ClobClient" });
    // Start with 10 requests per second; will adapt based on 429s
    this.rateLimiter = new AdaptiveRateLimiter(10, 20);
    this.circuitBreaker = new CircuitBreaker(5, 2, 30000);
  }

  async initialize(): Promise<void> {
    this.logger.info("Initializing CLOB client");

    if (!this.env.POLYMARKET_PRIVATE_KEY) {
      throw new Error("POLYMARKET_PRIVATE_KEY not set in environment");
    }

    // In a real implementation, you would initialize the @polymarket/clob-client here
    // For now, we validate that the key exists
    this.logger.info("CLOB client initialized");
  }

  async getOrderBook(tokenId: string): Promise<OrderBook> {
    await this.rateLimiter.acquire(1);

    return this.circuitBreaker.execute(async () => {
      return retry(
        async () => {
          this.logger.debug({ tokenId }, "Fetching order book");

          // In production: const book = await this.client.getOrderBook(tokenId);
          // For now, return mock or cached data
          const cached = this.books.get(tokenId);
          if (cached) {
            return cached;
          }

          // Return a default book
          const book: OrderBook = {
            tokenId,
            bestBidPrice: 0.5,
            bestBidSize: 100,
            bestAskPrice: 0.51,
            bestAskSize: 100,
            lastUpdatedMs: Date.now(),
          };
          this.books.set(tokenId, book);
          return book;
        },
        {
          maxAttempts: 3,
          initialDelayMs: 100,
          onRetry: (attempt, error) => {
            this.logger.warn({ tokenId, attempt, error: error.message }, "Retrying getOrderBook");
          },
        }
      );
    });
  }

  async getMultipleOrderBooks(tokenIds: string[]): Promise<Map<string, OrderBook>> {
    const results = new Map<string, OrderBook>();

    for (const tokenId of tokenIds) {
      try {
        const book = await this.getOrderBook(tokenId);
        results.set(tokenId, book);
      } catch (error) {
        this.logger.error(
          { tokenId, error: error instanceof Error ? error.message : String(error) },
          "Failed to fetch order book"
        );
        this.rateLimiter.recordError(500);
      }
    }

    return results;
  }

  async placeOrder(
    tokenId: string,
    side: "buy" | "sell",
    price: number,
    size: number
  ): Promise<Order> {
    await this.rateLimiter.acquire(2); // Place order is heavier

    return this.circuitBreaker.execute(async () => {
      return retry(
        async () => {
          this.logger.info({ tokenId, side, price, size }, "Placing order");

          // In production: const order = await this.client.createOrder({...});
          // For now, create a mock order
          const order: Order = {
            id: `order_${Date.now()}_${Math.random()}`,
            tokenId,
            side,
            price,
            size,
            filledSize: 0,
            status: "open",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };

          this.orders.set(order.id, order);
          this.logger.info({ orderId: order.id }, "Order placed successfully");
          return order;
        },
        {
          maxAttempts: 2,
          initialDelayMs: 200,
          onRetry: (attempt, error) => {
            if (error.message.includes("429")) {
              this.rateLimiter.recordError(429);
            }
            this.logger.warn(
              { tokenId, side, attempt, error: error.message },
              "Retrying placeOrder"
            );
          },
        }
      );
    });
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.rateLimiter.acquire(1);

    return this.circuitBreaker.execute(async () => {
      return retry(
        async () => {
          this.logger.info({ orderId }, "Canceling order");

          // In production: await this.client.cancelOrder(orderId);
          const order = this.orders.get(orderId);
          if (order) {
            order.status = "cancelled";
            order.updatedAt = Date.now();
          }

          this.logger.info({ orderId }, "Order cancelled");
        },
        {
          maxAttempts: 2,
          initialDelayMs: 100,
        }
      );
    });
  }

  async getOrderStatus(orderId: string): Promise<Order | null> {
    await this.rateLimiter.acquire(1);

    return this.circuitBreaker.execute(async () => {
      return retry(
        async () => {
          this.logger.debug({ orderId }, "Fetching order status");

          // In production: const order = await this.client.getOrder(orderId);
          return this.orders.get(orderId) || null;
        },
        {
          maxAttempts: 3,
          initialDelayMs: 50,
        }
      );
    });
  }

  async getPositions(): Promise<Position[]> {
    await this.rateLimiter.acquire(1);

    return this.circuitBreaker.execute(async () => {
      return retry(
        async () => {
          this.logger.debug("Fetching positions");

          // In production: const positions = await this.client.getPositions();
          return Array.from(this.positions.values());
        },
        {
          maxAttempts: 3,
          initialDelayMs: 100,
        }
      );
    });
  }

  getCircuitBreakerState(): string {
    return this.circuitBreaker.getState();
  }
}
