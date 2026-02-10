/**
 * Lightweight dashboard HTTP server embedded in the bot process.
 * Serves a single-page HTML dashboard on localhost with live-updating charts.
 *
 * Endpoints:
 *   GET /           → HTML dashboard
 *   GET /api/status → full JSON snapshot (polled by dashboard)
 */
import http from "node:http";
import pino from "pino";
import type { Metrics } from "./metrics.js";
import type { HealthMonitor } from "./health.js";
import type { OrderBookManager } from "../clob/books.js";
import type { Market, MarketBinary, MarketMulti } from "../config/schema.js";

const logger = pino({ name: "Dashboard" });

export interface DashboardDeps {
  metrics: Metrics;
  health: HealthMonitor;
  bookMgr: OrderBookManager;
  markets: () => Market[];                       // getter — markets can change
  mode: string;
  scanState: () => ScanSnapshot;
}

export interface ScanSnapshot {
  cycle: number;
  freshBooks: number;
  totalTokenIds: number;
  oppsThisCycle: number;
  qualifiedThisCycle: number;
  lastOpp: Record<string, unknown> | null;
  marketGaps: MarketGap[];
}

export interface MarketGap {
  market: string;
  askYes: number;
  askNo: number;
  gap: number;            // askYes + askNo - 1  (negative = arb)
  bidYes: number;
  bidNo: number;
  spreadYes: number;      // ask - bid
  spreadNo: number;
}

export function startDashboard(port: number, deps: DashboardDeps): http.Server {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    if (url.pathname === "/api/status") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(JSON.stringify(buildStatus(deps)));
      return;
    }

    // Serve dashboard HTML for everything else
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(DASHBOARD_HTML);
  });

  server.listen(port, "127.0.0.1", () => {
    logger.info({ port, url: `http://localhost:${port}` }, "Dashboard started");
  });

  return server;
}

/* ---- Build the JSON snapshot ---- */

function buildStatus(deps: DashboardDeps): Record<string, unknown> {
  const snap = deps.scanState();
  const healthStatus = deps.health.status({
    booksOk: snap.freshBooks > 0,
  });
  const metricsSnap = deps.metrics.snapshot();

  // Per-market book overview
  const markets = deps.markets();
  const marketData: Record<string, unknown>[] = [];

  for (const m of markets) {
    if (m.kind === "binary") {
      const mb = m as MarketBinary;
      const yb = deps.bookMgr.get(mb.yesTokenId);
      const nb = deps.bookMgr.get(mb.noTokenId);
      const ayp = yb && isFinite(yb.bestAskPrice) ? yb.bestAskPrice : null;
      const anp = nb && isFinite(nb.bestAskPrice) ? nb.bestAskPrice : null;
      const byp = yb && isFinite(yb.bestBidPrice) ? yb.bestBidPrice : null;
      const bnp = nb && isFinite(nb.bestBidPrice) ? nb.bestBidPrice : null;
      marketData.push({
        name: mb.name,
        kind: "binary",
        askYes: ayp,
        bidYes: byp,
        askNo: anp,
        bidNo: bnp,
        gap: ayp !== null && anp !== null ? +((ayp + anp - 1) * 100).toFixed(3) : null,
        spreadYes: ayp !== null && byp !== null ? +((ayp - byp) * 100).toFixed(2) : null,
        spreadNo: anp !== null && bnp !== null ? +((anp - bnp) * 100).toFixed(2) : null,
        yesAge: yb ? Date.now() - yb.lastUpdatedMs : null,
        noAge: nb ? Date.now() - nb.lastUpdatedMs : null,
      });
    } else {
      const mm = m as MarketMulti;
      const outcomes: Record<string, unknown>[] = [];
      let sumAsks = 0;
      let allFresh = true;
      for (const o of mm.outcomes) {
        const b = deps.bookMgr.get(o.tokenId);
        if (b && isFinite(b.bestAskPrice)) {
          sumAsks += b.bestAskPrice;
          const bid = isFinite(b.bestBidPrice) ? b.bestBidPrice : null;
          outcomes.push({
            label: o.label,
            ask: b.bestAskPrice,
            bid,
            spread: bid !== null ? +((b.bestAskPrice - bid) * 100).toFixed(2) : null,
            age: Date.now() - b.lastUpdatedMs,
          });
        } else {
          allFresh = false;
          outcomes.push({ label: o.label, ask: null, bid: null });
        }
      }
      marketData.push({
        name: mm.name,
        kind: "multi",
        outcomes,
        sumAsks: allFresh ? +(sumAsks * 100).toFixed(2) : null,
        gap: allFresh ? +((sumAsks - 1) * 100).toFixed(3) : null,
      });
    }
  }

  return {
    timestamp: Date.now(),
    mode: deps.mode,
    health: healthStatus,
    metrics: metricsSnap,
    scan: {
      cycle: snap.cycle,
      freshBooks: snap.freshBooks,
      totalTokenIds: snap.totalTokenIds,
      opps: snap.oppsThisCycle,
      qualified: snap.qualifiedThisCycle,
      lastOpp: snap.lastOpp,
      marketGaps: snap.marketGaps,
    },
    markets: marketData,
  };
}

