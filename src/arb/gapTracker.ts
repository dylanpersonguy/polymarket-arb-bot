/**
 * Adaptive Gap Tracker — learns which markets produce arbs most often.
 *
 * Tracks historical gap frequencies per market and uses them to:
 *  1. Prioritize book fetching order (fetch hot markets first)
 *  2. Score scanner candidates by historical profitability
 *  3. Auto-disable markets that never produce gaps
 */

export interface GapRecord {
  market: string;
  /** Number of times gap was close to profitable (within 50bps) */
  nearMisses: number;
  /** Number of profitable gaps detected */
  profitableGaps: number;
  /** Best gap seen (most negative = closest to arb) */
  bestGapPct: number;
  /** Average gap over observation window */
  avgGapPct: number;
  /** Timestamps of recent profitable gaps */
  recentProfitableAt: number[];
  /** Last time a gap was observed */
  lastSeenAt: number;
  /** Computed priority score (higher = more promising) */
  priorityScore: number;
}

interface GapSample {
  timestamp: number;
  gapPct: number;
}

export class GapTracker {
  private records = new Map<string, {
    samples: GapSample[];
    nearMisses: number;
    profitableGaps: number;
    bestGapPct: number;
    recentProfitableAt: number[];
  }>();

  /** Max samples per market */
  private readonly maxSamples = 500;
  /** Near-miss threshold: gap within this % of being profitable */
  private readonly nearMissThresholdPct = 0.5;
  /** How long to keep recent profitable timestamps (1 hour) */
  private readonly recentWindowMs = 3_600_000;

  /**
   * Record an observed gap for a market.
   * @param market Market name
   * @param gapPct Gap in percentage (negative = below 1.0 = profitable)
   */
  recordGap(market: string, gapPct: number): void {
    let rec = this.records.get(market);
    if (!rec) {
      rec = { samples: [], nearMisses: 0, profitableGaps: 0, bestGapPct: Infinity, recentProfitableAt: [] };
      this.records.set(market, rec);
    }

    const now = Date.now();
    rec.samples.push({ timestamp: now, gapPct });
    if (rec.samples.length > this.maxSamples) rec.samples.shift();

    if (gapPct < rec.bestGapPct) rec.bestGapPct = gapPct;

    if (gapPct <= 0) {
      rec.profitableGaps++;
      rec.recentProfitableAt.push(now);
    } else if (gapPct <= this.nearMissThresholdPct) {
      rec.nearMisses++;
    }

    // Prune old timestamps
    const cutoff = now - this.recentWindowMs;
    rec.recentProfitableAt = rec.recentProfitableAt.filter(t => t >= cutoff);
  }

  /**
   * Get all market records sorted by priority score (highest first).
   * Use this to prioritize book fetch order.
   */
  getScored(): GapRecord[] {
    const results: GapRecord[] = [];
    const now = Date.now();

    for (const [market, rec] of this.records) {
      const samples = rec.samples;
      if (samples.length === 0) continue;

      const avgGapPct = samples.reduce((s, r) => s + r.gapPct, 0) / samples.length;
      const lastSeenAt = samples[samples.length - 1].timestamp;

      // Priority score formula:
      // - Recent profitable gaps are weighted heavily (10 pts each)
      // - Near misses get 3 pts each
      // - Lower average gap = higher score
      // - Recency bonus: more recent = higher score
      const recentProfitable = rec.recentProfitableAt.filter(t => t >= now - this.recentWindowMs).length;
      const recencyBonus = Math.max(0, 10 - (now - lastSeenAt) / 60_000); // decays over 10 minutes
      const gapBonus = Math.max(0, 5 - avgGapPct * 10); // lower gap = higher bonus

      const priorityScore = +(
        recentProfitable * 10 +
        rec.nearMisses * 3 +
        gapBonus +
        recencyBonus
      ).toFixed(1);

      results.push({
        market,
        nearMisses: rec.nearMisses,
        profitableGaps: rec.profitableGaps,
        bestGapPct: +rec.bestGapPct.toFixed(3),
        avgGapPct: +avgGapPct.toFixed(3),
        recentProfitableAt: rec.recentProfitableAt,
        lastSeenAt,
        priorityScore,
      });
    }

    return results.sort((a, b) => b.priorityScore - a.priorityScore);
  }

  /**
   * Return market names sorted by priority (hot markets first).
   * Used to reorder the book fetch sequence.
   */
  getPrioritizedMarkets(): string[] {
    return this.getScored().map(r => r.market);
  }

  /**
   * Get summary stats for dashboard display.
   */
  getSummary(): { totalMarkets: number; hotMarkets: number; avgBestGap: number } {
    const scored = this.getScored();
    const hotMarkets = scored.filter(r => r.priorityScore > 10).length;
    const avgBestGap = scored.length > 0
      ? scored.reduce((s, r) => s + r.bestGapPct, 0) / scored.length
      : 0;
    return { totalMarkets: scored.length, hotMarkets, avgBestGap: +avgBestGap.toFixed(3) };
  }

  /** Prune markets with no recent activity */
  prune(maxAgeMs = 3_600_000): void {
    const cutoff = Date.now() - maxAgeMs;
    for (const [market, rec] of this.records) {
      if (rec.samples.length === 0 || rec.samples[rec.samples.length - 1].timestamp < cutoff) {
        this.records.delete(market);
      }
    }
  }
}
