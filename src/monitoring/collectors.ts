/**
 * Dashboard data collectors — incident tracking, funnel metrics,
 * trade timeline, per-market performance, circuit breaker stats.
 *
 * All collectors are in-memory ring buffers designed for sub-second dashboard updates.
 */
import type {
  Incident,
  IncidentSeverity,
  FunnelSnapshot,
  TradeLifecycle,
  TradeStage,
  MarketPerformance,
  CircuitBreakerStats,
  PnlDecomposition,
  ExecQualityMetrics,
  DataQualityMetrics,
} from "./types.js";

/* ================================================================
   Incident Tracker — deduped, cooldown-based
   ================================================================ */

export class IncidentTracker {
  private incidents: Incident[] = [];
  private readonly maxIncidents = 200;
  private readonly dedupWindowMs = 30_000;
  private counter = 0;

  add(severity: IncidentSeverity, category: string, message: string, reason: string = ""): void {
    // Dedup: if same category + message within window, increment count
    const now = Date.now();
    const existing = this.incidents.find(
      (i) => i.category === category && i.message === message && now - i.timestamp < this.dedupWindowMs,
    );
    if (existing) {
      existing.count++;
      existing.timestamp = now;
      return;
    }

    this.incidents.unshift({
      id: `inc_${++this.counter}`,
      severity,
      category,
      message,
      reason,
      timestamp: now,
      count: 1,
    });

    if (this.incidents.length > this.maxIncidents) {
      this.incidents.length = this.maxIncidents;
    }
  }

  recent(n = 50): Incident[] {
    return this.incidents.slice(0, n);
  }
}

/* ================================================================
   Funnel Tracker — tracks opportunity conversion pipeline
   ================================================================ */

interface FunnelEvent {
  timestamp: number;
  stage: "detected" | "passed_filters" | "passed_risk" | "orders_placed" | "fully_filled" | "hedged" | "net_profitable";
}

export class FunnelTracker {
  private events: FunnelEvent[] = [];
  private readonly maxEvents = 10_000;

  record(stage: FunnelEvent["stage"]): void {
    this.events.push({ timestamp: Date.now(), stage });
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
  }

  snapshot(periodMs: number): FunnelSnapshot {
    const cutoff = Date.now() - periodMs;
    const recent = this.events.filter((e) => e.timestamp >= cutoff);

    const detected = recent.filter((e) => e.stage === "detected").length;
    const passedFilters = recent.filter((e) => e.stage === "passed_filters").length;
    const passedRisk = recent.filter((e) => e.stage === "passed_risk").length;
    const ordersPlaced = recent.filter((e) => e.stage === "orders_placed").length;
    const fullyFilled = recent.filter((e) => e.stage === "fully_filled").length;
    const hedged = recent.filter((e) => e.stage === "hedged").length;
    const netProfitable = recent.filter((e) => e.stage === "net_profitable").length;

    return {
      period: periodMs <= 600_000 ? "10m" : "1h",
      detected,
      passedFilters,
      passedRisk,
      ordersPlaced,
      fullyFilled,
      hedged,
      netProfitable,
      conversions: {
        filterRate: detected > 0 ? passedFilters / detected : 0,
        riskRate: passedFilters > 0 ? passedRisk / passedFilters : 0,
        fillRate: ordersPlaced > 0 ? fullyFilled / ordersPlaced : 0,
        hedgeRate: fullyFilled > 0 ? hedged / fullyFilled : 0,
        profitRate: fullyFilled > 0 ? netProfitable / fullyFilled : 0,
      },
    };
  }
}

/* ================================================================
   Trade Timeline — per-trade lifecycle tracking
   ================================================================ */

export class TradeTimeline {
  private trades = new Map<string, TradeLifecycle>();
  private finalized: TradeLifecycle[] = [];
  private readonly maxFinalized = 100;

  start(tradeId: string, marketName: string, type: TradeLifecycle["type"], expectedProfitBps: number): void {
    const now = Date.now();
    this.trades.set(tradeId, {
      tradeId,
      marketName,
      type,
      events: [{ stage: "detected", timestamp: now, durationMs: null }],
      startedAt: now,
      finalizedAt: null,
      totalDurationMs: null,
      success: null,
      expectedProfitBps,
      realizedProfitBps: null,
      hedged: false,
      hedgeLoss: 0,
    });
  }