/* ---- Dashboard HTML (self-contained SPA) ---- */

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PolyArb Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
<style>
  :root {
    --bg: #0d1117; --card: #161b22; --border: #30363d;
    --text: #e6edf3; --dim: #8b949e; --accent: #58a6ff;
    --green: #3fb950; --red: #f85149; --yellow: #d29922;
    --blue: #58a6ff;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace; font-size: 14px; }
  .container { max-width: 1400px; margin: 0 auto; padding: 16px; }

  /* Header */
  .header { display: flex; align-items: center; justify-content: space-between; padding: 16px 0; border-bottom: 1px solid var(--border); margin-bottom: 16px; }
  .header h1 { font-size: 22px; font-weight: 600; }
  .header h1 span { color: var(--accent); }
  .status-pill { padding: 4px 12px; border-radius: 12px; font-size: 12px; font-weight: 600; text-transform: uppercase; }
  .status-pill.healthy { background: rgba(63,185,80,0.15); color: var(--green); border: 1px solid var(--green); }
  .status-pill.unhealthy { background: rgba(248,81,73,0.15); color: var(--red); border: 1px solid var(--red); }

  /* KPI Cards */
  .kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 20px; }
  .kpi { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  .kpi .label { color: var(--dim); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
  .kpi .value { font-size: 24px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .kpi .unit { font-size: 12px; color: var(--dim); margin-left: 4px; }
  .kpi .sub { color: var(--dim); font-size: 11px; margin-top: 2px; }

  /* Charts */
  .charts { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 20px; }
  .chart-card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  .chart-card h3 { font-size: 13px; color: var(--dim); margin-bottom: 10px; text-transform: uppercase; letter-spacing: 0.5px; }
  .chart-card canvas { width: 100% !important; height: 200px !important; }

  /* Market table */
  .table-card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 20px; overflow-x: auto; }
  .table-card h3 { font-size: 13px; color: var(--dim); margin-bottom: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; color: var(--dim); font-weight: 600; padding: 8px 12px; border-bottom: 1px solid var(--border); font-size: 11px; text-transform: uppercase; }
  td { padding: 8px 12px; border-bottom: 1px solid var(--border); font-variant-numeric: tabular-nums; }
  tr:hover td { background: rgba(88,166,255,0.04); }
  .gap-negative { color: var(--green); font-weight: 700; }
  .gap-close { color: var(--yellow); }
  .gap-far { color: var(--dim); }

  /* Log */
  .log-card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  .log-card h3 { font-size: 13px; color: var(--dim); margin-bottom: 10px; text-transform: uppercase; letter-spacing: 0.5px; }
  .log-entries { max-height: 200px; overflow-y: auto; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 12px; line-height: 1.6; }
  .log-entry { padding: 2px 0; color: var(--dim); }
  .log-entry .ts { color: var(--blue); }
  .log-entry.opp { color: var(--green); font-weight: 600; }

  /* Footer */
  .footer { text-align: center; padding: 16px 0; color: var(--dim); font-size: 11px; }

  @media (max-width: 800px) {
    .charts { grid-template-columns: 1fr; }
    .kpi-grid { grid-template-columns: repeat(2, 1fr); }
  }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>⚡ <span>PolyArb</span> Dashboard</h1>
    <div>
      <span id="mode-badge" class="status-pill">—</span>
      <span id="health-badge" class="status-pill">—</span>
    </div>
  </div>

  <div class="kpi-grid">
    <div class="kpi"><div class="label">Uptime</div><div class="value" id="kpi-uptime">—</div></div>
    <div class="kpi"><div class="label">Scan Cycles</div><div class="value" id="kpi-cycles">—</div></div>
    <div class="kpi"><div class="label">Fresh Books</div><div class="value" id="kpi-books">—</div><div class="sub" id="kpi-books-sub"></div></div>
    <div class="kpi"><div class="label">Opportunities</div><div class="value" id="kpi-opps">—</div></div>
    <div class="kpi"><div class="label">Trades</div><div class="value" id="kpi-trades">—</div><div class="sub" id="kpi-trades-sub"></div></div>
    <div class="kpi"><div class="label">Closest Arb Gap</div><div class="value" id="kpi-gap">—</div><div class="sub" id="kpi-gap-sub"></div></div>
    <div class="kpi"><div class="label">Memory</div><div class="value" id="kpi-mem">—</div><div class="sub">MB</div></div>
    <div class="kpi"><div class="label">Loop Speed</div><div class="value" id="kpi-loop">—</div><div class="sub">ms</div></div>
  </div>

  <div class="charts">
    <div class="chart-card">
      <h3>Arb Gap History (closest market, %)</h3>
      <canvas id="chart-gap"></canvas>
    </div>
    <div class="chart-card">
      <h3>Fresh Books / Cycle</h3>
      <canvas id="chart-books"></canvas>
    </div>
  </div>

  <div class="table-card">
    <h3>📊 Market Overview — sorted by arb gap (closest first)</h3>
    <table>
      <thead>
        <tr>
          <th>Market</th>
          <th>Kind</th>
          <th>Ask YES</th>
          <th>Ask NO</th>
          <th>Gap %</th>
          <th>Spread YES</th>
          <th>Spread NO</th>
          <th>Age (s)</th>
        </tr>
      </thead>
      <tbody id="market-tbody"></tbody>
    </table>
  </div>

  <div class="log-card">
    <h3>📝 Event Log</h3>
    <div class="log-entries" id="log-entries"></div>
  </div>

  <div class="footer">PolyArb Bot — Refreshing every 5s</div>
</div>

<script>
const MAX_HISTORY = 120; // 120 data points = ~10 min at 5s poll
const gapHistory = [];
const bookHistory = [];
const timeLabels = [];
const logEntries = [];

// Chart.js config
Chart.defaults.color = '#8b949e';
Chart.defaults.borderColor = '#30363d';

const gapChart = new Chart(document.getElementById('chart-gap'), {
  type: 'line',
  data: {
    labels: timeLabels,
    datasets: [{
      label: 'Gap %',
      data: gapHistory,
      borderColor: '#58a6ff',
      backgroundColor: 'rgba(88,166,255,0.1)',
      fill: true,
      tension: 0.3,
      pointRadius: 0,
      borderWidth: 2,
    }, {
      label: 'Break-even (0%)',
      data: [],
      borderColor: '#3fb950',
      borderDash: [5, 5],
      borderWidth: 1,
      pointRadius: 0,
    }]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    scales: {
      x: { display: false },
      y: { title: { display: true, text: 'Gap %' }, grid: { color: '#21262d' } }
    },
    plugins: { legend: { display: false } }
  }
});

const bookChart = new Chart(document.getElementById('chart-books'), {
  type: 'line',
  data: {
    labels: timeLabels,
    datasets: [{
      label: 'Fresh Books',
      data: bookHistory,
      borderColor: '#3fb950',
      backgroundColor: 'rgba(63,185,80,0.1)',
      fill: true,
      tension: 0.3,
      pointRadius: 0,
      borderWidth: 2,
    }]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    scales: {
      x: { display: false },
      y: { title: { display: true, text: 'Count' }, grid: { color: '#21262d' }, beginAtZero: true }
    },
    plugins: { legend: { display: false } }
  }
});

function fmtUptime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return h + 'h ' + m + 'm';
  if (m > 0) return m + 'm ' + (s % 60) + 's';
  return s + 's';
}

function gapClass(g) {
  if (g === null) return 'gap-far';
  if (g < 0) return 'gap-negative';
  if (g < 2) return 'gap-close';
  return 'gap-far';
}

function addLog(msg, cls) {
  const ts = new Date().toLocaleTimeString();
  logEntries.unshift({ ts, msg, cls: cls || '' });
  if (logEntries.length > 50) logEntries.pop();
  const el = document.getElementById('log-entries');
  el.innerHTML = logEntries.map(e =>
    '<div class="log-entry ' + e.cls + '"><span class="ts">' + e.ts + '</span> ' + e.msg + '</div>'
  ).join('');
}

let lastCycle = 0;

async function poll() {
  try {
    const res = await fetch('/api/status');
    const d = await res.json();

    // Health
    const hb = document.getElementById('health-badge');
    hb.textContent = d.health.healthy ? 'Healthy' : 'Unhealthy';
    hb.className = 'status-pill ' + (d.health.healthy ? 'healthy' : 'unhealthy');

    const mb = document.getElementById('mode-badge');
    mb.textContent = d.mode.toUpperCase();
    mb.className = 'status-pill healthy';

    // KPIs
    document.getElementById('kpi-uptime').textContent = fmtUptime(d.metrics.uptimeMs);
    document.getElementById('kpi-cycles').textContent = d.metrics['counter.scan_cycles'] || 0;
    document.getElementById('kpi-books').textContent = d.scan.freshBooks + '/' + d.scan.totalTokenIds;
    document.getElementById('kpi-books-sub').textContent = Math.round(d.scan.freshBooks / Math.max(d.scan.totalTokenIds,1) * 100) + '% fresh';
    document.getElementById('kpi-opps').textContent = d.metrics['counter.opportunities_found'] || 0;
    const st = d.metrics['counter.successful_trades'] || 0;
    const ft = d.metrics['counter.failed_trades'] || 0;
    document.getElementById('kpi-trades').textContent = st;
    document.getElementById('kpi-trades-sub').textContent = ft > 0 ? ft + ' failed' : 'none failed';
    document.getElementById('kpi-mem').textContent = d.health.memoryMB || d.metrics['gauge.memory_mb'] || '—';
    document.getElementById('kpi-loop').textContent = d.health.lastLoopMs || '—';

    // Closest gap — filter out nulls before sorting
    const gaps = (d.scan.marketGaps || []).filter(g => g.gap !== null && g.gap !== undefined);
    const sorted = gaps.slice().sort((a,b) => a.gap - b.gap);
    const closest = sorted[0];
    if (closest && closest.gap !== null) {
      document.getElementById('kpi-gap').innerHTML = '<span class="' + gapClass(closest.gap) + '">' + closest.gap.toFixed(2) + '%</span>';
      document.getElementById('kpi-gap-sub').textContent = closest.market;
    } else {
      document.getElementById('kpi-gap').textContent = '—';
      document.getElementById('kpi-gap-sub').textContent = 'no data';
    }

    // Charts
    const now = new Date().toLocaleTimeString();
    timeLabels.push(now);
    gapHistory.push(closest ? closest.gap : null);
    bookHistory.push(d.scan.freshBooks);

    if (timeLabels.length > MAX_HISTORY) {
      timeLabels.shift();
      gapHistory.shift();
      bookHistory.shift();
    }

    // Zero line for gap chart
    gapChart.data.datasets[1].data = gapHistory.map(() => 0);
    gapChart.update('none');
    bookChart.update('none');

    // Market table
    const mkts = (d.markets || []).slice().sort((a,b) => {
      const ga = a.gap ?? 999;
      const gb = b.gap ?? 999;
      return ga - gb;
    });

    const tbody = document.getElementById('market-tbody');
    tbody.innerHTML = mkts.map(m => {
      if (m.kind === 'binary') {
        const ageMax = Math.max(m.yesAge || 0, m.noAge || 0);
        return '<tr>'
          + '<td>' + m.name + '</td>'
          + '<td>Binary</td>'
          + '<td>' + (m.askYes !== null ? m.askYes.toFixed(3) : '—') + '</td>'
          + '<td>' + (m.askNo !== null ? m.askNo.toFixed(3) : '—') + '</td>'
          + '<td class="' + gapClass(m.gap) + '">' + (m.gap !== null ? m.gap.toFixed(2) + '%' : '—') + '</td>'
          + '<td>' + (m.spreadYes !== null ? m.spreadYes.toFixed(1) + '%' : '—') + '</td>'
          + '<td>' + (m.spreadNo !== null ? m.spreadNo.toFixed(1) + '%' : '—') + '</td>'
          + '<td>' + (ageMax ? (ageMax / 1000).toFixed(1) : '—') + '</td>'
          + '</tr>';
      } else {
        const outStr = (m.outcomes || []).map(o => o.label + ': ' + (o.ask !== null ? o.ask.toFixed(3) : '?')).join(', ');
        return '<tr>'
          + '<td>' + m.name + '</td>'
          + '<td>Multi (' + (m.outcomes || []).length + ')</td>'
          + '<td colspan="2" style="font-size:11px;color:var(--dim)">' + outStr + '</td>'
          + '<td class="' + gapClass(m.gap) + '">' + (m.gap !== null ? m.gap.toFixed(2) + '%' : '—') + '</td>'
          + '<td>—</td><td>—</td>'
          + '<td>—</td>'
          + '</tr>';
      }
    }).join('');

    // Log events
    if (d.scan.cycle > lastCycle && lastCycle > 0) {
      addLog('Cycle ' + d.scan.cycle + ' — ' + d.scan.freshBooks + ' books, ' + d.scan.opps + ' raw opps');
      if (d.scan.qualified > 0) {
        addLog('🎯 ' + d.scan.qualified + ' qualified opportunities!', 'opp');
      }
    }
    lastCycle = d.scan.cycle;

    if (d.scan.lastOpp && d.scan.lastOpp.marketName && d.scan.lastOpp.expectedProfit != null) {
      addLog('💰 Opp: ' + d.scan.lastOpp.marketName + ' — ' + (d.scan.lastOpp.expectedProfit * 100).toFixed(2) + '% profit', 'opp');
    }

  } catch (err) {
    addLog('⚠️ Fetch error: ' + err.message);
  }
}

// Initial + interval
poll();
setInterval(poll, 5000);
</script>
</body>
</html>`;
