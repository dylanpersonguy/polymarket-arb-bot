import pino from "pino";
import Database from "better-sqlite3";
import { Opportunity } from "../arb/opportunity.js";
import { Order } from "../clob/types.js";

const logger = pino({ name: "Repositories" });

export class OpportunitiesRepository {
  constructor(private db: Database.Database) {}

  insert(opp: Opportunity): void {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO opportunities (id, market_name, type, expected_profit_usd, expected_profit_bps, snapshot, created_at, detected_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        `${opp.type}_${opp.detectedAt}`,
        opp.marketName,
        opp.type,
        opp.expectedProfit,
        opp.expectedProfitBps,
        JSON.stringify(opp),
        Date.now(),
        opp.detectedAt
      );
    } catch (error) {
      logger.error({ error, opportunity: opp }, "Failed to insert opportunity");
    }
  }

  getRecent(limitDays: number = 7): Opportunity[] {
    try {
      const stmt = this.db.prepare(`
        SELECT snapshot FROM opportunities 
        WHERE created_at > ? 
        ORDER BY created_at DESC 
        LIMIT 1000
      `);

      const cutoff = Date.now() - limitDays * 24 * 60 * 60 * 1000;
      const rows = stmt.all(cutoff) as Array<{ snapshot: string }>;

      return rows.map((r) => JSON.parse(r.snapshot) as Opportunity);
    } catch (error) {
      logger.error({ error }, "Failed to get recent opportunities");
      return [];
    }
  }
}

export class OrdersRepository {
  constructor(private db: Database.Database) {}

  insert(order: Order): void {
    try {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO orders (id, token_id, side, price, size, status, filled_size, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        order.id,
        order.tokenId,
        order.side,
        order.price,
        order.size,
        order.status,
        order.filledSize,
        order.createdAt,
        order.updatedAt
      );
    } catch (error) {
      logger.error({ error, order }, "Failed to insert order");
    }
  }

  updateStatus(orderId: string, status: string, filledSize?: number): void {
    try {
      const stmt = this.db.prepare(`
        UPDATE orders SET status = ?, updated_at = ? ${filledSize !== undefined ? ", filled_size = ?" : ""}
        WHERE id = ?
      `);

      const params = filledSize !== undefined ? [status, Date.now(), filledSize, orderId] : [status, Date.now(), orderId];
      stmt.run(...params);
    } catch (error) {
      logger.error({ error, orderId }, "Failed to update order status");
    }
  }

  getOpen(): Order[] {
    try {
      const stmt = this.db.prepare(`SELECT * FROM orders WHERE status = 'open'`);
      return stmt.all() as Order[];
    } catch (error) {
      logger.error({ error }, "Failed to get open orders");
      return [];
    }
  }
}

export class EventsRepository {
  constructor(private db: Database.Database) {}

  insert(level: string, message: string, context?: Record<string, unknown>): void {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO events (level, message, context, created_at)
        VALUES (?, ?, ?, ?)
      `);

      stmt.run(level, message, context ? JSON.stringify(context) : null, Date.now());
    } catch (error) {
      logger.error({ error }, "Failed to insert event");
    }
  }

  getRecent(limit: number = 100): Array<{ level: string; message: string; created_at: number }> {
    try {
      const stmt = this.db.prepare(`
        SELECT level, message, created_at FROM events 
        ORDER BY created_at DESC 
        LIMIT ?
      `);

      return stmt.all(limit) as Array<{ level: string; message: string; created_at: number }>;
    } catch (error) {
      logger.error({ error }, "Failed to get recent events");
      return [];
    }
  }
}
