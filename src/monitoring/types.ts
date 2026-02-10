/**
 * Dashboard types — shared between backend collectors and frontend rendering.
 */

/* ========== Bot State ========== */

export type BotState = "RUNNING" | "PAUSED" | "SAFE_MODE" | "HALTED";

export interface BotStatus {
  state: BotState;
  mode: "dry" | "paper" | "live";
  liveArmed: boolean;
  lastError: string | null;
  lastErrorAt: number | null;
  lastRecoveryAction: string | null;
  startedAt: number;
}

/* ========== Circuit Breaker ========== */

export interface CircuitBreakerStats {
  errorsPerMin: number;
  rateLimitsPerMin: number;       // 429s
  cancelsPerMin: number;
  consecutiveErrors: number;
  safeModeActive: boolean;
}

/* ========== Incidents ========== */

export type IncidentSeverity = "HIGH" | "MED" | "LOW";

export interface Incident {
  id: string;
  severity: IncidentSeverity;
  category: string;
  message: string;
  reason: string;
  timestamp: number;
  count: number;                  // dedup counter
}

/* ========== Risk & Exposure ========== */

export interface RiskSnapshot {
  totalExposureUsd: number;
  unhedgedExposureUsd: number;
  perMarketExposure: { market: string; exposureUsd: number; limitUsd: number; pct: number }[];
  openOrders: number;
  dailyPnl: number;
  drawdown: number;
  stopLossRemaining: number;
  balanceUsd: number;
  maxExposureUsd: number;
  dailyStopLossUsd: number;
}

/* ========== Execution Pipeline ========== */

export type TradeStage =
  | "detected"
  | "validated"
  | "risk_checked"
  | "leg_a_placed"
  | "leg_a_filled"
  | "leg_b_placed"
  | "leg_b_filled"
  | "hedge_triggered"
  | "cancelled"
  | "finalized";

export interface TradeEvent {
  stage: TradeStage;
  timestamp: number;
  durationMs: number | null;      // time since previous stage
  detail?: string;
}

export interface TradeLifecycle {
  tradeId: string;
  marketName: string;
  type: "binary_complement" | "multi_outcome";
  events: TradeEvent[];
  startedAt: number;
  finalizedAt: number | null;
  totalDurationMs: number | null;
  success: boolean | null;        // null = still in progress
  expectedProfitBps: number;
  realizedProfitBps: number | null;
  hedged: boolean;
  hedgeLoss: number;
}

/* ========== Opportunity Funnel ========== */

export interface FunnelSnapshot {
  period: "10m" | "1h";
  detected: number;
  passedFilters: number;
  passedRisk: number;
  ordersPlaced: number;
  fullyFilled: number;
  hedged: number;
  netProfitable: number;
  conversions: {
    filterRate: number;           // passedFilters / detected
    riskRate: number;
    fillRate: number;
    hedgeRate: number;
    profitRate: number;
  };
}

/* ========== Execution Quality ========== */

export interface ExecQualityMetrics {
  expectedVsRealizedProfit: { expected: number; realized: number }[];
  slippageBpsLegA: number[];
  slippageBpsLegB: number[];
  fillRatio: number;              // filled / placed
  avgTimeToFillA: number;
  avgTimeToFillB: number;
  timeToFillHistogramA: number[];
  timeToFillHistogramB: number[];
  hedgeFrequencyPct: number;
}

/* ========== Profit Attribution ========== */

export interface PnlDecomposition {
  period: "1h" | "24h" | "7d";
  grossEdge: number;
  fees: number;
  slippage: number;
  hedgeLosses: number;
  net: number;
}

/* ========== Market Health ========== */

export interface DataQualityMetrics {
  apiLatencyP50: number;
  apiLatencyP95: number;
  rateLimitHeadroom: number;      // 0-100%
  retriesCount: number;
  rateLimitHitsCount: number;     // 429s
  staleBooksPct: number;
  wsConnected: boolean;
  wsReconnectCount: number;
  wsDroppedUpdates: number;
}

/* ========== Per-Market Performance ========== */

export interface MarketPerformance {
  market: string;
  netPnl: number;
  fillSuccessRate: number;        // 0-1
  hedgeFrequency: number;         // 0-1
  avgSlippageBps: number;
  avgEdgeBps: number;
  tradesCount: number;
  disableCandidate: boolean;
}

/* ========== Market Book Data ========== */

export interface MarketGap {
  market: string;
  kind: "binary" | "multi";
  askYes: number | null;
  askNo: number | null;
  gap: number | null;
  bidYes: number | null;
  bidNo: number | null;
  spreadYes: number | null;
  spreadNo: number | null;
  yesAge: number | null;
  noAge: number | null;
  outcomes?: { label: string; ask: number | null; bid: number | null; spread: number | null; age: number | null }[];
}

/* ========== Scan State ========== */

export interface ScanSnapshot {
  cycle: number;
  freshBooks: number;
  totalTokenIds: number;
  opps: number;
  qualified: number;
  lastOpp: Record<string, unknown> | null;
  marketGaps: MarketGap[];
}

/* ========== Full Dashboard Payload ========== */

export interface DashboardPayload {
  timestamp: number;
  bot: BotStatus;
  circuitBreaker: CircuitBreakerStats;
  incidents: Incident[];
  risk: RiskSnapshot;
  scan: ScanSnapshot;
  markets: MarketGap[];
  funnel10m: FunnelSnapshot;
  funnel1h: FunnelSnapshot;
  execQuality: ExecQualityMetrics;
  pnl1h: PnlDecomposition;
  pnl24h: PnlDecomposition;
  pnl7d: PnlDecomposition;
  dataQuality: DataQualityMetrics;
  marketPerformance: MarketPerformance[];
  tradeTimeline: TradeLifecycle[];
  health: {
    uptime: number;
    uptimeHuman: string;
    lastLoopMs: number;
    loopsPerMinute: number;
    memoryMB: number;
    healthy: boolean;
  };
  metricsRaw: Record<string, unknown>;
}
