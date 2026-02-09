import pino from "pino";
import { ClobClient } from "../clob/client.js";
import { OrderBook } from "../clob/types.js";
import { OrderBookManager } from "../clob/books.js";
import { roundPriceDown } from "../exec/rounding.js";
import { RiskManager } from "../exec/risk.js";

const logger = pino({ name: "PositionMonitor" });

export interface TrackedPosition {
  tradeId: string;
  marketName: string;
  tokenId: string;
  entryPrice: number;
  size: number;
  enteredAt: number;
  highWaterMark: number;   // highest bid seen since entry
}

export interface PositionMonitorConfig {
  /** Maximum age of a position before auto-exit (ms). #14 */
  positionMaxAgeMs: number;
  /** Trailing stop: exit if bid drops this many bps below high-water mark. #14 */
  trailingStopBps: number;
  /** How often to check positions (ms). */
  checkIntervalMs: number;
}

export interface ExitResult {
  tradeId: string;
  tokenId: string;
  reason: "trailing_stop" | "max_age" | "manual";
  exitPrice: number;
  pnl: number;
}

/**
 * #14 — Position monitor: trailing stop + age-based exit.
 *
 * Watches open positions and triggers automated exits when:
 *  1. The bid price falls below the trailing stop threshold from the
 *     high-water mark (protective exit).
 *  2. The position has been open longer than positionMaxAgeMs (stale exit).
 */
export class PositionMonitor {
  private positions = new Map<string, TrackedPosition>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private exitCallback: ((result: ExitResult) => void) | null = null;

  constructor(
    private client: ClobClient,
    private bookMgr: OrderBookManager,
    private risk: RiskManager,
    private cfg: PositionMonitorConfig
  ) {}

  /* ---- lifecycle ---- */

  start(onExit: (result: ExitResult) => void): void {
    this.exitCallback = onExit;
    this.timer = setInterval(() => this.check(), this.cfg.checkIntervalMs);
    logger.info({ intervalMs: this.cfg.checkIntervalMs }, "Position monitor started");
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /* ---- tracking ---- */

  track(pos: Omit<TrackedPosition, "highWaterMark">): void {
    this.positions.set(pos.tradeId, {
      ...pos,
      highWaterMark: pos.entryPrice,
    });
    logger.info({ tradeId: pos.tradeId, tokenId: pos.tokenId }, "Tracking position");
  }

  untrack(tradeId: string): void {
    this.positions.delete(tradeId);
  }

  getTracked(): TrackedPosition[] {
    return [...this.positions.values()];
  }

  /* ---- check loop ---- */

  private async check(): Promise<void> {
    const now = Date.now();

    for (const [, pos] of this.positions) {
      const book = this.bookMgr.get(pos.tokenId);
      if (!book) continue;

      const currentBid = book.bestBidPrice;

      // Update high-water mark
      if (currentBid > pos.highWaterMark) {
        pos.highWaterMark = currentBid;
      }

      // Check trailing stop
      const dropBps = ((pos.highWaterMark - currentBid) / pos.highWaterMark) * 10_000;
      if (dropBps >= this.cfg.trailingStopBps && currentBid > 0) {
        await this.exit(pos, book, "trailing_stop");
        continue;
      }

      // Check max age
      if (now - pos.enteredAt >= this.cfg.positionMaxAgeMs) {
        await this.exit(pos, book, "max_age");
        continue;
      }
    }
  }

  private async exit(
    pos: TrackedPosition,
    book: OrderBook,
    reason: "trailing_stop" | "max_age"
  ): Promise<void> {
    const exitPrice = roundPriceDown(book.bestBidPrice);
    const pnl = (exitPrice - pos.entryPrice) * pos.size;

    logger.warn({
      tradeId: pos.tradeId,
      tokenId: pos.tokenId,
      reason,
      entryPrice: pos.entryPrice,
      exitPrice,
      highWaterMark: pos.highWaterMark,
      pnl,
    }, "Auto-exiting position");

    try {
      await this.client.placeOrder(pos.tokenId, "sell", exitPrice, pos.size);

      // Update risk state
      if (pnl < 0) this.risk.recordLoss(Math.abs(pnl));

      this.positions.delete(pos.tradeId);

      if (this.exitCallback) {
        this.exitCallback({ tradeId: pos.tradeId, tokenId: pos.tokenId, reason, exitPrice, pnl });
      }
    } catch (err) {
      logger.error({ tradeId: pos.tradeId, err: String(err) }, "Position exit failed");
    }
  }
}
