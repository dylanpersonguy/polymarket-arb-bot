/**
 * Cross-Event Arbitrage Detector
 *
 * Detects arbitrage opportunities between correlated markets from different events.
 * Example: "Will Trump win?" in Event A at 0.55 YES, while "Trump wins" in Event B at 0.40 YES
 *
 * Strategy: buy cheap YES in Event B, sell expensive YES in Event A (or buy NO in A).
 * This is a statistical arb that profits when correlated markets converge.
 */
import type { OrderBook } from "../clob/types.js";
import type { Market, MarketBinary } from "../config/schema.js";

export interface CrossEventPair {
  marketA: string;
  marketB: string;
  tokenIdA: string;
  tokenIdB: string;
  /** Price divergence in percentage points */
  divergencePct: number;
  /** Which side is cheaper */
  cheapSide: "A" | "B";
  /** Strategy: buy cheap, sell expensive */
  buyToken: string;
  sellToken: string;
  buyPrice: number;
  sellPrice: number;
  /** Estimated profit after fees */
  estimatedProfitPct: number;
}

/**
 * Find potential cross-event arb pairs based on name similarity.
 * Groups markets by their underlying subject (fuzzy matching).
 */
export function findCorrelatedMarkets(markets: Market[]): Map<string, MarketBinary[]> {
  const groups = new Map<string, MarketBinary[]>();

  const binaryMarkets = markets.filter((m): m is MarketBinary => m.kind === "binary");

  for (const market of binaryMarkets) {
    // Extract key subject from market name
    const key = extractSubject(market.name);
    if (!key) continue;

    const existing = groups.get(key) ?? [];
    existing.push(market);
    groups.set(key, existing);
  }

  // Only keep groups with 2+ markets (potential cross-event pairs)
  for (const [key, mkts] of groups) {
    if (mkts.length < 2) groups.delete(key);
  }

  return groups;
}

/**
 * Extract the subject/entity from a market name for fuzzy grouping.
 * "Will Trump win the election?" → "trump"
 * "Trump presidential nominee" → "trump"
 */
function extractSubject(name: string): string | null {
  const normalized = name.toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // Common entities to look for
  const words = normalized.split(" ");

  // Use the first capitalized proper noun or longest significant word
  const stopWords = new Set([
    "will", "the", "be", "a", "an", "in", "on", "at", "to", "for",
    "of", "by", "with", "from", "is", "are", "was", "were", "has",
    "have", "had", "do", "does", "did", "can", "could", "would",
    "should", "may", "might", "shall", "yes", "no", "win", "lose",
    "before", "after", "above", "below", "over", "under",
  ]);

  const significantWords = words.filter(w => w.length > 3 && !stopWords.has(w));
  if (significantWords.length === 0) return null;

  // Use first 2 significant words as the grouping key
  return significantWords.slice(0, 2).join("_");
}

/**
 * Detect cross-event arbitrage opportunities.
 * Compares YES prices across correlated markets.
 */
export function detectCrossEventArbs(
  correlatedGroups: Map<string, MarketBinary[]>,
  books: Map<string, OrderBook>,
  feeBps: number,
  minDivergencePct = 5.0
): CrossEventPair[] {
  const pairs: CrossEventPair[] = [];

  for (const [_group, markets] of correlatedGroups) {
    // Compare all pairs within the group
    for (let i = 0; i < markets.length; i++) {
      for (let j = i + 1; j < markets.length; j++) {
        const mktA = markets[i];
        const mktB = markets[j];

        const bookA = books.get(mktA.yesTokenId);
        const bookB = books.get(mktB.yesTokenId);

        if (!bookA || !bookB) continue;

        // Compare YES prices
        const priceA = bookA.bestAskPrice;
        const priceB = bookB.bestAskPrice;

        const divergencePct = Math.abs(priceA - priceB) * 100;

        if (divergencePct < minDivergencePct) continue;

        // Fee cost for round-trip
        const feeCostPct = (feeBps / 10_000) * 100 * 2; // buy + sell
        const estimatedProfitPct = divergencePct - feeCostPct;

        if (estimatedProfitPct <= 0) continue;

        const cheapSide = priceA < priceB ? "A" : "B";
        const buyToken = cheapSide === "A" ? mktA.yesTokenId : mktB.yesTokenId;
        const sellToken = cheapSide === "A" ? mktB.yesTokenId : mktA.yesTokenId;
        const buyPrice = cheapSide === "A" ? priceA : priceB;
        const sellPrice = cheapSide === "A" ? priceB : priceA;

        pairs.push({
          marketA: mktA.name,
          marketB: mktB.name,
          tokenIdA: mktA.yesTokenId,
          tokenIdB: mktB.yesTokenId,
          divergencePct: +divergencePct.toFixed(2),
          cheapSide,
          buyToken,
          sellToken,
          buyPrice,
          sellPrice,
          estimatedProfitPct: +estimatedProfitPct.toFixed(2),
        });
      }
    }
  }

  // Sort by estimated profit descending
  return pairs.sort((a, b) => b.estimatedProfitPct - a.estimatedProfitPct);
}