  addEvent(tradeId: string, stage: TradeStage, detail?: string): void {
    const trade = this.trades.get(tradeId);
    if (!trade) return;

    const now = Date.now();
    const prev = trade.events[trade.events.length - 1];
    const durationMs = prev ? now - prev.timestamp : null;

    trade.events.push({ stage, timestamp: now, durationMs, detail });
  }

  finalize(tradeId: string, success: boolean, realizedProfitBps?: number, hedged?: boolean, hedgeLoss?: number): void {
    const trade = this.trades.get(tradeId);
    if (!trade) return;

    const now = Date.now();
    trade.finalizedAt = now;
    trade.totalDurationMs = now - trade.startedAt;
    trade.success = success;
    if (realizedProfitBps !== undefined) trade.realizedProfitBps = realizedProfitBps;
    if (hedged !== undefined) trade.hedged = hedged;
    if (hedgeLoss !== undefined) trade.hedgeLoss = hedgeLoss;

    trade.events.push({ stage: "finalized", timestamp: now, durationMs: now - (trade.events.at(-1)?.timestamp ?? now) });

    this.trades.delete(tradeId);
    this.finalized.unshift(trade);
    if (this.finalized.length > this.maxFinalized) {
      this.finalized.length = this.maxFinalized;
    }
  }

  /** Get recent trades — both in-progress and finalized. */
  recent(n = 20): TradeLifecycle[] {
    const inProgress = [...this.trades.values()];
    return [...inProgress, ...this.finalized].slice(0, n);
  }
}

/* ================================================================
   Per-Market Performance Tracker
   ================================================================ */

interface MarketRecord {
  market: string;
  pnl: number;
  trades: number;
  fills: number;
  hedges: number;
  slippageBpsSum: number;
  edgeBpsSum: number;
}

export class MarketPerfTracker {
  private records = new Map<string, MarketRecord>();

  private ensure(market: string): MarketRecord {
    let r = this.records.get(market);
    if (!r) {
      r = { market, pnl: 0, trades: 0, fills: 0, hedges: 0, slippageBpsSum: 0, edgeBpsSum: 0 };
      this.records.set(market, r);
    }
    return r;
  }

  recordTrade(market: string, pnl: number, filled: boolean, hedged: boolean, slippageBps: number, edgeBps: number): void {
    const r = this.ensure(market);
    r.trades++;
    r.pnl += pnl;
    if (filled) r.fills++;
    if (hedged) r.hedges++;
    r.slippageBpsSum += slippageBps;
    r.edgeBpsSum += edgeBps;
  }

  snapshot(): MarketPerformance[] {
    const results: MarketPerformance[] = [];
    for (const r of this.records.values()) {
      const avgSlippage = r.trades > 0 ? r.slippageBpsSum / r.trades : 0;
      const avgEdge = r.trades > 0 ? r.edgeBpsSum / r.trades : 0;
      const fillRate = r.trades > 0 ? r.fills / r.trades : 0;
      const hedgeFreq = r.trades > 0 ? r.hedges / r.trades : 0;
      results.push({
        market: r.market,
        netPnl: +r.pnl.toFixed(4),
        fillSuccessRate: +fillRate.toFixed(3),
        hedgeFrequency: +hedgeFreq.toFixed(3),
        avgSlippageBps: +avgSlippage.toFixed(1),
        avgEdgeBps: +avgEdge.toFixed(1),
        tradesCount: r.trades,
        disableCandidate: fillRate < 0.3 || hedgeFreq > 0.5 || avgSlippage > 50,
      });
    }
    return results.sort((a, b) => b.netPnl - a.netPnl);
  }
}

/* ================================================================
   Circuit Breaker Stats — rolling per-minute counters
   ================================================================ */

export class CircuitBreakerTracker {
  private errorsWindow: number[] = [];
  private rateLimitsWindow: number[] = [];
  private cancelsWindow: number[] = [];
  private readonly windowMs = 60_000;

  recordError(): void { this.errorsWindow.push(Date.now()); }
  recordRateLimit(): void { this.rateLimitsWindow.push(Date.now()); }
  recordCancel(): void { this.cancelsWindow.push(Date.now()); }

