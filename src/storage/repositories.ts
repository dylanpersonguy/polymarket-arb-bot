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

/* ================================================================
   Scanner Results Repository — persists market scanner discoveries
   ================================================================ */

export interface ScannerResultRow {
  id: number;
  market_name: string;
  market_type: string;
  score: number;
  gap_pct: number | null;
  liquidity: number | null;
  outcomes: number;
  token_ids: string;
  condition_id: string | null;
  created_at: string;
}

export class ScannerResultRepository {
  private db: Database.Database;
  private insertStmt: Database.Statement;

  constructor(dbPath?: string) {
    this.db = getDb(dbPath);
    this.insertStmt = this.db.prepare(`
      INSERT INTO scanner_results (market_name, market_type, score, gap_pct, liquidity, outcomes, token_ids, condition_id)
      VALUES (@market_name, @market_type, @score, @gap_pct, @liquidity, @outcomes, @token_ids, @condition_id)
    `);
  }

  insert(result: {
    marketName: string;
    marketType: "binary" | "negRisk";
    score: number;
    gapPct: number | null;
    liquidity: number | null;
    outcomes: number;
    tokenIds: string[];
    conditionId: string | null;
  }): void {
    this.insertStmt.run({
      market_name: result.marketName,
      market_type: result.marketType,
      score: result.score,
      gap_pct: result.gapPct,
      liquidity: result.liquidity,
      outcomes: result.outcomes,
      token_ids: JSON.stringify(result.tokenIds),
      condition_id: result.conditionId,
    });
  }

  insertBatch(results: Parameters<ScannerResultRepository["insert"]>[0][]): void {
    const tx = this.db.transaction(() => {
      for (const r of results) this.insert(r);
    });
    tx();
  }

  getRecent(limit = 100): ScannerResultRow[] {
    return this.db
      .prepare("SELECT * FROM scanner_results ORDER BY created_at DESC LIMIT ?")
      .all(limit) as ScannerResultRow[];
  }

  /** Get unique markets found in the last N hours */
  getUniqueMarketsSince(hoursAgo = 24): number {
    const row = this.db
      .prepare("SELECT COUNT(DISTINCT market_name) as cnt FROM scanner_results WHERE created_at >= datetime('now', ?)")
      .get(`-${hoursAgo} hours`) as { cnt: number };
    return row.cnt;
  }

  /** Get top-scoring markets */
  getTopMarkets(limit = 20): ScannerResultRow[] {
    return this.db
      .prepare("SELECT * FROM scanner_results WHERE created_at >= datetime('now', '-24 hours') ORDER BY score DESC LIMIT ?")
      .all(limit) as ScannerResultRow[];
  }
}

/* ================================================================
   Latency Repository — per-endpoint latency tracking
   ================================================================ */

export interface LatencySampleRow {
  id: number;
  endpoint: string;
  latency_ms: number;
  status: number;
  created_at: string;
}

export class LatencyRepository {
  private db: Database.Database;
  private insertStmt: Database.Statement;

  constructor(dbPath?: string) {
    this.db = getDb(dbPath);
    this.insertStmt = this.db.prepare(`
      INSERT INTO latency_samples (endpoint, latency_ms, status) VALUES (@endpoint, @latency_ms, @status)
    `);
  }

  record(endpoint: string, latencyMs: number, status = 200): void {
    this.insertStmt.run({ endpoint, latency_ms: latencyMs, status });
  }

  /** Get percentiles for an endpoint over last N minutes */
  getPercentiles(endpoint: string, minutesAgo = 60): { p50: number; p75: number; p95: number; p99: number; count: number } {
    const rows = this.db
      .prepare("SELECT latency_ms FROM latency_samples WHERE endpoint = ? AND created_at >= datetime('now', ?) ORDER BY latency_ms")
      .all(endpoint, `-${minutesAgo} minutes`) as { latency_ms: number }[];

    if (rows.length === 0) return { p50: 0, p75: 0, p95: 0, p99: 0, count: 0 };

    const pct = (p: number) => rows[Math.min(Math.ceil((p / 100) * rows.length) - 1, rows.length - 1)].latency_ms;

    return {
      p50: pct(50),
      p75: pct(75),
      p95: pct(95),
      p99: pct(99),
      count: rows.length,
    };
  }

  /** Get all endpoints with their avg latency */
  getAllEndpoints(minutesAgo = 60): { endpoint: string; avgMs: number; count: number }[] {
    return this.db
      .prepare(`
        SELECT endpoint, AVG(latency_ms) as avgMs, COUNT(*) as count
        FROM latency_samples
        WHERE created_at >= datetime('now', ?)
        GROUP BY endpoint
        ORDER BY avgMs DESC
      `)
      .all(`-${minutesAgo} minutes`) as { endpoint: string; avgMs: number; count: number }[];
  }

  /** Prune old entries to prevent unbounded growth */
  prune(keepHours = 48): void {
    this.db
      .prepare("DELETE FROM latency_samples WHERE created_at < datetime('now', ?)")
      .run(`-${keepHours} hours`);
  }
}
