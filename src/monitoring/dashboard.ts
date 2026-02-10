/**
 * Professional Ops Console Dashboard — embedded HTTP server.
 *
 * Endpoints:
 *   GET /           → Full SPA dashboard
 *   GET /api/status → Complete JSON payload
 */
import http from "node:http";
import pino from "pino";
import type { Metrics } from "./metrics.js";
import type { HealthMonitor } from "./health.js";
import type { OrderBookManager } from "../clob/books.js";
import type { RiskManager } from "../exec/risk.js";
import type { PositionManager } from "../clob/positions.js";
import type { OrderManager } from "../clob/orders.js";
import type { PositionMonitor } from "../exec/positionMonitor.js";
import type { Market, MarketBinary, MarketMulti } from "../config/schema.js";
import type {
  IncidentTracker,
  FunnelTracker,
  TradeTimeline,
  MarketPerfTracker,
  CircuitBreakerTracker,
  PnlTracker,
  ExecQualityTracker,
  DataQualityTracker,
} from "./collectors.js";
import type {
  DashboardPayload,
  ScanSnapshot,
  BotStatus,
  MarketGap,
} from "./types.js";

export type { ScanSnapshot };

const logger = pino({ name: "Dashboard" });

export interface DashboardDeps {
  metrics: Metrics;
  health: HealthMonitor;
  bookMgr: OrderBookManager;
  riskMgr: RiskManager;
  positionMgr: PositionManager;
  orderMgr: OrderManager;
  posMonitor: PositionMonitor;
  markets: () => Market[];
  mode: string;
  enableLiveTrading: boolean;
  scanState: () => ScanSnapshot;
  botStatus: () => BotStatus;
  // collectors
  incidents: IncidentTracker;
  funnel: FunnelTracker;
  timeline: TradeTimeline;
  marketPerf: MarketPerfTracker;
  cbTracker: CircuitBreakerTracker;
  pnlTracker: PnlTracker;
  execQuality: ExecQualityTracker;
  dataQuality: DataQualityTracker;
}

export function startDashboard(port: number, deps: DashboardDeps): http.Server {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    if (url.pathname === "/api/status") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(JSON.stringify(buildPayload(deps)));
      return;
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(DASHBOARD_HTML);
  });

  server.listen(port, "127.0.0.1", () => {
    logger.info({ port, url: `http://localhost:${port}` }, "Dashboard started");
  });

  return server;
}

/* ---- Build full payload ---- */

function buildPayload(d: DashboardDeps): DashboardPayload {
  const snap = d.scanState();
  const bot = d.botStatus();
  const healthStatus = d.health.status({ booksOk: snap.freshBooks > 0 });
  const metricsSnap = d.metrics.snapshot();
  const riskState = d.riskMgr.getState();

  // Build market data
  const markets = d.markets();
  const marketGaps: MarketGap[] = [];

  for (const m of markets) {
    if (m.kind === "binary") {
      const mb = m as MarketBinary;
      const yb = d.bookMgr.get(mb.yesTokenId);
      const nb = d.bookMgr.get(mb.noTokenId);
      const ayp = yb && isFinite(yb.bestAskPrice) ? yb.bestAskPrice : null;
      const anp = nb && isFinite(nb.bestAskPrice) ? nb.bestAskPrice : null;
      const byp = yb && isFinite(yb.bestBidPrice) ? yb.bestBidPrice : null;
      const bnp = nb && isFinite(nb.bestBidPrice) ? nb.bestBidPrice : null;
      marketGaps.push({
        market: mb.name,
        kind: "binary",
        askYes: ayp,
        askNo: anp,
        bidYes: byp,
        bidNo: bnp,
        gap: ayp !== null && anp !== null ? +((ayp + anp - 1) * 100).toFixed(3) : null,
        spreadYes: ayp !== null && byp !== null ? +((ayp - byp) * 100).toFixed(2) : null,
        spreadNo: anp !== null && bnp !== null ? +((anp - bnp) * 100).toFixed(2) : null,
        yesAge: yb ? Date.now() - yb.lastUpdatedMs : null,
        noAge: nb ? Date.now() - nb.lastUpdatedMs : null,
      });
    } else {
      const mm = m as MarketMulti;
      const outcomes: NonNullable<MarketGap["outcomes"]> = [];
      let sumAsks = 0;
      let allFresh = true;
      for (const o of mm.outcomes) {
        const b = d.bookMgr.get(o.tokenId);
        if (b && isFinite(b.bestAskPrice)) {
          const bid = isFinite(b.bestBidPrice) ? b.bestBidPrice : null;
          sumAsks += b.bestAskPrice;
          outcomes.push({
            label: o.label,
            ask: b.bestAskPrice,
            bid,
            spread: bid !== null ? +((b.bestAskPrice - bid) * 100).toFixed(2) : null,
            age: Date.now() - b.lastUpdatedMs,
          });
        } else {
          allFresh = false;
          outcomes.push({ label: o.label, ask: null, bid: null, spread: null, age: null });
        }
      }
      marketGaps.push({
        market: mm.name,
        kind: "multi",
        askYes: null, askNo: null, bidYes: null, bidNo: null,
        gap: allFresh ? +((sumAsks - 1) * 100).toFixed(3) : null,
        spreadYes: null, spreadNo: null,
        yesAge: null, noAge: null,
        outcomes,
      });
    }
  }

  const totalTokenIds = snap.totalTokenIds || 1;
  const staleBooksPct = ((totalTokenIds - snap.freshBooks) / totalTokenIds) * 100;

  const perMarketExposure = [...riskState.perMarketExposureUsd.entries()].map(([market, exp]) => ({
    market,
    exposureUsd: +exp.toFixed(2),
    limitUsd: (d.riskMgr as any).cfg.perMarketMaxUsd ?? 150,
    pct: +(exp / ((d.riskMgr as any).cfg.perMarketMaxUsd ?? 150) * 100).toFixed(1),
  }));

  return {
    timestamp: Date.now(),
    bot,
    circuitBreaker: d.cbTracker.snapshot(riskState.consecutiveErrors, riskState.safeModeActive),
    incidents: d.incidents.recent(30),
    risk: {
      totalExposureUsd: +riskState.globalExposureUsd.toFixed(2),
      unhedgedExposureUsd: +(d.posMonitor.getTracked().reduce((s, p) => s + p.entryPrice * p.size, 0)).toFixed(2),
      perMarketExposure,
      openOrders: riskState.openOrderCount,
      dailyPnl: +((metricsSnap["gauge.paper_pnl"] as number) ?? 0).toFixed(2),
      drawdown: +((metricsSnap["gauge.drawdown"] as number) ?? 0).toFixed(2),
      stopLossRemaining: +((d.riskMgr as any).cfg.dailyStopLossUsd - riskState.dailyLossUsd).toFixed(2),
      balanceUsd: +(riskState.lastKnownBalanceUsd === Infinity ? 0 : riskState.lastKnownBalanceUsd).toFixed(2),
      maxExposureUsd: (d.riskMgr as any).cfg.maxExposureUsd,
      dailyStopLossUsd: (d.riskMgr as any).cfg.dailyStopLossUsd,
    },
    scan: snap,
    markets: marketGaps,
    funnel10m: d.funnel.snapshot(600_000),
    funnel1h: d.funnel.snapshot(3_600_000),
    execQuality: d.execQuality.snapshot(),
    pnl1h: d.pnlTracker.snapshot(3_600_000),
    pnl24h: d.pnlTracker.snapshot(86_400_000),
    pnl7d: d.pnlTracker.snapshot(604_800_000),
    dataQuality: d.dataQuality.snapshot(staleBooksPct, 80),
    marketPerformance: d.marketPerf.snapshot(),
    tradeTimeline: d.timeline.recent(15),
    health: {
      uptime: healthStatus.uptime,
      uptimeHuman: healthStatus.uptimeHuman,
      lastLoopMs: healthStatus.lastLoopMs,
      loopsPerMinute: healthStatus.loopsPerMinute,
      memoryMB: healthStatus.memoryMB,
      healthy: healthStatus.healthy,
    },
    metricsRaw: metricsSnap,
  };
}