  private prune(arr: number[]): number[] {
    const cutoff = Date.now() - this.windowMs;
    return arr.filter((t) => t >= cutoff);
  }

  snapshot(consecutiveErrors: number, safeModeActive: boolean): CircuitBreakerStats {
    this.errorsWindow = this.prune(this.errorsWindow);
    this.rateLimitsWindow = this.prune(this.rateLimitsWindow);
    this.cancelsWindow = this.prune(this.cancelsWindow);
    return {
      errorsPerMin: this.errorsWindow.length,
      rateLimitsPerMin: this.rateLimitsWindow.length,
      cancelsPerMin: this.cancelsWindow.length,
      consecutiveErrors,
      safeModeActive,
    };
  }
}

/* ================================================================
   PnL Attribution Tracker
   ================================================================ */

interface PnlEvent {
  timestamp: number;
  grossEdge: number;
  fees: number;
  slippage: number;
  hedgeLoss: number;
  marketType: "binary" | "multi" | "cross_event";
}

export class PnlTracker {
  private events: PnlEvent[] = [];
  private readonly maxEvents = 50_000;

  record(grossEdge: number, fees: number, slippage: number, hedgeLoss: number, marketType: "binary" | "multi" | "cross_event" = "binary"): void {
    this.events.push({ timestamp: Date.now(), grossEdge, fees, slippage, hedgeLoss, marketType });
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
  }

  snapshot(periodMs: number): PnlDecomposition {
    const cutoff = Date.now() - periodMs;
    const recent = this.events.filter((e) => e.timestamp >= cutoff);

    const grossEdge = recent.reduce((s, e) => s + e.grossEdge, 0);
    const fees = recent.reduce((s, e) => s + e.fees, 0);
    const slippage = recent.reduce((s, e) => s + e.slippage, 0);
    const hedgeLosses = recent.reduce((s, e) => s + e.hedgeLoss, 0);

    let period: "1h" | "24h" | "7d" = "1h";
    if (periodMs > 3_600_000 * 24) period = "7d";
    else if (periodMs > 3_600_000) period = "24h";

    return {
      period,
      grossEdge: +grossEdge.toFixed(4),
      fees: +fees.toFixed(4),
      slippage: +slippage.toFixed(4),
      hedgeLosses: +hedgeLosses.toFixed(4),
      net: +(grossEdge - fees - slippage - hedgeLosses).toFixed(4),
    };
  }

  /** Get PnL broken down by market type */
  snapshotByType(periodMs: number): Record<string, PnlDecomposition> {
    const cutoff = Date.now() - periodMs;
    const recent = this.events.filter((e) => e.timestamp >= cutoff);
    const types: ("binary" | "multi" | "cross_event")[] = ["binary", "multi", "cross_event"];
    const result: Record<string, PnlDecomposition> = {};

    let period: "1h" | "24h" | "7d" = "1h";
    if (periodMs > 3_600_000 * 24) period = "7d";
    else if (periodMs > 3_600_000) period = "24h";

    for (const t of types) {
      const filtered = recent.filter(e => e.marketType === t);
      const grossEdge = filtered.reduce((s, e) => s + e.grossEdge, 0);
      const fees = filtered.reduce((s, e) => s + e.fees, 0);
      const slippage = filtered.reduce((s, e) => s + e.slippage, 0);
      const hedgeLosses = filtered.reduce((s, e) => s + e.hedgeLoss, 0);
      result[t] = {
        period,
        grossEdge: +grossEdge.toFixed(4),
        fees: +fees.toFixed(4),
        slippage: +slippage.toFixed(4),
        hedgeLosses: +hedgeLosses.toFixed(4),
        net: +(grossEdge - fees - slippage - hedgeLosses).toFixed(4),
      };
    }
    return result;
  }
}

/* ================================================================
   Execution Quality Tracker
   ================================================================ */

interface ExecSample {
  timestamp: number;
  expectedBps: number;
  realizedBps: number;
  slippageBpsA: number;
  slippageBpsB: number;
  fillTimeA: number;
  fillTimeB: number;
  hedged: boolean;
}

export class ExecQualityTracker {
  private samples: ExecSample[] = [];
  private totalPlaced = 0;
  private totalFilled = 0;
  private readonly maxSamples = 500;

