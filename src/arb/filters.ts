import { Opportunity } from "./opportunity.js";

export function filterByProfit(opportunities: Opportunity[], minProfitBps: number): Opportunity[] {
  return opportunities.filter((opp) => opp.expectedProfitBps >= minProfitBps);
}

export function filterByMarketName(opportunities: Opportunity[], name: string): Opportunity[] {
  return opportunities.filter((opp) => opp.marketName === name);
}

export function filterByTokenId(
  opportunities: Opportunity[],
  tokenId: string
): Opportunity[] {
  return opportunities.filter((opp) => {
    if (opp.type === "binary_complement") {
      return opp.yesTokenId === tokenId || opp.noTokenId === tokenId;
    } else {
      return opp.outcomes.some((o) => o.tokenId === tokenId);
    }
  });
}

export function getBestOpportunity(opportunities: Opportunity[]): Opportunity | null {
  if (opportunities.length === 0) return null;
  return opportunities.reduce((best, current) =>
    current.expectedProfitBps > best.expectedProfitBps ? current : best
  );
}

export function aggregateTokenIds(opportunities: Opportunity[]): Set<string> {
  const tokenIds = new Set<string>();

  for (const opp of opportunities) {
    if (opp.type === "binary_complement") {
      tokenIds.add(opp.yesTokenId);
      tokenIds.add(opp.noTokenId);
    } else {
      for (const outcome of opp.outcomes) {
        tokenIds.add(outcome.tokenId);
      }
    }
  }

  return tokenIds;
}