/* ================================================================ */
/*  DASHBOARD HTML — Professional Ops Console SPA                   */
/* ================================================================ */

const DASHBOARD_HTML = /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PolyArb Ops Console</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"><\/script>
<style>
:root {
  --bg:#0a0e14;--bg2:#0d1117;--card:#141a22;--card2:#1a2233;
  --border:#252d38;--border2:#30363d;
  --text:#e6edf3;--dim:#7d8590;--muted:#484f58;
  --accent:#58a6ff;--accent2:#79c0ff;
  --green:#3fb950;--green-bg:rgba(63,185,80,0.12);
  --red:#f85149;--red-bg:rgba(248,81,73,0.12);
  --yellow:#d29922;--yellow-bg:rgba(210,153,34,0.12);
  --orange:#e3823a;
  --blue:#58a6ff;--blue-bg:rgba(88,166,255,0.08);
  --purple:#bc8cff;
  --font:'SF Mono','JetBrains Mono','Fira Code','Cascadia Code',monospace;
  --font-ui:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
}
*{margin:0;padding:0;box-sizing:border-box;}
body{background:var(--bg);color:var(--text);font-family:var(--font-ui);font-size:13px;line-height:1.5;overflow-x:hidden;}
::-webkit-scrollbar{width:6px;height:6px;}
::-webkit-scrollbar-track{background:var(--bg2);}
::-webkit-scrollbar-thumb{background:var(--muted);border-radius:3px;}
.shell{display:flex;flex-direction:column;min-height:100vh;}

/* Top Bar */
.topbar{display:flex;align-items:center;justify-content:space-between;padding:10px 20px;background:var(--card);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:100;}
.topbar-left{display:flex;align-items:center;gap:16px;}
.topbar h1{font-size:16px;font-weight:700;letter-spacing:-0.5px;}
.topbar h1 span{color:var(--accent);}
.topbar-badges{display:flex;gap:8px;align-items:center;}
.badge{padding:3px 10px;border-radius:4px;font-size:11px;font-weight:700;font-family:var(--font);letter-spacing:0.5px;text-transform:uppercase;}
.badge-running{background:var(--green-bg);color:var(--green);border:1px solid rgba(63,185,80,0.3);}
.badge-safe-mode,.badge-safe_mode{background:var(--yellow-bg);color:var(--yellow);border:1px solid rgba(210,153,34,0.3);}
.badge-halted{background:var(--red-bg);color:var(--red);border:1px solid rgba(248,81,73,0.3);}
.badge-paused{background:var(--yellow-bg);color:var(--yellow);border:1px solid rgba(210,153,34,0.3);}
.badge-dry{background:var(--blue-bg);color:var(--accent);border:1px solid rgba(88,166,255,0.3);}
.badge-live{background:var(--red-bg);color:var(--red);border:1px solid rgba(248,81,73,0.3);}
.badge-paper{background:var(--yellow-bg);color:var(--yellow);border:1px solid rgba(210,153,34,0.3);}
.topbar-right{display:flex;align-items:center;gap:16px;font-size:12px;color:var(--dim);}
.pulse{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:6px;animation:pulse 2s infinite;}
.pulse-green{background:var(--green);box-shadow:0 0 6px var(--green);}
.pulse-red{background:var(--red);box-shadow:0 0 6px var(--red);}
@keyframes pulse{0%,100%{opacity:1;}50%{opacity:0.4;}}

/* Layout */
.main{padding:16px 20px;flex:1;}
.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px;}
.grid-3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;margin-bottom:14px;}
.grid-2-1{display:grid;grid-template-columns:2fr 1fr;gap:14px;margin-bottom:14px;}
.full{margin-bottom:14px;}

/* Cards */
.card{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:14px 16px;}
.card-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;}
.card-title{font-size:11px;font-weight:700;color:var(--dim);text-transform:uppercase;letter-spacing:0.8px;}
.card-icon{font-size:14px;margin-right:6px;}

/* KPI */
.kpi-row{display:grid;grid-template-columns:repeat(8,1fr);gap:10px;margin-bottom:14px;}
.kpi{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:12px 14px;}
.kpi .label{font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:0.6px;margin-bottom:2px;font-weight:600;}
.kpi .value{font-size:22px;font-weight:800;font-family:var(--font);font-variant-numeric:tabular-nums;line-height:1.2;}
.kpi .sub{font-size:10px;color:var(--muted);margin-top:1px;font-family:var(--font);}
.val-green{color:var(--green);}.val-red{color:var(--red);}.val-yellow{color:var(--yellow);}.val-blue{color:var(--accent);}.val-dim{color:var(--dim);}

/* Risk bars */
.risk-bar-wrap{margin-bottom:8px;}
.risk-bar-label{display:flex;justify-content:space-between;font-size:11px;margin-bottom:3px;}
.risk-bar-label span:first-child{color:var(--dim);}
.risk-bar-label span:last-child{color:var(--text);font-family:var(--font);font-weight:600;}
.risk-bar{height:6px;background:var(--border);border-radius:3px;overflow:hidden;}
.risk-bar-fill{height:100%;border-radius:3px;transition:width 0.5s ease;}
.rf-green{background:var(--green);}.rf-yellow{background:var(--yellow);}.rf-red{background:var(--red);}