  recordPlaced(n = 1): void { this.totalPlaced += n; }
  recordFilled(n = 1): void { this.totalFilled += n; }

  record(sample: ExecSample): void {
    this.samples.push(sample);
    if (this.samples.length > this.maxSamples) this.samples.shift();
  }

  snapshot(): ExecQualityMetrics {
    const s = this.samples;
    const hedged = s.filter((x) => x.hedged).length;

    return {
      expectedVsRealizedProfit: s.slice(-30).map((x) => ({ expected: x.expectedBps, realized: x.realizedBps })),
      slippageBpsLegA: s.slice(-30).map((x) => x.slippageBpsA),
      slippageBpsLegB: s.slice(-30).map((x) => x.slippageBpsB),
      fillRatio: this.totalPlaced > 0 ? +(this.totalFilled / this.totalPlaced).toFixed(3) : 0,
      avgTimeToFillA: s.length > 0 ? +(s.reduce((a, x) => a + x.fillTimeA, 0) / s.length).toFixed(0) : 0,
      avgTimeToFillB: s.length > 0 ? +(s.reduce((a, x) => a + x.fillTimeB, 0) / s.length).toFixed(0) : 0,
      timeToFillHistogramA: s.slice(-50).map((x) => x.fillTimeA),
      timeToFillHistogramB: s.slice(-50).map((x) => x.fillTimeB),
      hedgeFrequencyPct: s.length > 0 ? +((hedged / s.length) * 100).toFixed(1) : 0,
    };
  }
}

/* ================================================================
   Data Quality Tracker
   ================================================================ */

export class DataQualityTracker {
  private latencies: number[] = [];
  private readonly maxLatencies = 200;
  private retries = 0;
  private rateLimitHits = 0;
  private wsReconnects = 0;
  private wsDropped = 0;
  private _wsConnected = false;

  /** Per-endpoint latency tracking */
  private endpointLatencies = new Map<string, number[]>();
  private readonly maxEndpointSamples = 100;

  recordLatency(ms: number, endpoint = "getOrderBook"): void {
    this.latencies.push(ms);
    if (this.latencies.length > this.maxLatencies) this.latencies.shift();

    // Per-endpoint tracking
    let arr = this.endpointLatencies.get(endpoint);
    if (!arr) { arr = []; this.endpointLatencies.set(endpoint, arr); }
    arr.push(ms);
    if (arr.length > this.maxEndpointSamples) arr.shift();
  }

  recordRetry(): void { this.retries++; }
  recordRateLimit(): void { this.rateLimitHits++; }
  recordWsReconnect(): void { this.wsReconnects++; }
  recordWsDropped(): void { this.wsDropped++; }
  setWsConnected(v: boolean): void { this._wsConnected = v; }

  private percentile(arr: number[], p: number): number {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.min(Math.ceil((p / 100) * sorted.length) - 1, sorted.length - 1);
    return sorted[Math.max(0, idx)];
  }

  snapshot(staleBooksPct: number, rateLimitCapacity: number): DataQualityMetrics {
    return {
      apiLatencyP50: +this.percentile(this.latencies, 50).toFixed(0),
      apiLatencyP95: +this.percentile(this.latencies, 95).toFixed(0),
      rateLimitHeadroom: +rateLimitCapacity.toFixed(0),
      retriesCount: this.retries,
      rateLimitHitsCount: this.rateLimitHits,
      staleBooksPct: +staleBooksPct.toFixed(1),
      wsConnected: this._wsConnected,
      wsReconnectCount: this.wsReconnects,
      wsDroppedUpdates: this.wsDropped,
    };
  }

  /** Get per-endpoint latency breakdown */
  endpointSnapshot(): { endpoint: string; p50: number; p95: number; count: number }[] {
    const results: { endpoint: string; p50: number; p95: number; count: number }[] = [];
    for (const [endpoint, latencies] of this.endpointLatencies) {
      results.push({
        endpoint,
        p50: +this.percentile(latencies, 50).toFixed(0),
        p95: +this.percentile(latencies, 95).toFixed(0),
        count: latencies.length,
      });
    }
    return results.sort((a, b) => b.p95 - a.p95);
  }
}
