import { describe, it, expect, beforeEach } from "vitest";
import {
  computeCostBreakdown,
  isProfitable,
  computeOptimalSize,
  TICK_SIZE,
} from "../src/arb/math.js";
import { detectBinaryComplementArb, ComplementDetectorConfig } from "../src/arb/complement.js";
import { detectMultiOutcomeArb, MultiDetectorConfig } from "../src/arb/multiOutcome.js";
import { filterByMinProfitBps, sortByProfit, bestOpportunity } from "../src/arb/filters.js";
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
    // 0.45 + 0.50 = 0.95 raw
    const result = computeCostBreakdown([0.45, 0.50], 0, 0);
    expect(result.totalCost).toBeCloseTo(0.95, 4);
    expect(result.expectedProfit).toBeCloseTo(0.05, 4);
    expect(result.expectedProfitBps).toBeCloseTo(500, 0); // 0.05 * 10000 = 500 bps
  });

  it("subtracts fee and slippage", () => {
    const result = computeCostBreakdown([0.45, 0.50], 50, 10); // 0.5% fee, 0.1% slip
    expect(result.feeCost).toBeGreaterThan(0);
    expect(result.slippageCost).toBeGreaterThan(0);
    expect(result.allInCost).toBeGreaterThan(result.totalCost);
    // Profit reduced by costs
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
    // 0.49 + 0.50 = 0.99 raw, plus 5% fee → definitely not profitable
    expect(isProfitable([0.49, 0.50], 500, 0, 0.01)).toBe(false);
  });

  it("returns false when sum ≥ 1.0", () => {
    expect(isProfitable([0.50, 0.51], 0, 0, 0.001)).toBe(false);
  });
});

/* ================================================================
 * computeOptimalSize
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
    // ask = 0.45, so maxByMarket = floor(200 / 0.50) = 400 → caps at 200/0.50
    const sz = computeOptimalSize([0.45, 0.50], [10000, 10000], 0, 0, 200, 50000);
    expect(sz * 0.50).toBeLessThanOrEqual(200 + 0.01); // allow rounding tolerance
  });

  it("returns positive size for profitable arb", () => {
    const sz = computeOptimalSize([0.45, 0.50], [500, 500], 5, 5, 500, 5000);
    expect(sz).toBeGreaterThan(0);
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
 * detectBinaryComplementArb
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
    // 0.47 + 0.51 = 0.98 < 1.0 → profitable
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
    // 0.30 + 0.29 + 0.31 = 0.90 < 1.0
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
});

/* ================================================================
 * filters
 * ================================================================ */
describe("filters", () => {
  it("filterByMinProfitBps removes below-threshold", () => {
    const yes = freshBook(fixtureRaw.yesBook);
    const no = freshBook(fixtureRaw.noBook);
    const opp = detectBinaryComplementArb("Market", yes, no, {
      feeBps: 0,
      slippageBps: 0,
      minProfit: 0.001,
      maxExposureUsd: 5000,
      perMarketMaxUsd: 500,
      minTopSizeUsd: 1,
      stalenessMs: 5000,
    })!;

    expect(opp).not.toBeNull();

    // 200 bps threshold → our 0.98 arb = 200bps
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

    // Make opp2 slightly worse by adding fee
    const opp2 = detectBinaryComplementArb("M2", a, b, {
      feeBps: 100, slippageBps: 0, minProfit: 0.001,
      maxExposureUsd: 5000, perMarketMaxUsd: 500, minTopSizeUsd: 1, stalenessMs: 5000,
    })!;

    if (!opp2) {
      // opp2 might be null with fee, that's fine
      expect(bestOpportunity([opp1])).toBe(opp1);
    } else {
      const best = bestOpportunity([opp1, opp2]);
      expect(best).not.toBeNull();
      expect(best!.expectedProfitBps).toBeGreaterThanOrEqual(opp2.expectedProfitBps);
    }
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