/* Table */
table{width:100%;border-collapse:collapse;font-size:12px;font-family:var(--font);}
th{text-align:left;color:var(--muted);font-weight:600;padding:6px 10px;border-bottom:1px solid var(--border);font-size:10px;text-transform:uppercase;letter-spacing:0.5px;position:sticky;top:0;background:var(--card);}
td{padding:5px 10px;border-bottom:1px solid rgba(37,45,56,0.5);font-variant-numeric:tabular-nums;}
tr:hover td{background:rgba(88,166,255,0.03);}
.gap-neg{color:var(--green);font-weight:700;}.gap-close{color:var(--yellow);}.gap-far{color:var(--muted);}

/* Funnel */
.funnel{display:flex;flex-direction:column;gap:4px;}
.funnel-stage{display:flex;align-items:center;gap:10px;}
.funnel-bar-wrap{flex:1;}
.funnel-bar{height:24px;border-radius:4px;display:flex;align-items:center;padding:0 8px;font-size:11px;font-family:var(--font);font-weight:600;transition:width 0.5s ease;min-width:40px;}
.funnel-label{width:100px;font-size:11px;color:var(--dim);text-align:right;flex-shrink:0;}
.funnel-pct{font-size:10px;color:var(--muted);width:50px;text-align:right;flex-shrink:0;}

/* Timeline */
.timeline-item{padding:8px 0;border-bottom:1px solid rgba(37,45,56,0.5);cursor:pointer;}
.timeline-item:last-child{border-bottom:none;}
.timeline-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;}
.timeline-id{font-family:var(--font);font-size:11px;color:var(--accent);}
.timeline-market{font-size:12px;color:var(--text);font-weight:600;}
.timeline-stages{display:flex;gap:2px;align-items:center;flex-wrap:wrap;}
.stage-dot{padding:2px 6px;border-radius:3px;font-size:10px;font-family:var(--font);font-weight:600;}
.stage-ok{background:var(--green-bg);color:var(--green);}
.stage-warn{background:var(--yellow-bg);color:var(--yellow);}
.stage-fail{background:var(--red-bg);color:var(--red);}
.stage-pending{background:rgba(125,133,144,0.15);color:var(--dim);}
.stage-arrow{color:var(--muted);font-size:10px;}

/* Incidents */
.incident{display:flex;gap:8px;padding:5px 0;border-bottom:1px solid rgba(37,45,56,0.3);font-size:12px;align-items:flex-start;}
.incident:last-child{border-bottom:none;}
.sev{padding:1px 5px;border-radius:3px;font-size:9px;font-weight:800;font-family:var(--font);letter-spacing:0.5px;flex-shrink:0;}
.sev-HIGH{background:var(--red-bg);color:var(--red);}
.sev-MED{background:var(--yellow-bg);color:var(--yellow);}
.sev-LOW{background:rgba(125,133,144,0.15);color:var(--dim);}
.incident-ts{color:var(--muted);font-family:var(--font);font-size:11px;flex-shrink:0;min-width:65px;}
.incident-msg{color:var(--text);flex:1;}
.incident-count{color:var(--muted);font-family:var(--font);font-size:10px;}

/* Tabs */
.tabs{display:flex;gap:2px;}
.tab{padding:4px 12px;border-radius:4px;font-size:11px;font-weight:600;cursor:pointer;color:var(--dim);background:transparent;border:1px solid transparent;transition:all 0.15s;}
.tab:hover{color:var(--text);}
.tab.active{color:var(--accent);background:var(--blue-bg);border-color:rgba(88,166,255,0.2);}

/* Charts */
.chart-wrap canvas{width:100%!important;height:160px!important;}

/* PnL */
.pnl-row{display:flex;justify-content:space-between;padding:4px 0;font-size:12px;font-family:var(--font);}
.pnl-label{color:var(--dim);}.pnl-val{font-weight:600;}

/* Perf badge */
.perf-disable{background:var(--red-bg);color:var(--red);padding:1px 5px;border-radius:3px;font-size:9px;font-weight:700;margin-left:4px;}

/* Drawer */
.drawer-overlay{display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:200;}
.drawer-overlay.open{display:block;}
.drawer{position:fixed;top:0;right:0;bottom:0;width:480px;background:var(--card);border-left:1px solid var(--border);z-index:201;overflow-y:auto;padding:20px;transform:translateX(100%);transition:transform 0.25s ease;}
.drawer.open{transform:translateX(0);}
.drawer-close{position:absolute;top:12px;right:16px;background:none;border:none;color:var(--dim);cursor:pointer;font-size:20px;}
.drawer-close:hover{color:var(--text);}
.drawer h2{font-size:14px;margin-bottom:16px;}
.drawer-section{margin-bottom:16px;}
.drawer-section h3{font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;}

/* Log */
.log-entries{max-height:160px;overflow-y:auto;font-family:var(--font);font-size:11px;line-height:1.7;}
.log-entry{color:var(--dim);padding:1px 0;}.log-entry .ts{color:var(--muted);}.log-entry.opp{color:var(--green);font-weight:600;}.log-entry.err{color:var(--red);}

@media(max-width:1200px){.kpi-row{grid-template-columns:repeat(4,1fr);}.grid-3{grid-template-columns:1fr 1fr;}}
@media(max-width:768px){.kpi-row{grid-template-columns:repeat(2,1fr);}.grid-2,.grid-2-1{grid-template-columns:1fr;}.drawer{width:100%;}}
</style>
</head>
<body>
<div class="shell">

<div class="topbar">
  <div class="topbar-left">
    <h1>\\u26A1 <span>PolyArb</span> Ops Console</h1>
    <div class="topbar-badges">
      <span id="state-badge" class="badge badge-running">RUNNING</span>
      <span id="mode-badge" class="badge badge-dry">DRY</span>
      <span id="armed-badge" class="badge" style="display:none">ARMED</span>
    </div>
  </div>
  <div class="topbar-right">
    <span><span id="health-pulse" class="pulse pulse-green"></span><span id="health-label">Healthy</span></span>
    <span id="uptime-label">0m</span>
    <span id="clock"></span>
  </div>
</div>

<div class="main">

