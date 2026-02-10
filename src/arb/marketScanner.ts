/**
 * Market Scanner — Gamma API-powered market discovery.
 *
 * Targets inefficient markets by scanning the Polymarket Gamma API
 * for negRisk multi-outcome events and mispriced binary markets.
 *
 * Strategy:
 *   1. NegRisk multi-outcome events (5-30+ outcomes)
 *      — Inefficiency arises because MMs can't cover every tail outcome
 *      — Sum-of-asks often deviates from $1.00
 *   2. Low/medium liquidity binary markets ($5K-$200K)
 *      — Sweet spot: enough to trade, not efficiently priced
 *   3. High-volatility / recently-created markets
 *      — News events create temporary mispricings
 */

import pino from "pino";
import { type Market, type MarketBinary, type MarketMulti } from "../config/schema.js";

const logger = pino({ name: "scanner" });

const GAMMA_BASE = "https://gamma-api.polymarket.com";
const PAGE_SIZE = 50;

/* ------------------------------------------------------------------ */
/*  Gamma API response types                                          */
/* ------------------------------------------------------------------ */

export interface GammaMarket {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  outcomes: string;            // JSON-encoded: '["Yes","No"]' or '["Outcome1","Outcome2",...]'
  outcomePrices: string;       // JSON-encoded: '[0.55,0.45]'
  clobTokenIds: string;        // JSON-encoded: '["tok1","tok2"]'
  active: boolean;
  closed: boolean;
  enableOrderBook: boolean;
  acceptingOrders: boolean;
  liquidityNum: number;
  volumeNum: number;
  volume24hr: number;
  spread: number;
  bestBid: number;
  bestAsk: number;
  oneHourPriceChange: number;
  groupItemTitle: string;
  negRisk: boolean;
  negRiskMarketID: string;
}

export interface GammaEvent {
  id: string;
  title: string;
  slug: string;
  active: boolean;
  closed: boolean;
  liquidity: number;
  volume: number;
  enableNegRisk: boolean;
  negRiskMarketID: string;
  markets: GammaMarket[];
}

/* ------------------------------------------------------------------ */
/*  Scoring                                                           */
/* ------------------------------------------------------------------ */

export interface ScoringWeights {
  multiOutcomeBonus: number;
  negRiskBonus: number;
  lowLiquidityBonus: number;
  mediumLiquidityBonus: number;
  volumeBonus: number;
  volatilityBonus: number;
  tightGapBonus: number;
  wideSpreadBonus: number;
  newMarketBonus: number;
}

const DEFAULT_WEIGHTS: ScoringWeights = {
  multiOutcomeBonus: 30,
  negRiskBonus: 25,
  lowLiquidityBonus: 20,
  mediumLiquidityBonus: 15,
  volumeBonus: 10,
  volatilityBonus: 15,
  tightGapBonus: 40,
  wideSpreadBonus: 10,
  newMarketBonus: 10,
};

export interface ScoredCandidate {
  market: Market;
  score: number;
  reasons: string[];
  eventTitle: string;
  liquidityUsd: number;
  volume24h: number;
  spread: number;
  outcomeCount: number;
  negRisk: boolean;
  sumAsks: number | null;       // For multi-outcome: sum of best asks
  gapPct: number | null;        // 1 - sumAsks  (positive = arb opportunity)
}

/* ------------------------------------------------------------------ */
/*  Scanner config                                                    */
/* ------------------------------------------------------------------ */

export interface ScannerConfig {
  intervalMs: number;
  minLiquidityUsd: number;
  maxLiquidityUsd?: number;
  includeNegRisk?: boolean;
  includeBinary?: boolean;
  minScore?: number;
  maxOutcomes?: number;
  weights?: Partial<ScoringWeights>;
}

/* ------------------------------------------------------------------ */
/*  Scoring functions                                                 */
/* ------------------------------------------------------------------ */

