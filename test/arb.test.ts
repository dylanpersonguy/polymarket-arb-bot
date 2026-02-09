import { describe, it, expect, beforeEach } from "vitest";
import {
  computeCostBreakdown,
  isProfitable,
  computeOptimalSize,
  computeVwap,
  computeCostBreakdownVwap,
  isSpreadAcceptable,
  TICK_SIZE,
} from "../src/arb/math.js";
import { detectBinaryComplementArb, ComplementDetectorConfig } from "../src/arb/complement.js";
import { detectMultiOutcomeArb, MultiDetectorConfig } from "../src/arb/multiOutcome.js";
import { filterByMinProfitBps, sortByProfit, bestOpportunity, OppCooldownTracker, filterSuppressed } from "../src/arb/filters.js";
import { isComplement, isMultiOutcome, oppTokenIds } from "../src/arb/opportunity.js";
import { OrderBook } from "../src/clob/types.js";

import fixtureRaw from "./fixtures/book.json";

function freshBook(book: Omit<OrderBook, "lastUpdatedMs">): OrderBook {
  return { ...book, lastUpdatedMs: Date.now() } as OrderBook;
}

/* ================================================================
 * computeCostBreakdown
 * ================================================================ */
describe("computeCostBreakdown", () => {
  it("returns zero profit when ask sum ≥ 1.0", () => {
    const result = computeCostBreakdown([0.55, 0.50], 5, 5);
    expect(result.expectedProfit).toBeLessThanOrEqual(0);
  });

  it("computes correct profit for cheap ask pair", () => {
    const result = computeCostBreakdown([0.45, 0.50], 0, 0);
    expect(result.totalCost).toBeCloseTo(0.95, 4);
    expect(result.expectedProfit).toBeCloseTo(0.05, 4);
    expect(result.expectedProfitBps).toBeCloseTo(500, 0);
  });

  it("subtracts fee and slippage", () => {
    const result = computeCostBreakdown([0.45, 0.50], 50, 10);
    expect(result.feeCost).toBeGreaterThan(0);
    expect(result.slippageCost).toBeGreaterThan(0);
    expect(result.allInCost).toBeGreaterThan(result.totalCost);
    expect(result.expectedProfit).toBeLessThan(0.05);
  });

  it("works with 3 or more outcomes", () => {
    const result = computeCostBreakdown([0.30, 0.30, 0.30], 0, 0);
    expect(result.totalCost).toBeCloseTo(0.90, 4);
    expect(result.expectedProfit).toBeCloseTo(0.10, 4);
  });
});

/* ================================================================
 * isProfitable
 * ================================================================ */
describe("isProfitable", () => {
  it("returns true when profit exceeds threshold", () => {
    expect(isProfitable([0.45, 0.50], 0, 0, 0.01)).toBe(true);
  });

  it("returns false when costs eat all profit", () => {
    expect(isProfitable([0.49, 0.50], 500, 0, 0.01)).toBe(false);
  });

  it("returns false when sum ≥ 1.0", () => {
    expect(isProfitable([0.50, 0.51], 0, 0, 0.001)).toBe(false);
  });
});

/* ================================================================
 * computeVwap  (#1)
 * ================================================================ */
describe("computeVwap", () => {
  it("returns correct VWAP for single level", () => {
    const { vwap, fillableSize } = computeVwap([{ price: 0.50, size: 100 }], 50);
    expect(vwap).toBeCloseTo(0.50, 4);
    expect(fillableSize).toBe(50);
  });

  it("walks multiple levels", () => {
    const levels = [
      { price: 0.50, size: 100 },
      { price: 0.52, size: 100 },
    ];
    const { vwap, fillableSize } = computeVwap(levels, 150);
    // 100×0.50 + 50×0.52 = 76 / 150 = 0.5067
    expect(vwap).toBeCloseTo(50 / 150 + 26 / 150, 3);
    expect(fillableSize).toBe(150);
  });

  it("returns partial fill when book is thin", () => {
    const levels = [{ price: 0.50, size: 30 }];
    const { vwap, fillableSize } = computeVwap(levels, 100);
    expect(fillableSize).toBe(30);
    expect(vwap).toBeCloseTo(0.50, 4);
  });

  it("returns zero for empty book", () => {
    const { vwap, fillableSize } = computeVwap([], 10);
    expect(vwap).toBe(0);
    expect(fillableSize).toBe(0);
  });
});

/* ================================================================
 * computeCostBreakdownVwap  (#1)
 * ================================================================ */