<div class="kpi-row">
  <div class="kpi"><div class="label">Scan Cycles</div><div class="value" id="k-cycles">0</div><div class="sub" id="k-cycles-sub">\\u2014</div></div>
  <div class="kpi"><div class="label">Fresh Books</div><div class="value" id="k-books">\\u2014</div><div class="sub" id="k-books-sub">\\u2014</div></div>
  <div class="kpi"><div class="label">Closest Gap</div><div class="value" id="k-gap">\\u2014</div><div class="sub" id="k-gap-sub">\\u2014</div></div>
  <div class="kpi"><div class="label">Opps Found</div><div class="value" id="k-opps">0</div><div class="sub" id="k-opps-sub">this cycle</div></div>
  <div class="kpi"><div class="label">Trades</div><div class="value" id="k-trades">0</div><div class="sub" id="k-trades-sub">\\u2014</div></div>
  <div class="kpi"><div class="label">Daily PnL</div><div class="value" id="k-pnl">$0.00</div><div class="sub" id="k-pnl-sub">\\u2014</div></div>
  <div class="kpi"><div class="label">Exposure</div><div class="value" id="k-exposure">$0</div><div class="sub" id="k-exp-sub">\\u2014</div></div>
  <div class="kpi"><div class="label">Memory</div><div class="value" id="k-mem">\\u2014</div><div class="sub">MB</div></div>
</div>

<div class="grid-2-1">
  <div class="card">
    <div class="card-header"><span class="card-title"><span class="card-icon">\\uD83D\\uDEE1\\uFE0F</span>Risk & Exposure Cockpit</span></div>
    <div class="grid-2" style="margin-bottom:0">
      <div>
        <div class="risk-bar-wrap">
          <div class="risk-bar-label"><span>Total Exposure</span><span id="rb-exp-val">$0 / $500</span></div>
          <div class="risk-bar"><div class="risk-bar-fill rf-green" id="rb-exp" style="width:0%"></div></div>
        </div>
        <div class="risk-bar-wrap">
          <div class="risk-bar-label"><span>Daily Stop-Loss Used</span><span id="rb-sl-val">$0 / $100</span></div>
          <div class="risk-bar"><div class="risk-bar-fill rf-green" id="rb-sl" style="width:0%"></div></div>
        </div>
        <div class="risk-bar-wrap">
          <div class="risk-bar-label"><span>Unhedged Exposure</span><span id="rb-uh-val">$0</span></div>
          <div class="risk-bar"><div class="risk-bar-fill rf-green" id="rb-uh" style="width:0%"></div></div>
        </div>
      </div>
      <div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
          <div class="kpi" style="padding:8px"><div class="label">Open Orders</div><div class="value" style="font-size:18px" id="r-open">0</div></div>
          <div class="kpi" style="padding:8px"><div class="label">Balance</div><div class="value" style="font-size:18px" id="r-bal">\\u2014</div></div>
          <div class="kpi" style="padding:8px"><div class="label">Drawdown</div><div class="value val-dim" style="font-size:18px" id="r-dd">$0</div></div>
          <div class="kpi" style="padding:8px"><div class="label">SL Remaining</div><div class="value" style="font-size:18px" id="r-slr">\\u2014</div></div>
        </div>
      </div>
    </div>
  </div>
  <div class="card">
    <div class="card-header"><span class="card-title"><span class="card-icon">\\u26A1</span>Circuit Breakers</span></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px;">
      <div class="kpi" style="padding:8px"><div class="label">Errors/min</div><div class="value" style="font-size:16px" id="cb-err">0</div></div>
      <div class="kpi" style="padding:8px"><div class="label">429s/min</div><div class="value" style="font-size:16px" id="cb-429">0</div></div>
      <div class="kpi" style="padding:8px"><div class="label">Cancels/min</div><div class="value" style="font-size:16px" id="cb-cancel">0</div></div>
      <div class="kpi" style="padding:8px"><div class="label">Consec. Errors</div><div class="value" style="font-size:16px" id="cb-consec">0</div></div>
    </div>
    <div style="font-size:11px;color:var(--dim);">
      <div>Last error: <span id="cb-last-err" style="color:var(--red)">none</span></div>
      <div>Recovery: <span id="cb-recovery" style="color:var(--green)">\\u2014</span></div>
    </div>
  </div>
</div>

<div class="grid-2">
  <div class="card">
    <div class="card-header"><span class="card-title">Arb Gap History (%)</span></div>
    <div class="chart-wrap"><canvas id="chart-gap"></canvas></div>
  </div>
  <div class="card">
    <div class="card-header"><span class="card-title">Fresh Books / Cycle</span></div>
    <div class="chart-wrap"><canvas id="chart-books"></canvas></div>
  </div>
</div>

<div class="grid-2">
  <div class="card">
    <div class="card-header">
      <span class="card-title"><span class="card-icon">\\uD83D\\uDD3D</span>Opportunity Funnel</span>
      <div class="tabs"><div class="tab active" data-funnel="10m">10m</div><div class="tab" data-funnel="1h">1h</div></div>
    </div>
    <div class="funnel" id="funnel-chart"></div>
  </div>
  <div class="card">
    <div class="card-header"><span class="card-title"><span class="card-icon">\\uD83D\\uDCC8</span>Execution Quality</span></div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:10px;">
      <div class="kpi" style="padding:8px"><div class="label">Fill Ratio</div><div class="value" style="font-size:16px" id="eq-fill">\\u2014</div></div>
      <div class="kpi" style="padding:8px"><div class="label">Avg Fill A</div><div class="value" style="font-size:16px" id="eq-filla">\\u2014</div></div>
      <div class="kpi" style="padding:8px"><div class="label">Avg Fill B</div><div class="value" style="font-size:16px" id="eq-fillb">\\u2014</div></div>
    </div>
    <div class="chart-wrap"><canvas id="chart-slippage"></canvas></div>
  </div>
</div>

<div class="grid-2">
  <div class="card">
    <div class="card-header">
      <span class="card-title"><span class="card-icon">\\uD83D\\uDCB0</span>Profit Attribution</span>
      <div class="tabs"><div class="tab active" data-pnl="1h">1h</div><div class="tab" data-pnl="24h">24h</div><div class="tab" data-pnl="7d">7d</div></div>
    </div>
    <div id="pnl-decomp"></div>
    <div class="chart-wrap" style="margin-top:8px"><canvas id="chart-pnl"></canvas></div>
  </div>
  <div class="card">
    <div class="card-header"><span class="card-title"><span class="card-icon">\\u23F1\\uFE0F</span>Trade Lifecycle Timeline</span></div>
    <div id="timeline-list" style="max-height:300px;overflow-y:auto;"></div>
  </div>
</div>

