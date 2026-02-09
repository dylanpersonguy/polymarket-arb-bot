import { ComplementOpportunity } from "./complement.js";
import { MultiOutcomeOpportunity } from "./multiOutcome.js";

export type Opportunity = ComplementOpportunity | MultiOutcomeOpportunity;

export function isComplementOpportunity(opp: Opportunity): opp is ComplementOpportunity {
  return opp.type === "binary_complement";
}

export function isMultiOutcomeOpportunity(opp: Opportunity): opp is MultiOutcomeOpportunity {
  return opp.type === "multi_outcome";
}

export function oppToString(opp: Opportunity): string {
  if (isComplementOpportunity(opp)) {
    return `${opp.marketName}: ${opp.expectedProfitBps.toFixed(0)}bps (YES ${opp.askYes.toFixed(3)} + NO ${opp.askNo.toFixed(3)})`;
  } else {
    const prices = opp.outcomes.map((o) => `${o.label}:${o.ask.toFixed(3)}`).join(", ");
    return `${opp.marketName}: ${opp.expectedProfitBps.toFixed(0)}bps (${prices})`;
  }
}
