import pino from "pino";
import { OrderBook, OrderBookLevel } from "./types.js";
import { EventEmitter } from "events";

const logger = pino({ name: "WsManager" });

export interface WsManagerConfig {
  wsUrl: string;
  reconnectIntervalMs: number;
  tokenIds: string[];
}

/**
 * #7 — WebSocket manager for live order book updates.
 *
 * Maintains a persistent WebSocket connection to the Polymarket CLOB and
 * emits "book" events whenever a book snapshot or delta arrives.
 *
 * This is a skeleton — the real implementation depends on the specific
 * Polymarket WebSocket API contract.  The structure is ready to plug in.
 */
export class WsManager extends EventEmitter {
  private ws: WebSocket | null = null;
  private books = new Map<string, OrderBook>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(private cfg: WsManagerConfig) {
    super();
  }

  /* ---- lifecycle ---- */

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
    logger.info({ url: this.cfg.wsUrl, tokens: this.cfg.tokenIds.length }, "WsManager started");
  }

  stop(): void {
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    logger.info("WsManager stopped");
  }

  getBook(tokenId: string): OrderBook | null {
    return this.books.get(tokenId) ?? null;
  }

  getAllBooks(): Map<string, OrderBook> {
    return new Map(this.books);
  }

  /* ---- connection ---- */

  private connect(): void {
    try {
      this.ws = new WebSocket(this.cfg.wsUrl);

      this.ws.onopen = () => {
        logger.info("WebSocket connected");
        this.subscribe();
      };

      this.ws.onmessage = (event: MessageEvent) => {
        try {
          const data = JSON.parse(String(event.data));
          this.handleMessage(data);
        } catch (err) {
          logger.debug({ err: String(err) }, "Failed to parse WS message");
        }
      };

      this.ws.onerror = (err: Event) => {
        logger.error({ err: String(err) }, "WebSocket error");
      };

      this.ws.onclose = () => {
        logger.warn("WebSocket disconnected");
        this.scheduleReconnect();
      };
    } catch (err) {
      logger.error({ err: String(err) }, "WebSocket connection failed");
      this.scheduleReconnect();
    }
  }

  private subscribe(): void {
    if (!this.ws) return;

    // TODO: Replace with actual Polymarket WS subscription format
    const msg = JSON.stringify({
      type: "subscribe",
      channels: this.cfg.tokenIds.map((id) => ({
        name: "book",
        asset_id: id,
      })),
    });

    this.ws.send(msg);
    logger.info({ tokenCount: this.cfg.tokenIds.length }, "Subscribed to book channels");
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    this.reconnectTimer = setTimeout(() => {
      logger.info("Attempting WebSocket reconnect…");
      this.connect();
    }, this.cfg.reconnectIntervalMs);
  }

  /* ---- message handling ---- */

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleMessage(data: any): void {
    // TODO: Adapt to actual Polymarket WS payload format.
    // Expected shape (example):
    //   { type: "book", asset_id: "...", bids: [...], asks: [...] }
    if (!data || !data.asset_id) return;

    const tokenId: string = data.asset_id;
    if (!this.cfg.tokenIds.includes(tokenId)) return;

    const bids: OrderBookLevel[] = (data.bids ?? []).map((l: { price: string; size: string }) => ({
      price: parseFloat(l.price),
      size: parseFloat(l.size),
    }));
    const asks: OrderBookLevel[] = (data.asks ?? []).map((l: { price: string; size: string }) => ({
      price: parseFloat(l.price),
      size: parseFloat(l.size),
    }));

    // Sort: bids descending, asks ascending
    bids.sort((a, b) => b.price - a.price);
    asks.sort((a, b) => a.price - b.price);

    const book: OrderBook = {
      tokenId,
      bestBidPrice: bids[0]?.price ?? 0,
      bestBidSize: bids[0]?.size ?? 0,
      bestAskPrice: asks[0]?.price ?? Infinity,
      bestAskSize: asks[0]?.size ?? 0,
      bids,
      asks,
      lastUpdatedMs: Date.now(),
    };

    this.books.set(tokenId, book);
    this.emit("book", tokenId, book);
  }
}
