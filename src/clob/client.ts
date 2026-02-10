import pino from "pino";
import http from "node:http";
import https from "node:https";
import { ethers } from "ethers";
import {
  ClobClient as PolyClobClient,
  Chain,
  Side,
  OrderType,
  AssetType,
} from "@polymarket/clob-client";
import type {
  ApiKeyCreds,
  OrderBookSummary,
  OpenOrder as PolyOpenOrder,
} from "@polymarket/clob-client";
import { OrderBook, OrderBookLevel, Order } from "./types.js";
import { retry, CircuitBreaker } from "../utils/retry.js";
import { AdaptiveRateLimiter } from "./rateLimit.js";
import { Env } from "../config/schema.js";

const logger = pino({ name: "ClobClient" });

const CLOB_HOST = "https://clob.polymarket.com";

/**
 * Production wrapper around @polymarket/clob-client.
 *
 * Uses the real Polymarket CLOB SDK for:
 *  – order book fetching
 *  – order placement / cancellation / status
 *  – balance queries
 *
 * Adds:
 *  – adaptive rate limiting (token bucket)
 *  – retry with exponential backoff + 429 handling
 *  – circuit breaker to avoid hammering a failing endpoint
 */
export class ClobClient {
  private limiter: AdaptiveRateLimiter;
  private bookBreaker: CircuitBreaker;   // public endpoints (order books)
  private authBreaker: CircuitBreaker;   // authenticated endpoints (balance, orders)
  private sdk: PolyClobClient | null = null;

