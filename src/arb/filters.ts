import { Opportunity } from "./opportunity.js";

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