function scoreEvent(
  event: GammaEvent,
  w: ScoringWeights,
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const mkts = event.markets.filter((m) => m.active && !m.closed && m.enableOrderBook && m.acceptingOrders);
  const outcomeCount = mkts.length;

  // Multi-outcome bonus (more outcomes = more inefficiency potential)
  if (outcomeCount >= 5) {
    const bonus = Math.min(w.multiOutcomeBonus, w.multiOutcomeBonus * (outcomeCount / 20));
    score += bonus;
    reasons.push(`${outcomeCount} outcomes (+${bonus.toFixed(0)})`);
  }

  // NegRisk bonus
  if (event.enableNegRisk) {
    score += w.negRiskBonus;
    reasons.push(`negRisk (+${w.negRiskBonus})`);
  }

  // Liquidity zone scoring
  const liq = event.liquidity ?? 0;
  if (liq >= 5_000 && liq < 50_000) {
    score += w.lowLiquidityBonus;
    reasons.push(`low-liq $${(liq / 1000).toFixed(0)}K (+${w.lowLiquidityBonus})`);
  } else if (liq >= 50_000 && liq < 200_000) {
    score += w.mediumLiquidityBonus;
    reasons.push(`med-liq $${(liq / 1000).toFixed(0)}K (+${w.mediumLiquidityBonus})`);
  }

  // Volume bonus (recent activity = real market)
  const vol24h = mkts.reduce((s, m) => s + (m.volume24hr ?? 0), 0);
  if (vol24h > 5_000) {
    const bonus = Math.min(w.volumeBonus, w.volumeBonus * (vol24h / 50_000));
    score += bonus;
    reasons.push(`vol24h $${(vol24h / 1000).toFixed(0)}K (+${bonus.toFixed(0)})`);
  }

  // Volatility bonus (high 1h price change signals mispricings)
  const maxVolatility = Math.max(...mkts.map((m) => Math.abs(m.oneHourPriceChange ?? 0)));
  if (maxVolatility > 0.03) {
    const bonus = Math.min(w.volatilityBonus, w.volatilityBonus * (maxVolatility / 0.1));
    score += bonus;
    reasons.push(`volatile ${(maxVolatility * 100).toFixed(1)}% (+${bonus.toFixed(0)})`);
  }

  // Wide spread bonus (indicates inefficiency)
  const avgSpread = mkts.reduce((s, m) => s + (m.spread ?? 0), 0) / (mkts.length || 1);
  if (avgSpread > 0.03) {
    const bonus = Math.min(w.wideSpreadBonus, w.wideSpreadBonus * (avgSpread / 0.1));
    score += bonus;
    reasons.push(`spread ${(avgSpread * 100).toFixed(1)}% (+${bonus.toFixed(0)})`);
  }

  return { score, reasons };
}

/* ------------------------------------------------------------------ */
/*  MarketScanner class                                               */
/* ------------------------------------------------------------------ */

export class MarketScanner {
  private readonly cfg: Required<ScannerConfig>;
  private readonly weights: ScoringWeights;
  private timer: ReturnType<typeof setInterval> | null = null;
  private onDiscovery: ((markets: Market[]) => void) | null = null;

  constructor(cfg: ScannerConfig) {
    this.cfg = {
      intervalMs: cfg.intervalMs,
      minLiquidityUsd: cfg.minLiquidityUsd,
      maxLiquidityUsd: cfg.maxLiquidityUsd ?? 500_000,
      includeNegRisk: cfg.includeNegRisk ?? true,
      includeBinary: cfg.includeBinary ?? true,
      minScore: cfg.minScore ?? 25,
      maxOutcomes: cfg.maxOutcomes ?? 60,
      weights: cfg.weights ?? {},
    };
    this.weights = { ...DEFAULT_WEIGHTS, ...cfg.weights };
  }

  /* ---------- Lifecycle ---------- */