<div class="grid-2">
  <div class="card">
    <div class="card-header"><span class="card-title"><span class="card-icon">\\uD83D\\uDCE1</span>Market Health & Data Quality</span></div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:8px;">
      <div class="kpi" style="padding:8px"><div class="label">API p50</div><div class="value" style="font-size:16px" id="dq-p50">\\u2014</div><div class="sub">ms</div></div>
      <div class="kpi" style="padding:8px"><div class="label">API p95</div><div class="value" style="font-size:16px" id="dq-p95">\\u2014</div><div class="sub">ms</div></div>
      <div class="kpi" style="padding:8px"><div class="label">Rate Limit</div><div class="value" style="font-size:16px" id="dq-rl">\\u2014</div><div class="sub">% headroom</div></div>
      <div class="kpi" style="padding:8px"><div class="label">Retries</div><div class="value" style="font-size:16px" id="dq-retries">0</div></div>
      <div class="kpi" style="padding:8px"><div class="label">429 Hits</div><div class="value" style="font-size:16px" id="dq-429">0</div></div>
      <div class="kpi" style="padding:8px"><div class="label">Stale Books</div><div class="value" style="font-size:16px" id="dq-stale">\\u2014</div><div class="sub">%</div></div>
    </div>
    <div style="display:flex;gap:12px;font-size:11px;color:var(--dim);padding-top:4px;border-top:1px solid var(--border);">
      <span>WS: <span id="dq-ws" style="font-weight:700">\\u2014</span></span>
      <span>Reconnects: <span id="dq-wsr">0</span></span>
      <span>Dropped: <span id="dq-wsd">0</span></span>
    </div>
  </div>
  <div class="card">
    <div class="card-header"><span class="card-title"><span class="card-icon">\\uD83C\\uDFC6</span>Market Performance Leaderboard</span></div>
    <div style="max-height:280px;overflow-y:auto;">
      <table><thead><tr><th>Market</th><th>Net PnL</th><th>Fill%</th><th>Hedge%</th><th>Slip</th><th>Edge</th><th>#</th></tr></thead><tbody id="perf-tbody"></tbody></table>
    </div>
  </div>
</div>

<div class="full">
  <div class="card">
    <div class="card-header"><span class="card-title"><span class="card-icon">\\uD83D\\uDCCA</span>Market Overview</span></div>
    <div style="max-height:400px;overflow-y:auto;">
      <table><thead><tr><th>Market</th><th>Kind</th><th>Ask YES</th><th>Ask NO</th><th>Gap %</th><th>Spread Y</th><th>Spread N</th><th>Age (s)</th></tr></thead><tbody id="market-tbody"></tbody></table>
    </div>
  </div>
</div>

<div class="grid-2">
  <div class="card">
    <div class="card-header"><span class="card-title"><span class="card-icon">\\uD83D\\uDEA8</span>Incidents & Alerts</span></div>
    <div id="incident-list" style="max-height:240px;overflow-y:auto;"></div>
  </div>
  <div class="card">
    <div class="card-header"><span class="card-title"><span class="card-icon">\\uD83D\\uDCDD</span>Event Log</span></div>
    <div class="log-entries" id="log-entries"></div>
  </div>
</div>

</div>

<div class="drawer-overlay" id="drawer-overlay"></div>
<div class="drawer" id="drawer">
  <button class="drawer-close" id="drawer-close">&times;</button>
  <h2 id="drawer-title">Trade Detail</h2>
  <div id="drawer-content"></div>
</div>

</div>

<script>
var MAX_H=150,gapH=[],bookH=[],timeH=[],logEntries=[],lastCycle=0,activeFP='10m',activePP='1h',curD=null;

Chart.defaults.color='#7d8590';Chart.defaults.borderColor='#252d38';
var CO={responsive:true,maintainAspectRatio:false,animation:{duration:200},plugins:{legend:{display:false}}};

var gapChart=new Chart(document.getElementById('chart-gap'),{type:'line',data:{labels:timeH,datasets:[{data:gapH,borderColor:'#58a6ff',backgroundColor:'rgba(88,166,255,0.08)',fill:true,tension:0.3,pointRadius:0,borderWidth:1.5},{data:[],borderColor:'#3fb950',borderDash:[4,4],borderWidth:1,pointRadius:0}]},options:Object.assign({},CO,{scales:{x:{display:false},y:{grid:{color:'#1a2233'},title:{display:true,text:'Gap %',font:{size:10}}}}})});

var bookChart=new Chart(document.getElementById('chart-books'),{type:'line',data:{labels:timeH,datasets:[{data:bookH,borderColor:'#3fb950',backgroundColor:'rgba(63,185,80,0.08)',fill:true,tension:0.3,pointRadius:0,borderWidth:1.5}]},options:Object.assign({},CO,{scales:{x:{display:false},y:{beginAtZero:true,grid:{color:'#1a2233'},title:{display:true,text:'Count',font:{size:10}}}}})});

var slipChart=new Chart(document.getElementById('chart-slippage'),{type:'bar',data:{labels:[],datasets:[{label:'Leg A',data:[],backgroundColor:'rgba(88,166,255,0.5)',borderRadius:2},{label:'Leg B',data:[],backgroundColor:'rgba(188,140,255,0.5)',borderRadius:2}]},options:Object.assign({},CO,{plugins:{legend:{display:true,labels:{boxWidth:8,font:{size:10}}}},scales:{x:{display:false},y:{grid:{color:'#1a2233'},title:{display:true,text:'Slippage bps',font:{size:10}}}}})});

var pnlChart=new Chart(document.getElementById('chart-pnl'),{type:'bar',data:{labels:['Gross Edge','Fees','Slippage','Hedge Loss','Net'],datasets:[{data:[0,0,0,0,0],backgroundColor:['rgba(63,185,80,0.6)','rgba(248,81,73,0.4)','rgba(210,153,34,0.4)','rgba(248,81,73,0.6)','rgba(88,166,255,0.6)'],borderRadius:3}]},options:Object.assign({},CO,{indexAxis:'y',scales:{x:{grid:{color:'#1a2233'}},y:{grid:{display:false}}}})});