describe("computeCostBreakdownVwap", () => {
  it("returns VWAP prices and fillable sizes", () => {
    const asksA = [{ price: 0.47, size: 300 }, { price: 0.48, size: 200 }];
    const asksB = [{ price: 0.51, size: 250 }, { price: 0.52, size: 200 }];
    const result = computeCostBreakdownVwap([asksA, asksB], 100, 0, 0);

    expect(result.vwapPrices.length).toBe(2);
    expect(result.fillableSizes.length).toBe(2);
    expect(result.vwapPrices[0]).toBeCloseTo(0.47, 2); // only hits first level
    expect(result.vwapPrices[1]).toBeCloseTo(0.51, 2);
    expect(result.expectedProfit).toBeCloseTo(0.02, 2);
  });
});

/* ================================================================
 * isSpreadAcceptable  (#8)
 * ================================================================ */
describe("isSpreadAcceptable", () => {
  it("accepts tight spread", () => {
    expect(isSpreadAcceptable(0.50, 0.49, 500)).toBe(true);
  });

  it("rejects wide spread", () => {
    // spread = (0.50 - 0.30) / 0.50 = 40% = 4000 bps
    expect(isSpreadAcceptable(0.50, 0.30, 500)).toBe(false);
  });

  it("rejects zero ask", () => {
    expect(isSpreadAcceptable(0, 0, 500)).toBe(false);
  });
});

/* ================================================================
 * computeOptimalSize (#5 Kelly fix)
 * ================================================================ */
describe("computeOptimalSize", () => {
  it("returns 0 when not profitable", () => {
    const sz = computeOptimalSize([0.55, 0.50], [100, 100], 0, 0, 200, 5000);
    expect(sz).toBe(0);
  });

  it("caps at smallest book side", () => {
    const sz = computeOptimalSize([0.45, 0.50], [50, 200], 0, 0, 10000, 50000);
    expect(sz).toBeLessThanOrEqual(50);
  });

  it("caps at per-market max", () => {
    const sz = computeOptimalSize([0.45, 0.50], [10000, 10000], 0, 0, 200, 50000);
    expect(sz * 0.50).toBeLessThanOrEqual(200 + 0.01);
  });

  it("returns positive size for profitable arb", () => {
    const sz = computeOptimalSize([0.45, 0.50], [500, 500], 5, 5, 500, 5000);
    expect(sz).toBeGreaterThan(0);
  });

  it("Kelly: larger bankroll → larger size", () => {
    const szSmall = computeOptimalSize([0.45, 0.50], [5000, 5000], 0, 0, 50000, 50000, 500, 0.25);
    const szLarge = computeOptimalSize([0.45, 0.50], [5000, 5000], 0, 0, 50000, 50000, 5000, 0.25);
    expect(szLarge).toBeGreaterThan(szSmall);
  });

  it("Kelly: smaller fraction → smaller size", () => {
    const szBig = computeOptimalSize([0.45, 0.50], [5000, 5000], 0, 0, 50000, 50000, 1000, 0.5);
    const szSmall = computeOptimalSize([0.45, 0.50], [5000, 5000], 0, 0, 50000, 50000, 1000, 0.1);
    expect(szBig).toBeGreaterThan(szSmall);
  });
});

/* ================================================================
 * TICK_SIZE constant
 * ================================================================ */
describe("TICK_SIZE", () => {
  it("is 0.01 for Polymarket", () => {
    expect(TICK_SIZE).toBe(0.01);
  });
});

/* ================================================================
 * detectBinaryComplementArb (updated with spread filter + VWAP)
 * ================================================================ */