  /** Keep-alive agents — reuse TCP connections for 5x less latency */
  private readonly httpAgent = new http.Agent({ keepAlive: true, maxSockets: 20, keepAliveMsecs: 30_000 });
  private readonly httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 20, keepAliveMsecs: 30_000 });

  /** Rate-limit priority: "high" consumes 1 token, "low" consumes 2 (used for non-critical scans) */
  private priority: "high" | "low" = "high";

  constructor(private env: Env) {
    this.limiter = new AdaptiveRateLimiter(10, 20);
    this.bookBreaker = new CircuitBreaker(5, 2, 30_000);
    this.authBreaker = new CircuitBreaker(5, 2, 30_000);
  }

  /** Set rate-limit priority — "high" for arb path, "low" for background scanning */
  setPriority(p: "high" | "low"): void { this.priority = p; }

  /** Get the HTTPS keep-alive agent for external use */
  getHttpsAgent(): https.Agent { return this.httpsAgent; }

  async initialize(): Promise<void> {
    if (!this.env.POLYMARKET_PRIVATE_KEY || this.env.POLYMARKET_PRIVATE_KEY === "0x") {
      logger.warn("No private key — running in read-only mode (order book only)");
    }

    const hasCreds =
      this.env.POLYMARKET_API_KEY &&
      this.env.POLYMARKET_API_SECRET &&
      this.env.POLYMARKET_API_PASSPHRASE;

    const signer =
      this.env.POLYMARKET_PRIVATE_KEY && this.env.POLYMARKET_PRIVATE_KEY !== "0x"
        ? new ethers.Wallet(this.env.POLYMARKET_PRIVATE_KEY)
        : undefined;

    const creds: ApiKeyCreds | undefined = hasCreds
      ? {
          key: this.env.POLYMARKET_API_KEY!,
          secret: this.env.POLYMARKET_API_SECRET!,
          passphrase: this.env.POLYMARKET_API_PASSPHRASE!,
        }
      : undefined;

    this.sdk = new PolyClobClient(CLOB_HOST, Chain.POLYGON, signer, creds);

    // Verify connectivity
    try {
      const ok = await this.sdk.getOk();
      logger.info({ ok, hasSigner: !!signer, hasCreds: !!creds }, "CLOB client initialised");
    } catch (err) {
      logger.warn({ err: String(err) }, "CLOB health check failed — continuing anyway");
    }
  }

  private getSdk(): PolyClobClient {
    if (!this.sdk) throw new Error("ClobClient not initialised — call initialize() first");
    return this.sdk;
  }

  /* ---- Order book ---- */

  async getOrderBook(tokenId: string): Promise<OrderBook> {
    const tokens = this.priority === "low" ? 2 : 1;
    await this.limiter.acquire(tokens);
    return this.bookBreaker.execute(() =>
      retry(
        async () => {
          const raw: OrderBookSummary = await this.getSdk().getOrderBook(tokenId);
          return this.convertOrderBook(tokenId, raw);
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

  /** Fetch multiple order books in parallel batches for speed */
  async getMultipleOrderBooksParallel(tokenIds: string[], batchSize = 10): Promise<Map<string, OrderBook>> {
    const results = new Map<string, OrderBook>();
    for (let i = 0; i < tokenIds.length; i += batchSize) {
      const batch = tokenIds.slice(i, i + batchSize);
      const settled = await Promise.allSettled(
        batch.map(async (id) => {
          const book = await this.getOrderBook(id);
          this.limiter.recordSuccess();
          return { id, book };
        })
      );
      for (const r of settled) {
        if (r.status === "fulfilled" && r.value.book) {
          results.set(r.value.id, r.value.book);
        } else if (r.status === "rejected") {
          this.limiter.recordError(500);
        }
      }
    }
    return results;
  }

  /** Convert SDK OrderBookSummary to our internal OrderBook type. */
  private convertOrderBook(tokenId: string, raw: OrderBookSummary): OrderBook {
    const bids: OrderBookLevel[] = (raw.bids ?? [])
      .map((l) => ({ price: parseFloat(l.price), size: parseFloat(l.size) }))
      .sort((a, b) => b.price - a.price);

    const asks: OrderBookLevel[] = (raw.asks ?? [])
      .map((l) => ({ price: parseFloat(l.price), size: parseFloat(l.size) }))
      .sort((a, b) => a.price - b.price);

    return {
      tokenId,
      bestBidPrice: bids[0]?.price ?? 0,
      bestBidSize: bids[0]?.size ?? 0,
      bestAskPrice: asks[0]?.price ?? Infinity,
      bestAskSize: asks[0]?.size ?? 0,
      bids,
      asks,
      lastUpdatedMs: Date.now(),
    };
  }

  /* ---- Orders ---- */

  async placeOrder(
    tokenId: string,
    side: "buy" | "sell",
    price: number,
    size: number
  ): Promise<Order> {
    await this.limiter.acquire(2);
    return this.authBreaker.execute(() =>
      retry(
        async () => {
          logger.info({ tokenId, side, price, size }, "Placing order");

          const sdkSide = side === "buy" ? Side.BUY : Side.SELL;
          const signedOrder = await this.getSdk().createOrder({
            tokenID: tokenId,
            price,
            size,
            side: sdkSide,
          });

          const resp = await this.getSdk().postOrder(signedOrder, OrderType.GTC);

          const orderId: string = resp?.orderID ?? resp?.id ?? `ord_${Date.now()}`;

          const order: Order = {
            id: orderId,
            tokenId,
            side,
            price,
            size,
            filledSize: 0,
            status: "open",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };

          logger.info({ orderId }, "Order placed successfully");
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

  /**
   * Place a GTC limit order (maker) — 0% fee on Polymarket.
   * Posts at a price below the best ask to sit on the book.
   * Returns null if the order can't be placed.
   */
  async placeLimitOrder(
    tokenId: string,
    side: "buy" | "sell",
    price: number,
    size: number
  ): Promise<Order> {
    await this.limiter.acquire(2);
    return this.authBreaker.execute(() =>
      retry(
        async () => {
          logger.info({ tokenId, side, price, size, type: "maker" }, "Placing limit (maker) order");

          const sdkSide = side === "buy" ? Side.BUY : Side.SELL;
          const signedOrder = await this.getSdk().createOrder({
            tokenID: tokenId,
            price,
            size,
            side: sdkSide,
          });

          // Post as GTC — sits on book = maker
          const resp = await this.getSdk().postOrder(signedOrder, OrderType.GTC);
          const orderId: string = resp?.orderID ?? resp?.id ?? `ord_${Date.now()}`;

          const order: Order = {
            id: orderId,
            tokenId,
            side,
            price,
            size,
            filledSize: 0,
            status: "open",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };

          logger.info({ orderId, type: "maker" }, "Limit order placed successfully");
          return order;
        },
        {
          maxAttempts: 2,
          initialDelayMs: 200,
          onRetry: (attempt, err) => {
            if (err.message.includes("429")) this.limiter.recordError(429);
            logger.warn({ tokenId, side, attempt, type: "maker" }, "Retrying placeLimitOrder");
          },
        }
      )
    );
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.limiter.acquire();
    await this.authBreaker.execute(() =>
      retry(
        async () => {
          logger.info({ orderId }, "Cancelling order");
          await this.getSdk().cancelOrder({ orderID: orderId });
        },
        { maxAttempts: 2, initialDelayMs: 100 }
      )
    );
  }

  async getOrderStatus(orderId: string): Promise<Order | null> {
    await this.limiter.acquire();
    return this.authBreaker.execute(() =>
      retry(
        async () => {
          try {
            const raw: PolyOpenOrder = await this.getSdk().getOrder(orderId);
            if (!raw) return null;

            const sizeMatched = parseFloat(raw.size_matched ?? "0");
            const originalSize = parseFloat(raw.original_size ?? "0");

            let status: Order["status"] = "open";
            if (raw.status === "matched" || (originalSize > 0 && sizeMatched >= originalSize)) {
              status = "filled";
            } else if (sizeMatched > 0) {
              status = "partial";
            } else if (raw.status === "cancelled") {
              status = "cancelled";
            }

            return {
              id: raw.id,
              tokenId: raw.asset_id,
              side: (raw.side ?? "BUY").toLowerCase() as "buy" | "sell",
              price: parseFloat(raw.price ?? "0"),
              size: originalSize,
              filledSize: sizeMatched,
              status,
              createdAt: raw.created_at ?? Date.now(),
              updatedAt: Date.now(),
            };
          } catch {
            return null;
          }
        },
        { maxAttempts: 2, initialDelayMs: 100 }
      )
    );
  }

  async cancelAllOpenOrders(): Promise<void> {
    logger.warn("Cancelling ALL open orders via API");
    try {
      await this.getSdk().cancelAll();
    } catch (err) {
      logger.error({ err: String(err) }, "cancelAll failed");
    }
  }

  /* ---- Balance ---- */

  /** Fetch available USDC collateral balance. */
  async getBalance(): Promise<number> {
    await this.limiter.acquire();
    return this.authBreaker.execute(() =>
      retry(
        async () => {
          const resp = await this.getSdk().getBalanceAllowance({
            asset_type: AssetType.COLLATERAL,
          });
          return parseFloat(resp.balance ?? "0");
        },
        { maxAttempts: 2, initialDelayMs: 100 }
      )
    );
  }

  getCircuitBreakerState(): "closed" | "open" | "half-open" {
    return this.bookBreaker.getState();
  }

  getAuthCircuitBreakerState(): "closed" | "open" | "half-open" {
    return this.authBreaker.getState();
  }

  getRateLimitRate(): number {
    return this.limiter.getRate();
  }

  /** Clean up keep-alive sockets on shutdown */
  destroy(): void {
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
  }
}