function fmt(v,d){d=d||2;return v!=null&&isFinite(v)?v.toFixed(d):'\\u2014';}
function fU(v){return v!=null&&isFinite(v)?'$'+Math.abs(v).toFixed(2):'\\u2014';}
function fP(v){return v!=null?Math.round(v*100)+'%':'\\u2014';}
function fT(ms){var s=Math.floor(ms/1000),h=Math.floor(s/3600),m=Math.floor((s%3600)/60);return h>0?h+'h '+m+'m':m>0?m+'m '+(s%60)+'s':s+'s';}
function gC(g){if(g==null)return'gap-far';if(g<0)return'gap-neg';if(g<2)return'gap-close';return'gap-far';}
function rC(p){return p>80?'rf-red':p>50?'rf-yellow':'rf-green';}
function vC(v){return v>0?'val-green':v<0?'val-red':'val-dim';}
function tA(ts){var s=Math.floor((Date.now()-ts)/1000);if(s<60)return s+'s ago';if(s<3600)return Math.floor(s/60)+'m ago';return Math.floor(s/3600)+'h ago';}
function sT(ts){return new Date(ts).toLocaleTimeString();}

function addLog(msg,cls){logEntries.unshift({ts:sT(Date.now()),msg:msg,cls:cls||''});if(logEntries.length>60)logEntries.pop();var el=document.getElementById('log-entries');el.innerHTML=logEntries.slice(0,40).map(function(e){return'<div class="log-entry '+e.cls+'"><span class="ts">'+e.ts+'</span> '+e.msg+'</div>';}).join('');}

var FS=[{k:'detected',l:'Detected',c:'var(--accent)'},{k:'passedFilters',l:'Passed Filters',c:'var(--blue)'},{k:'passedRisk',l:'Passed Risk',c:'var(--purple)'},{k:'ordersPlaced',l:'Orders Placed',c:'var(--yellow)'},{k:'fullyFilled',l:'Fully Filled',c:'var(--orange)'},{k:'hedged',l:'Hedged',c:'var(--red)'},{k:'netProfitable',l:'Net Profitable',c:'var(--green)'}];

function renderFunnel(data){var el=document.getElementById('funnel-chart');var mx=Math.max(data.detected,1);el.innerHTML=FS.map(function(s,i){var v=data[s.k]||0;var w=Math.max((v/mx)*100,4);var prev=i>0?(data[FS[i-1].k]||0):0;var cp=i>0&&prev>0?Math.round((v/prev)*100)+'%':'';return'<div class="funnel-stage"><div class="funnel-label">'+s.l+'</div><div class="funnel-bar-wrap"><div class="funnel-bar" style="width:'+w+'%;background:'+s.c+'22;color:'+s.c+';border:1px solid '+s.c+'44">'+v+'</div></div><div class="funnel-pct">'+cp+'</div></div>';}).join('');}

function sC(stage,success){if(stage==='finalized')return success?'stage-ok':'stage-fail';if(stage==='hedge_triggered'||stage==='cancelled')return'stage-warn';return'stage-ok';}

function renderTimeline(trades){var el=document.getElementById('timeline-list');if(!trades||trades.length===0){el.innerHTML='<div style="color:var(--muted);font-size:12px;padding:20px 0;text-align:center">No trades yet</div>';return;}el.innerHTML=trades.map(function(t){var dur=t.totalDurationMs!=null?(t.totalDurationMs/1000).toFixed(1)+'s':'in progress';var stages=t.events.map(function(e){return'<span class="stage-dot '+sC(e.stage,t.success)+'" title="'+e.stage+(e.durationMs!=null?' '+e.durationMs+'ms':'')+'">'+e.stage.replace(/_/g,' ')+'</span>';}).join('<span class="stage-arrow">\\u2192</span>');var sb=t.success===true?'<span class="val-green">\\u2713</span>':t.success===false?'<span class="val-red">\\u2717</span>':'<span class="val-yellow">\\u23F3</span>';return'<div class="timeline-item" onclick="openDrawer(\\''+t.tradeId+'\\')"><div class="timeline-header"><span class="timeline-market">'+sb+' '+t.marketName+'</span><span class="timeline-id">'+t.tradeId.slice(0,12)+'\\u2026 \\u00B7 '+dur+'</span></div><div class="timeline-stages">'+stages+'</div></div>';}).join('');}

function renderPnl(pnl){var el=document.getElementById('pnl-decomp');var rows=[['Gross Edge',pnl.grossEdge,'val-green'],['Fees',-pnl.fees,'val-red'],['Slippage',-pnl.slippage,'val-red'],['Hedge Losses',-pnl.hedgeLosses,'val-red'],['Net',pnl.net,vC(pnl.net)]];el.innerHTML=rows.map(function(r){return'<div class="pnl-row"><span class="pnl-label">'+r[0]+'</span><span class="pnl-val '+r[2]+'">'+(r[1]>=0?'+':'')+fU(r[1])+'</span></div>';}).join('')+'<div style="border-top:1px solid var(--border);margin-top:4px"></div>';pnlChart.data.datasets[0].data=[pnl.grossEdge,pnl.fees,pnl.slippage,pnl.hedgeLosses,pnl.net];pnlChart.update('none');}

function renderIncidents(incidents){var el=document.getElementById('incident-list');if(!incidents||incidents.length===0){el.innerHTML='<div style="color:var(--muted);font-size:12px;padding:20px 0;text-align:center">No incidents</div>';return;}el.innerHTML=incidents.map(function(i){var cb=i.count>1?'<span class="incident-count">\\u00D7'+i.count+'</span>':'';return'<div class="incident"><span class="sev sev-'+i.severity+'">'+i.severity+'</span><span class="incident-ts">'+tA(i.timestamp)+'</span><span class="incident-msg">'+i.message+' '+cb+'</span></div>';}).join('');}

function openDrawer(tradeId){if(!curD)return;var trade=(curD.tradeTimeline||[]).find(function(t){return t.tradeId===tradeId;});if(!trade)return;document.getElementById('drawer-title').textContent='Trade: '+trade.marketName;var c=document.getElementById('drawer-content');var html='<div class="drawer-section"><h3>Overview</h3><div class="pnl-row"><span class="pnl-label">Trade ID</span><span class="pnl-val" style="font-size:11px">'+trade.tradeId+'</span></div><div class="pnl-row"><span class="pnl-label">Type</span><span class="pnl-val">'+trade.type+'</span></div><div class="pnl-row"><span class="pnl-label">Expected</span><span class="pnl-val">'+fmt(trade.expectedProfitBps,1)+' bps</span></div><div class="pnl-row"><span class="pnl-label">Realized</span><span class="pnl-val '+vC(trade.realizedProfitBps)+'">'+(trade.realizedProfitBps!=null?fmt(trade.realizedProfitBps,1)+' bps':'\\u2014')+'</span></div><div class="pnl-row"><span class="pnl-label">Hedged</span><span class="pnl-val">'+(trade.hedged?'Yes (loss: '+fU(trade.hedgeLoss)+')':'No')+'</span></div><div class="pnl-row"><span class="pnl-label">Duration</span><span class="pnl-val">'+(trade.totalDurationMs!=null?(trade.totalDurationMs/1000).toFixed(2)+'s':'\\u2014')+'</span></div><div class="pnl-row"><span class="pnl-label">Result</span><span class="pnl-val '+(trade.success?'val-green':'val-red')+'">'+(trade.success===true?'SUCCESS':trade.success===false?'FAILED':'PENDING')+'</span></div></div>';html+='<div class="drawer-section"><h3>Event Timeline</h3>';html+=trade.events.map(function(e){var dur=e.durationMs!=null?'<span style="color:var(--muted)"> +'+e.durationMs+'ms</span>':'';return'<div style="padding:3px 0;font-size:12px;font-family:var(--font)"><span class="stage-dot '+sC(e.stage,trade.success)+'">'+e.stage.replace(/_/g,' ')+'</span>'+dur+(e.detail?'<span style="color:var(--dim);margin-left:6px">'+e.detail+'</span>':'')+'<span style="color:var(--muted);margin-left:8px;font-size:10px">'+sT(e.timestamp)+'</span></div>';}).join('');html+='</div>';c.innerHTML=html;document.getElementById('drawer-overlay').classList.add('open');document.getElementById('drawer').classList.add('open');}

