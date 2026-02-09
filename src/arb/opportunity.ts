import { ComplementOpportunity } from "./complement.js";
import { MultiOutcomeOpportunity } from "./multiOutcome.js";

export type Opportunity = ComplementOpportunity | MultiOutcomeOpportunity;

export function isComplement(opp: Opportunity): opp is ComplementOpportunity {
  return opp.type === "binary_complement";
}

export function isMultiOutcome(opp: Opportunity): opp is MultiOutcomeOpportunity {
  return opp.type === "multi_outcome";
}

export function oppSummary(opp: Opportunity): string {
  if (isComplement(opp)) {
    return `[COMP] ${opp.marketName}: +${opp.expectedProfitBps.toFixed(0)}bps  YES=${opp.askYes.toFixed(2)} NO=${opp.askNo.toFixed(2)}  size=${opp.targetSizeShares}`;
  }
  const legs = opp.legs.map((l) => `${l.label}=${l.askPrice.toFixed(2)}`).join(" ");
  return `[MULTI] ${opp.marketName}: +${opp.expectedProfitBps.toFixed(0)}bps  ${legs}  size=${opp.targetSizeShares}`;
}

/** All tokenIds involved in the opportunity (for book lookups, risk checks, etc.). */
export function oppTokenIds(opp: Opportunity): string[] {
  if (isComplement(opp)) return [opp.yesTokenId, opp.noTokenId];
  return opp.legs.map((l) => l.tokenId);
}
