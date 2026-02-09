import { Opportunity, oppTokenIds } from "./opportunity.js";

/** Keep only opportunities above a profit threshold. */
export function filterByMinProfitBps(opps: Opportunity[], minBps: number): Opportunity[] {
  return opps.filter((o) => o.expectedProfitBps >= minBps);
}

/** Sort best-first. */
export function sortByProfit(opps: Opportunity[]): Opportunity[] {
  return [...opps].sort((a, b) => b.expectedProfitBps - a.expectedProfitBps);
}

/** Pick the single best opportunity. */
export function bestOpportunity(opps: Opportunity[]): Opportunity | null {
  if (opps.length === 0) return null;
  return opps.reduce((best, cur) => (cur.expectedProfitBps > best.expectedProfitBps ? cur : best));
}

/** Collect every tokenId referenced by a set of opportunities. */
export function collectTokenIds(opps: Opportunity[]): Set<string> {
  const ids = new Set<string>();
  for (const opp of opps) {
    if (opp.type === "binary_complement") {
      ids.add(opp.yesTokenId);
      ids.add(opp.noTokenId);
    } else {
      for (const leg of opp.legs) ids.add(leg.tokenId);
    }
  }
  return ids;
}

// ---------- #11: Duplicate / cooldown suppression ----------

/**
 * Tracks recently executed opportunity keys and prevents duplicates within
 * a configurable cooldown window.
 */
export class OppCooldownTracker {
  /** key -> timestamp of last execution */
  private recentKeys = new Map<string, number>();
  private readonly cooldownMs: number;

  constructor(cooldownMs: number) {
    this.cooldownMs = cooldownMs;
  }

  /** Build a dedup key from the token IDs in an opportunity. */
  static keyFor(opp: Opportunity): string {
    return oppTokenIds(opp).sort().join("|");
  }

  /** Returns true if this opp is on cooldown and should be suppressed. */
  isSuppressed(opp: Opportunity): boolean {
    const key = OppCooldownTracker.keyFor(opp);
    const last = this.recentKeys.get(key);
    if (last === undefined) return false;
    return Date.now() - last < this.cooldownMs;
  }

  /** Record that an opp was just executed. */
  record(opp: Opportunity): void {
    this.recentKeys.set(OppCooldownTracker.keyFor(opp), Date.now());
  }

  /** Purge entries older than 2× the cooldown (prevents memory leak). */
  prune(): void {
    const cutoff = Date.now() - this.cooldownMs * 2;
    for (const [key, ts] of this.recentKeys) {
      if (ts < cutoff) this.recentKeys.delete(key);
    }
  }

  /** Remove all tracked keys. */
  reset(): void {
    this.recentKeys.clear();
  }
}

/** Filter out opportunities that are on cooldown. */
export function filterSuppressed(opps: Opportunity[], tracker: OppCooldownTracker): Opportunity[] {
  return opps.filter((o) => !tracker.isSuppressed(o));
}