document.getElementById('drawer-close').onclick=function(){document.getElementById('drawer-overlay').classList.remove('open');document.getElementById('drawer').classList.remove('open');};
document.getElementById('drawer-overlay').onclick=function(){document.getElementById('drawer-overlay').classList.remove('open');document.getElementById('drawer').classList.remove('open');};

document.querySelectorAll('[data-funnel]').forEach(function(tab){tab.onclick=function(){document.querySelectorAll('[data-funnel]').forEach(function(t){t.classList.remove('active');});tab.classList.add('active');activeFP=tab.dataset.funnel;if(curD)renderFunnel(activeFP==='10m'?curD.funnel10m:curD.funnel1h);};});
document.querySelectorAll('[data-pnl]').forEach(function(tab){tab.onclick=function(){document.querySelectorAll('[data-pnl]').forEach(function(t){t.classList.remove('active');});tab.classList.add('active');activePP=tab.dataset.pnl;if(curD)renderPnl(curD['pnl'+activePP]);};});

async function poll(){try{var res=await fetch('/api/status');var d=await res.json();curD=d;

document.getElementById('clock').textContent=new Date().toLocaleTimeString();

var stB=document.getElementById('state-badge');stB.textContent=d.bot.state;stB.className='badge badge-'+d.bot.state.toLowerCase().replace('_','-');
var mdB=document.getElementById('mode-badge');mdB.textContent=d.bot.mode.toUpperCase();mdB.className='badge badge-'+d.bot.mode;
var arB=document.getElementById('armed-badge');if(d.bot.mode==='live'){arB.style.display='inline';arB.textContent=d.bot.liveArmed?'ARMED':'DISARMED';arB.className='badge '+(d.bot.liveArmed?'badge-live':'badge-dry');}else arB.style.display='none';

var hp=document.getElementById('health-pulse'),hl=document.getElementById('health-label');hp.className='pulse '+(d.health.healthy?'pulse-green':'pulse-red');hl.textContent=d.health.healthy?'Healthy':'Unhealthy';document.getElementById('uptime-label').textContent=fT(d.health.uptime);

var sc=d.metricsRaw['counter.scan_cycles']||0;document.getElementById('k-cycles').textContent=sc;document.getElementById('k-cycles-sub').textContent=d.health.loopsPerMinute+'/min';
document.getElementById('k-books').textContent=d.scan.freshBooks+'/'+d.scan.totalTokenIds;document.getElementById('k-books-sub').textContent=Math.round(d.scan.freshBooks/Math.max(d.scan.totalTokenIds,1)*100)+'% fresh';
document.getElementById('k-mem').textContent=d.health.memoryMB;

var vG=(d.scan.marketGaps||[]).filter(function(g){return g.gap!=null;});var sorted=vG.slice().sort(function(a,b){return a.gap-b.gap;});var cl=sorted[0];
if(cl){document.getElementById('k-gap').innerHTML='<span class="'+gC(cl.gap)+'">'+fmt(cl.gap)+'%</span>';document.getElementById('k-gap-sub').textContent=cl.market;}else{document.getElementById('k-gap').textContent='\\u2014';document.getElementById('k-gap-sub').textContent='no data';}

document.getElementById('k-opps').textContent=d.metricsRaw['counter.opportunities_found']||0;document.getElementById('k-opps-sub').textContent=d.scan.opps+' this cycle';
var st=d.metricsRaw['counter.successful_trades']||0,ft=d.metricsRaw['counter.failed_trades']||0;document.getElementById('k-trades').textContent=st;document.getElementById('k-trades-sub').textContent=ft>0?ft+' failed':'none failed';
var pV=d.risk.dailyPnl;document.getElementById('k-pnl').textContent=(pV>=0?'+':'')+fU(pV);document.getElementById('k-pnl').className='value '+vC(pV);
document.getElementById('k-exposure').textContent=fU(d.risk.totalExposureUsd);document.getElementById('k-exp-sub').textContent='of $'+d.risk.maxExposureUsd;

var eP=d.risk.maxExposureUsd>0?(d.risk.totalExposureUsd/d.risk.maxExposureUsd*100):0;document.getElementById('rb-exp').style.width=Math.min(eP,100)+'%';document.getElementById('rb-exp').className='risk-bar-fill '+rC(eP);document.getElementById('rb-exp-val').textContent=fU(d.risk.totalExposureUsd)+' / '+fU(d.risk.maxExposureUsd);
var sU=d.risk.dailyStopLossUsd-d.risk.stopLossRemaining,sP=d.risk.dailyStopLossUsd>0?(sU/d.risk.dailyStopLossUsd*100):0;document.getElementById('rb-sl').style.width=Math.min(sP,100)+'%';document.getElementById('rb-sl').className='risk-bar-fill '+rC(sP);document.getElementById('rb-sl-val').textContent=fU(sU)+' / '+fU(d.risk.dailyStopLossUsd);
var uP=d.risk.maxExposureUsd>0?(d.risk.unhedgedExposureUsd/d.risk.maxExposureUsd*100):0;document.getElementById('rb-uh').style.width=Math.min(uP,100)+'%';document.getElementById('rb-uh').className='risk-bar-fill '+rC(uP);document.getElementById('rb-uh-val').textContent=fU(d.risk.unhedgedExposureUsd);
document.getElementById('r-open').textContent=d.risk.openOrders;document.getElementById('r-bal').textContent=d.risk.balanceUsd>0?fU(d.risk.balanceUsd):'\\u2014';document.getElementById('r-dd').textContent=fU(d.risk.drawdown);document.getElementById('r-slr').textContent=fU(d.risk.stopLossRemaining);

document.getElementById('cb-err').textContent=d.circuitBreaker.errorsPerMin;document.getElementById('cb-err').className='value '+(d.circuitBreaker.errorsPerMin>3?'val-red':d.circuitBreaker.errorsPerMin>0?'val-yellow':'');
document.getElementById('cb-429').textContent=d.circuitBreaker.rateLimitsPerMin;document.getElementById('cb-cancel').textContent=d.circuitBreaker.cancelsPerMin;
document.getElementById('cb-consec').textContent=d.circuitBreaker.consecutiveErrors;document.getElementById('cb-consec').className='value '+(d.circuitBreaker.consecutiveErrors>2?'val-red':'');
document.getElementById('cb-last-err').textContent=d.bot.lastError||'none';document.getElementById('cb-recovery').textContent=d.bot.lastRecoveryAction||'\\u2014';

var now=new Date().toLocaleTimeString();timeH.push(now);gapH.push(cl?cl.gap:null);bookH.push(d.scan.freshBooks);if(timeH.length>MAX_H){timeH.shift();gapH.shift();bookH.shift();}
gapChart.data.datasets[1].data=gapH.map(function(){return 0;});gapChart.update('none');bookChart.update('none');

var eq=d.execQuality;if(eq.slippageBpsLegA&&eq.slippageBpsLegA.length>0){slipChart.data.labels=eq.slippageBpsLegA.map(function(_,i){return i+1;});slipChart.data.datasets[0].data=eq.slippageBpsLegA;slipChart.data.datasets[1].data=eq.slippageBpsLegB;slipChart.update('none');}
document.getElementById('eq-fill').textContent=eq.fillRatio>0?fP(eq.fillRatio):'\\u2014';document.getElementById('eq-filla').textContent=eq.avgTimeToFillA>0?eq.avgTimeToFillA+'ms':'\\u2014';document.getElementById('eq-fillb').textContent=eq.avgTimeToFillB>0?eq.avgTimeToFillB+'ms':'\\u2014';

renderFunnel(activeFP==='10m'?d.funnel10m:d.funnel1h);renderPnl(d['pnl'+activePP]);renderTimeline(d.tradeTimeline);

document.getElementById('dq-p50').textContent=d.dataQuality.apiLatencyP50;document.getElementById('dq-p95').textContent=d.dataQuality.apiLatencyP95;document.getElementById('dq-rl').textContent=d.dataQuality.rateLimitHeadroom;
document.getElementById('dq-retries').textContent=d.dataQuality.retriesCount;document.getElementById('dq-429').textContent=d.dataQuality.rateLimitHitsCount;document.getElementById('dq-stale').textContent=fmt(d.dataQuality.staleBooksPct,1);
document.getElementById('dq-ws').textContent=d.dataQuality.wsConnected?'Connected':'Disconnected';document.getElementById('dq-ws').style.color=d.dataQuality.wsConnected?'var(--green)':'var(--red)';document.getElementById('dq-wsr').textContent=d.dataQuality.wsReconnectCount;document.getElementById('dq-wsd').textContent=d.dataQuality.wsDroppedUpdates;

renderIncidents(d.incidents);

var pTb=document.getElementById('perf-tbody');var perf=d.marketPerformance||[];if(perf.length===0){pTb.innerHTML='<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:20px">No trade data yet</td></tr>';}else{pTb.innerHTML=perf.map(function(p){var badge=p.disableCandidate?'<span class="perf-disable">DISABLE?</span>':'';return'<tr><td>'+p.market+badge+'</td><td class="'+vC(p.netPnl)+'">'+(p.netPnl>=0?'+':'')+fU(p.netPnl)+'</td><td>'+fP(p.fillSuccessRate)+'</td><td>'+fP(p.hedgeFrequency)+'</td><td>'+fmt(p.avgSlippageBps,1)+'</td><td>'+fmt(p.avgEdgeBps,1)+'</td><td>'+p.tradesCount+'</td></tr>';}).join('');}

var mkts=(d.markets||[]).slice().sort(function(a,b){return(a.gap!=null?a.gap:999)-(b.gap!=null?b.gap:999);});
document.getElementById('market-tbody').innerHTML=mkts.map(function(m){if(m.kind==='binary'){var age=Math.max(m.yesAge||0,m.noAge||0);return'<tr><td>'+m.market+'</td><td>Binary</td><td>'+(m.askYes!=null?fmt(m.askYes,3):'\\u2014')+'</td><td>'+(m.askNo!=null?fmt(m.askNo,3):'\\u2014')+'</td><td class="'+gC(m.gap)+'">'+(m.gap!=null?fmt(m.gap)+'%':'\\u2014')+'</td><td>'+(m.spreadYes!=null?fmt(m.spreadYes,1)+'%':'\\u2014')+'</td><td>'+(m.spreadNo!=null?fmt(m.spreadNo,1)+'%':'\\u2014')+'</td><td>'+(age?(age/1000).toFixed(1):'\\u2014')+'</td></tr>';}else{var outs=(m.outcomes||[]).map(function(o){return o.label+': '+(o.ask!=null?fmt(o.ask,3):'?');}).join(', ');return'<tr><td>'+m.market+'</td><td>Multi ('+(m.outcomes||[]).length+')</td><td colspan="2" style="font-size:10px;color:var(--dim)">'+outs+'</td><td class="'+gC(m.gap)+'">'+(m.gap!=null?fmt(m.gap)+'%':'\\u2014')+'</td><td>\\u2014</td><td>\\u2014</td><td>\\u2014</td></tr>';}}).join('');

if(d.scan.cycle>lastCycle&&lastCycle>0){addLog('Cycle '+d.scan.cycle+' \\u2014 '+d.scan.freshBooks+' books, '+d.scan.opps+' raw opps');if(d.scan.qualified>0)addLog('\\uD83C\\uDFAF '+d.scan.qualified+' qualified!','opp');}
lastCycle=d.scan.cycle;
if(d.bot.lastError&&d.bot.lastErrorAt&&Date.now()-d.bot.lastErrorAt<10000)addLog('\\u26A0\\uFE0F '+d.bot.lastError,'err');

}catch(err){addLog('\\u26A0\\uFE0F Fetch: '+err.message,'err');}}

poll();setInterval(poll,3000);
<\/script>
</body>
</html>`;