describe("detectBinaryComplementArb", () => {
  const baseCfg: ComplementDetectorConfig = {
    feeBps: 0,
    slippageBps: 0,
    minProfit: 0.001,
    maxExposureUsd: 5000,
    perMarketMaxUsd: 500,
    minTopSizeUsd: 1,
    stalenessMs: 5000,
  };

  it("detects arb when ask sum < 1.0", () => {
    const yes = freshBook(fixtureRaw.yesBook);
    const no = freshBook(fixtureRaw.noBook);
    const opp = detectBinaryComplementArb("TestMarket", yes, no, baseCfg);
    expect(opp).not.toBeNull();
    expect(opp!.type).toBe("binary_complement");
    expect(opp!.expectedProfit).toBeGreaterThan(0);
    expect(opp!.targetSizeShares).toBeGreaterThan(0);
  });

  it("returns null when asks are stale", () => {
    const yes: OrderBook = { ...fixtureRaw.yesBook, lastUpdatedMs: Date.now() - 10_000 } as OrderBook;
    const no = freshBook(fixtureRaw.noBook);
    const opp = detectBinaryComplementArb("TestMarket", yes, no, { ...baseCfg, stalenessMs: 5000 });
    expect(opp).toBeNull();
  });

  it("returns null when ask sum ≥ 1.0", () => {
    const yes = freshBook({ ...fixtureRaw.yesBook, bestAskPrice: 0.55 });
    const no = freshBook({ ...fixtureRaw.noBook, bestAskPrice: 0.50 });
    const opp = detectBinaryComplementArb("TestMarket", yes, no, baseCfg);
    expect(opp).toBeNull();
  });

  it("returns null for null books", () => {
    const opp = detectBinaryComplementArb("TestMarket", null, null, baseCfg);
    expect(opp).toBeNull();
  });

  it("#8 rejects wide spread legs", () => {
    const yes = freshBook({ ...fixtureRaw.yesBook, bestAskPrice: 0.47, bestBidPrice: 0.10 });
    const no = freshBook(fixtureRaw.noBook);
    const opp = detectBinaryComplementArb("TestMarket", yes, no, { ...baseCfg, maxSpreadBps: 100 });
    expect(opp).toBeNull();
  });

  it("#1 VWAP revalidation shrinks size to fillable", () => {
    // With small book depth, VWAP should limit size
    const yes = freshBook({ ...fixtureRaw.yesBook, asks: [{ price: 0.47, size: 10 }] });
    const no = freshBook({ ...fixtureRaw.noBook, asks: [{ price: 0.51, size: 10 }] });
    const opp = detectBinaryComplementArb("TestMarket", yes, no, {
      ...baseCfg,
      useBookDepthForDetection: true,
      maxExposureUsd: 50000,
      perMarketMaxUsd: 50000,
      bankrollUsd: 50000,
    });
    if (opp) {
      expect(opp.targetSizeShares).toBeLessThanOrEqual(10);
    }
  });

  it("uses takerFeeBps when provided", () => {
    const yes = freshBook(fixtureRaw.yesBook);
    const no = freshBook(fixtureRaw.noBook);
    // High fee should kill profitability
    const opp = detectBinaryComplementArb("TestMarket", yes, no, {
      ...baseCfg,
      feeBps: 0,
      takerFeeBps: 2000, // 20% fee
    });
    expect(opp).toBeNull();
  });
});

/* ================================================================
 * detectMultiOutcomeArb
 * ================================================================ */
describe("detectMultiOutcomeArb", () => {
  const baseCfg: MultiDetectorConfig = {
    feeBps: 0,
    slippageBps: 0,
    minProfit: 0.001,
    maxExposureUsd: 5000,
    perMarketMaxUsd: 500,
    minTopSizeUsd: 1,
    stalenessMs: 5000,
  };

  it("detects arb when sum of asks < 1.0", () => {
    const books = new Map<string, OrderBook>();
    const labels = new Map<string, string>();

    for (const b of fixtureRaw.multiBooks) {
      books.set(b.tokenId, freshBook(b as Omit<OrderBook, "lastUpdatedMs">));
      labels.set(b.tokenId, b.tokenId);
    }

    const opp = detectMultiOutcomeArb("MultiMarket", books, labels, baseCfg);
    expect(opp).not.toBeNull();
    expect(opp!.type).toBe("multi_outcome");
    expect(opp!.legs.length).toBe(3);
    expect(opp!.expectedProfit).toBeGreaterThan(0);
  });

  it("returns null when sum of asks ≥ 1.0", () => {
    const books = new Map<string, OrderBook>();
    const labels = new Map<string, string>();

    books.set("a", freshBook({ tokenId: "a", bestBidPrice: 0.40, bestBidSize: 100, bestAskPrice: 0.41, bestAskSize: 100, bids: [{ price: 0.40, size: 100 }], asks: [{ price: 0.41, size: 100 }] }));
    books.set("b", freshBook({ tokenId: "b", bestBidPrice: 0.60, bestBidSize: 100, bestAskPrice: 0.61, bestAskSize: 100, bids: [{ price: 0.60, size: 100 }], asks: [{ price: 0.61, size: 100 }] }));
    labels.set("a", "A");
    labels.set("b", "B");

    const opp = detectMultiOutcomeArb("Expensive", books, labels, baseCfg);
    expect(opp).toBeNull();
  });

  it("#8 rejects wide spread legs", () => {
    const books = new Map<string, OrderBook>();
    const labels = new Map<string, string>();

    for (const b of fixtureRaw.multiBooks) {
      books.set(b.tokenId, freshBook({
        ...b,
        bestBidPrice: 0.01, // very wide spread
      } as Omit<OrderBook, "lastUpdatedMs">));
      labels.set(b.tokenId, b.tokenId);
    }

    const opp = detectMultiOutcomeArb("Wide", books, labels, { ...baseCfg, maxSpreadBps: 100 });
    expect(opp).toBeNull();
  });
});

/* ================================================================
 * filters + OppCooldownTracker (#11)
 * ================================================================ */