  start(onDiscovery: (markets: Market[]) => void): void {
    this.onDiscovery = onDiscovery;
    logger.info({ intervalMs: this.cfg.intervalMs }, "MarketScanner started");

    // Run immediately, then on interval
    void this.runScan();
    this.timer = setInterval(() => void this.runScan(), this.cfg.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info("MarketScanner stopped");
  }

  /* ---------- Core scan ---------- */

  async scan(): Promise<ScoredCandidate[]> {
    const events = await this.fetchAllEvents();
    const candidates: ScoredCandidate[] = [];

    for (const event of events) {
      const activeMkts = event.markets.filter(
        (m) => m.active && !m.closed && m.enableOrderBook && m.acceptingOrders,
      );
      if (activeMkts.length === 0) continue;

      // NegRisk multi-outcome events
      if (event.enableNegRisk && this.cfg.includeNegRisk && activeMkts.length >= 3) {
        const multi = this.negRiskEventToMultiMarket(event, activeMkts);
        if (!multi) continue;
        if (multi.market.outcomes.length > this.cfg.maxOutcomes) continue;

        const { score, reasons } = scoreEvent(event, this.weights);

        // Gap bonus — closer to arb threshold = higher score
        if (multi.gapPct !== null && multi.gapPct > -0.06) {
          const gapBonus = Math.min(
            this.weights.tightGapBonus,
            this.weights.tightGapBonus * Math.max(0, 1 - Math.abs(multi.gapPct) / 0.06),
          );
          if (gapBonus > 0) {
            reasons.push(`gap ${(multi.gapPct * 100).toFixed(2)}% (+${gapBonus.toFixed(0)})`);
          }
          const totalScore = score + gapBonus;

          if (totalScore >= this.cfg.minScore) {
            candidates.push({
              market: multi.market,
              score: totalScore,
              reasons,
              eventTitle: event.title,
              liquidityUsd: event.liquidity,
              volume24h: activeMkts.reduce((s, m) => s + (m.volume24hr ?? 0), 0),
              spread: activeMkts.reduce((s, m) => s + (m.spread ?? 0), 0) / activeMkts.length,
              outcomeCount: multi.market.outcomes.length,
              negRisk: true,
              sumAsks: multi.sumAsks,
              gapPct: multi.gapPct,
            });
          }
        }
      }

      // Binary markets (non-negRisk, or individual markets within events)
      if (this.cfg.includeBinary) {
        for (const mkt of activeMkts) {
          if (mkt.negRisk) continue; // already handled above
          const binary = this.gammaMarketToBinary(mkt);
          if (!binary) continue;

          let score = 0;
          const reasons: string[] = [];

          // Liquidity zone
          const liq = mkt.liquidityNum ?? 0;
          if (liq >= 5_000 && liq < 50_000) {
            score += this.weights.lowLiquidityBonus;
            reasons.push(`low-liq $${(liq / 1000).toFixed(0)}K`);
          } else if (liq >= 50_000 && liq < 200_000) {
            score += this.weights.mediumLiquidityBonus;
            reasons.push(`med-liq $${(liq / 1000).toFixed(0)}K`);
          }

          // Spread score (wider = more opportunity)
          if (mkt.spread > 0.03) {
            const bonus = Math.min(this.weights.wideSpreadBonus, this.weights.wideSpreadBonus * (mkt.spread / 0.1));
            score += bonus;
            reasons.push(`spread ${(mkt.spread * 100).toFixed(1)}%`);
          }

          // Volatility
          if (Math.abs(mkt.oneHourPriceChange ?? 0) > 0.03) {
            score += this.weights.volatilityBonus;
            reasons.push(`volatile ${((mkt.oneHourPriceChange ?? 0) * 100).toFixed(1)}%`);
          }

          // Volume
          if ((mkt.volume24hr ?? 0) > 1_000) {
            const bonus = Math.min(this.weights.volumeBonus, this.weights.volumeBonus * (mkt.volume24hr / 20_000));
            score += bonus;
            reasons.push(`vol24h $${(mkt.volume24hr / 1000).toFixed(1)}K`);
          }

          // Gap estimate from outcomePrices
          const gap = this.estimateBinaryGap(mkt);
          if (gap !== null && gap > -0.06) {
            const gapBonus = Math.min(
              this.weights.tightGapBonus,
              this.weights.tightGapBonus * Math.max(0, 1 - Math.abs(gap) / 0.06),
            );
            if (gapBonus > 0) {
              score += gapBonus;
              reasons.push(`gap ${(gap * 100).toFixed(2)}%`);
            }
          }

          if (score >= this.cfg.minScore) {
            candidates.push({
              market: binary,
              score,
              reasons,
              eventTitle: event.title,
              liquidityUsd: mkt.liquidityNum,
              volume24h: mkt.volume24hr,
              spread: mkt.spread,
              outcomeCount: 2,
              negRisk: false,
              sumAsks: gap !== null ? 1 - gap : null,
              gapPct: gap,
            });
          }
        }
      }
    }

    // Sort by score descending
    candidates.sort((a, b) => b.score - a.score);
    return candidates;
  }

  private async runScan(): Promise<void> {
    try {
      const candidates = await this.scan();
      if (candidates.length === 0) {
        logger.info("No candidates found this scan cycle");
        return;
      }

      logger.info({ count: candidates.length, top: candidates[0].eventTitle }, "Scan complete");

      // Extract markets for discovery callback
      const newMarkets = candidates.map((c) => c.market);
      if (this.onDiscovery) {
        this.onDiscovery(newMarkets);
      }
    } catch (err) {
      logger.error({ err }, "Scan failed");
    }
  }

  /* ---------- Gamma API fetching ---------- */

  private async fetchAllEvents(): Promise<GammaEvent[]> {
    const allEvents: GammaEvent[] = [];
    let offset = 0;
    let keepGoing = true;

    while (keepGoing) {
      const url = new URL(`${GAMMA_BASE}/events`);
      url.searchParams.set("closed", "false");
      url.searchParams.set("active", "true");
      url.searchParams.set("limit", String(PAGE_SIZE));
      url.searchParams.set("offset", String(offset));
      url.searchParams.set("order", "liquidity");
      url.searchParams.set("ascending", "false");

      const resp = await fetch(url.toString());
      if (!resp.ok) {
        logger.error({ status: resp.status }, "Gamma API error");
        break;
      }

      const events: GammaEvent[] = await resp.json() as GammaEvent[];
      if (events.length === 0) break;

      for (const ev of events) {
        const liq = ev.liquidity ?? 0;
        if (liq < this.cfg.minLiquidityUsd) {
          keepGoing = false;
          break;
        }
        if (liq <= this.cfg.maxLiquidityUsd) {
          allEvents.push(ev);
        }
      }

      offset += PAGE_SIZE;
      if (events.length < PAGE_SIZE) break;

      // Safety cap — never fetch more than 20 pages
      if (offset >= PAGE_SIZE * 20) break;
    }

    logger.info({ events: allEvents.length, pages: Math.ceil(offset / PAGE_SIZE) }, "Events fetched from Gamma");
    return allEvents;
  }

  /* ---------- Converters ---------- */

  /**
   * Converts a negRisk event into a MarketMulti.
   *
   * Each binary market in a negRisk event represents one outcome.
   * We extract the YES tokenId from each binary market to form the
   * multi-outcome market.
   */
  negRiskEventToMultiMarket(
    event: GammaEvent,
    activeMkts: GammaMarket[],
  ): { market: MarketMulti; sumAsks: number; gapPct: number } | null {
    try {
      const outcomes: { label: string; tokenId: string }[] = [];
      let sumAsks = 0;

      for (const mkt of activeMkts) {
        // Parse JSON-encoded fields
        const tokenIds: string[] = JSON.parse(mkt.clobTokenIds || "[]");
        const outcomeLabels: string[] = JSON.parse(mkt.outcomes || "[]");
        const prices: number[] = JSON.parse(mkt.outcomePrices || "[]");

        if (tokenIds.length < 1 || outcomeLabels.length < 1) continue;

        // YES token is always index 0, NO is index 1
        const yesTokenId = tokenIds[0];
        const label = mkt.groupItemTitle || outcomeLabels[0] || mkt.question;

        // Best ask for YES outcome: use bestAsk if available, else use outcomePrices[0]
        // For the ask price, we need the complement: if bestBid for YES = 0.05,
        // then bestAsk for YES ≈ bestBid + spread ≈ price + spread
        // But simpler: outcomePrices[0] is the last trade / mid price.
        // We use bestAsk directly if > 0, otherwise estimate from price + half spread
        let askYes = mkt.bestAsk > 0 ? mkt.bestAsk : (prices[0] ?? 0);
        if (askYes <= 0 && prices.length >= 1) {
          askYes = prices[0] + (mkt.spread ?? 0) / 2;
        }

        outcomes.push({ label, tokenId: yesTokenId });
        sumAsks += askYes;
      }

      if (outcomes.length < 3) return null;

      const gapPct = 1 - sumAsks; // positive = sum < 1 (potential arb)

      const market: MarketMulti = {
        name: event.title,
        kind: "multi",
        outcomes,
        conditionId: event.negRiskMarketID || undefined,
      };

      return { market, sumAsks, gapPct };
    } catch (err) {
      logger.warn({ event: event.title, err }, "Failed to convert negRisk event");
      return null;
    }
  }

  /**
   * Convert a Gamma binary market into our MarketBinary format.
   */
  private gammaMarketToBinary(mkt: GammaMarket): MarketBinary | null {
    try {
      const tokenIds: string[] = JSON.parse(mkt.clobTokenIds || "[]");
      if (tokenIds.length < 2) return null;

      return {
        name: mkt.question,
        kind: "binary",
        yesTokenId: tokenIds[0],
        noTokenId: tokenIds[1],
        conditionId: mkt.conditionId || undefined,
      };
    } catch {
      return null;
    }
  }

  /**
   * Estimate the gap for a binary market.
   * gap = 1 - (askYes + askNo)
   * positive = sum < 1 = potential arb
   */
  private estimateBinaryGap(mkt: GammaMarket): number | null {
    try {
      const prices: number[] = JSON.parse(mkt.outcomePrices || "[]");
      if (prices.length < 2) return null;

      // prices are mid-prices; estimate asks by adding half the spread
      const halfSpread = (mkt.spread ?? 0) / 2;
      const askYes = prices[0] + halfSpread;
      const askNo = prices[1] + halfSpread;
      return 1 - (askYes + askNo);
    } catch {
      return null;
    }
  }

  /* ---------- Preview (for CLI) ---------- */

  /**
   * One-shot scan that returns formatted results for CLI output.
   * Does not trigger discovery callbacks.
   */
  async preview(): Promise<ScoredCandidate[]> {
    return this.scan();
  }

  /**
   * Format scan results for CLI display.
   */
  static formatPreview(candidates: ScoredCandidate[]): string {
    if (candidates.length === 0) {
      return "No candidates found. Try lowering minScore or expanding liquidity range.";
    }

    const lines: string[] = [
      "",
      "╔══════════════════════════════════════════════════════════════════════════╗",
      "║                     🔍 Market Scanner Results                          ║",
      "╠══════════════════════════════════════════════════════════════════════════╣",
      "",
    ];

    for (let i = 0; i < Math.min(candidates.length, 30); i++) {
      const c = candidates[i];
      const rank = String(i + 1).padStart(2);
      const typeIcon = c.negRisk ? "🎯" : "📊";
      const gapStr =
        c.gapPct !== null
          ? `gap: ${c.gapPct > 0 ? "+" : ""}${(c.gapPct * 100).toFixed(2)}%`
          : "gap: N/A";
      const sumStr = c.sumAsks !== null ? `Σasks: ${c.sumAsks.toFixed(4)}` : "";

      lines.push(
        `  ${rank}. ${typeIcon} [Score: ${c.score.toFixed(0)}] ${c.eventTitle}`,
      );
      lines.push(
        `      ${c.outcomeCount} outcomes | liq: $${fmtUsd(c.liquidityUsd)} | vol24h: $${fmtUsd(c.volume24h)} | spread: ${(c.spread * 100).toFixed(1)}%`,
      );
      lines.push(`      ${gapStr}  ${sumStr}`);
      lines.push(`      → ${c.reasons.join(", ")}`);

      if (c.market.kind === "multi") {
        const preview = c.market.outcomes
          .slice(0, 5)
          .map((o) => o.label)
          .join(", ");
        const more = c.market.outcomes.length > 5 ? ` +${c.market.outcomes.length - 5} more` : "";
        lines.push(`      Outcomes: ${preview}${more}`);
      }

      lines.push("");
    }

    if (candidates.length > 30) {
      lines.push(`  ... and ${candidates.length - 30} more candidates`);
      lines.push("");
    }

    lines.push(
      "╚══════════════════════════════════════════════════════════════════════════╝",
    );
    return lines.join("\n");
  }
}

/* ---------- Helpers ---------- */

function fmtUsd(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}
