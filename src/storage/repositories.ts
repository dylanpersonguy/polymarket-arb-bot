import Database from "better-sqlite3";
import { getDb } from "./db.js";

export interface TradeRow {
  id: string;
  market_name: string;
  type: string;
  legs: string;
  total_cost: number;
  expected_profit: number;
  expected_profit_bps: number;
  actual_profit: number | null;
  status: string;
  hedged: number;
  hedge_loss: number;
  created_at: string;
  updated_at: string;
}

export interface DailyStatsRow {
  date: string;
  trades_count: number;
  wins: number;
  losses: number;
  gross_pnl: number;
  fees_paid: number;
  net_pnl: number;
  max_drawdown: number;
}

export class TradeRepository {
  private db: Database.Database;
  private insertStmt: Database.Statement;
  private updateStatusStmt: Database.Statement;

  constructor(dbPath?: string) {
    this.db = getDb(dbPath);
    this.insertStmt = this.db.prepare(`
      INSERT INTO trades (id, market_name, type, legs, total_cost, expected_profit, expected_profit_bps, status)
      VALUES (@id, @market_name, @type, @legs, @total_cost, @expected_profit, @expected_profit_bps, @status)
    `);
    this.updateStatusStmt = this.db.prepare(`
      UPDATE trades SET status = @status, actual_profit = @actual_profit, hedged = @hedged,
        hedge_loss = @hedge_loss, updated_at = datetime('now')
      WHERE id = @id
    `);
  }

  insert(trade: {
    id: string;
    marketName: string;
    type: string;
    legs: object[];
    totalCost: number;
    expectedProfit: number;
    expectedProfitBps: number;
  }): void {
    this.insertStmt.run({
      id: trade.id,
      market_name: trade.marketName,
      type: trade.type,
      legs: JSON.stringify(trade.legs),
      total_cost: trade.totalCost,
      expected_profit: trade.expectedProfit,
      expected_profit_bps: trade.expectedProfitBps,
      status: "pending",
    });
  }

  updateStatus(
    id: string,
    status: string,
    actualProfit: number | null = null,
    hedged = false,
    hedgeLoss = 0
  ): void {
    this.updateStatusStmt.run({
      id,
      status,
      actual_profit: actualProfit,
      hedged: hedged ? 1 : 0,
      hedge_loss: hedgeLoss,
    });
  }

  getRecent(limit = 50): TradeRow[] {
    return this.db
      .prepare("SELECT * FROM trades ORDER BY created_at DESC LIMIT ?")
      .all(limit) as TradeRow[];
  }

  getByStatus(status: string): TradeRow[] {
    return this.db
      .prepare("SELECT * FROM trades WHERE status = ?")
      .all(status) as TradeRow[];
  }

  countToday(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as cnt FROM trades WHERE date(created_at) = date('now')")
      .get() as { cnt: number };
    return row.cnt;
  }
}

export class DailyStatsRepository {
  private db: Database.Database;

  constructor(dbPath?: string) {
    this.db = getDb(dbPath);
  }

  upsert(stats: DailyStatsRow): void {
    this.db
      .prepare(
        `INSERT INTO daily_stats (date, trades_count, wins, losses, gross_pnl, fees_paid, net_pnl, max_drawdown)
         VALUES (@date, @trades_count, @wins, @losses, @gross_pnl, @fees_paid, @net_pnl, @max_drawdown)
         ON CONFLICT(date) DO UPDATE SET
           trades_count = @trades_count, wins = @wins, losses = @losses,
           gross_pnl = @gross_pnl, fees_paid = @fees_paid, net_pnl = @net_pnl, max_drawdown = @max_drawdown`
      )
      .run(stats);
  }

  getToday(): DailyStatsRow | null {
    const today = new Date().toISOString().slice(0, 10);
    return (this.db.prepare("SELECT * FROM daily_stats WHERE date = ?").get(today) as DailyStatsRow) ?? null;
  }

  getRange(from: string, to: string): DailyStatsRow[] {
    return this.db
      .prepare("SELECT * FROM daily_stats WHERE date BETWEEN ? AND ? ORDER BY date")
      .all(from, to) as DailyStatsRow[];
  }
}

export class ConfigSnapshotRepository {
  private db: Database.Database;

  constructor(dbPath?: string) {
    this.db = getDb(dbPath);
  }

  save(config: object): void {
    this.db
      .prepare("INSERT INTO config_snapshots (config) VALUES (?)")
      .run(JSON.stringify(config));
  }
}