describe("filters", () => {
  it("filterByMinProfitBps removes below-threshold", () => {
    const yes = freshBook(fixtureRaw.yesBook);
    const no = freshBook(fixtureRaw.noBook);
    const opp = detectBinaryComplementArb("Market", yes, no, {
      feeBps: 0, slippageBps: 0, minProfit: 0.001,
      maxExposureUsd: 5000, perMarketMaxUsd: 500, minTopSizeUsd: 1, stalenessMs: 5000,
    })!;

    expect(opp).not.toBeNull();

    const kept = filterByMinProfitBps([opp], 100);
    expect(kept.length).toBe(1);

    const dropped = filterByMinProfitBps([opp], 100_000);
    expect(dropped.length).toBe(0);
  });

  it("bestOpportunity picks highest profit", () => {
    const a = freshBook(fixtureRaw.yesBook);
    const b = freshBook(fixtureRaw.noBook);
    const opp1 = detectBinaryComplementArb("M1", a, b, {
      feeBps: 0, slippageBps: 0, minProfit: 0.001,
      maxExposureUsd: 5000, perMarketMaxUsd: 500, minTopSizeUsd: 1, stalenessMs: 5000,
    })!;

    const opp2 = detectBinaryComplementArb("M2", a, b, {
      feeBps: 100, slippageBps: 0, minProfit: 0.001,
      maxExposureUsd: 5000, perMarketMaxUsd: 500, minTopSizeUsd: 1, stalenessMs: 5000,
    })!;

    if (!opp2) {
      expect(bestOpportunity([opp1])).toBe(opp1);
    } else {
      const best = bestOpportunity([opp1, opp2]);
      expect(best).not.toBeNull();
      expect(best!.expectedProfitBps).toBeGreaterThanOrEqual(opp2.expectedProfitBps);
    }
  });
});

/* ================================================================
 * OppCooldownTracker  (#11)
 * ================================================================ */
describe("OppCooldownTracker", () => {
  it("suppresses recently recorded opps", () => {
    const tracker = new OppCooldownTracker(5000);
    const yes = freshBook(fixtureRaw.yesBook);
    const no = freshBook(fixtureRaw.noBook);
    const opp = detectBinaryComplementArb("M1", yes, no, {
      feeBps: 0, slippageBps: 0, minProfit: 0.001,
      maxExposureUsd: 5000, perMarketMaxUsd: 500, minTopSizeUsd: 1, stalenessMs: 5000,
    })!;

    expect(tracker.isSuppressed(opp)).toBe(false);
    tracker.record(opp);
    expect(tracker.isSuppressed(opp)).toBe(true);
  });

  it("filterSuppressed removes suppressed opps", () => {
    const tracker = new OppCooldownTracker(5000);
    const yes = freshBook(fixtureRaw.yesBook);
    const no = freshBook(fixtureRaw.noBook);
    const opp = detectBinaryComplementArb("M1", yes, no, {
      feeBps: 0, slippageBps: 0, minProfit: 0.001,
      maxExposureUsd: 5000, perMarketMaxUsd: 500, minTopSizeUsd: 1, stalenessMs: 5000,
    })!;

    tracker.record(opp);
    expect(filterSuppressed([opp], tracker)).toHaveLength(0);
  });

  it("reset clears all tracked keys", () => {
    const tracker = new OppCooldownTracker(5000);
    const yes = freshBook(fixtureRaw.yesBook);
    const no = freshBook(fixtureRaw.noBook);
    const opp = detectBinaryComplementArb("M1", yes, no, {
      feeBps: 0, slippageBps: 0, minProfit: 0.001,
      maxExposureUsd: 5000, perMarketMaxUsd: 500, minTopSizeUsd: 1, stalenessMs: 5000,
    })!;

    tracker.record(opp);
    tracker.reset();
    expect(tracker.isSuppressed(opp)).toBe(false);
  });
});

/* ================================================================
 * opportunity helpers
 * ================================================================ */
describe("opportunity helpers", () => {
  it("isComplement / isMultiOutcome type guards work", () => {
    const yes = freshBook(fixtureRaw.yesBook);
    const no = freshBook(fixtureRaw.noBook);
    const opp = detectBinaryComplementArb("M", yes, no, {
      feeBps: 0, slippageBps: 0, minProfit: 0.001,
      maxExposureUsd: 5000, perMarketMaxUsd: 500, minTopSizeUsd: 1, stalenessMs: 5000,
    })!;

    expect(isComplement(opp)).toBe(true);
    expect(isMultiOutcome(opp)).toBe(false);
  });

  it("oppTokenIds returns correct IDs", () => {
    const yes = freshBook(fixtureRaw.yesBook);
    const no = freshBook(fixtureRaw.noBook);
    const opp = detectBinaryComplementArb("M", yes, no, {
      feeBps: 0, slippageBps: 0, minProfit: 0.001,
      maxExposureUsd: 5000, perMarketMaxUsd: 500, minTopSizeUsd: 1, stalenessMs: 5000,
    })!;

    const ids = oppTokenIds(opp);
    expect(ids).toContain("yes-token-1");
    expect(ids).toContain("no-token-1");
  });
});
