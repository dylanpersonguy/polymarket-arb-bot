import { describe, it, expect } from "vitest";
import {
  calculateBinaryComplementCost,
  calculateMultiOutcomeCost,
  calculateExpectedProfit,
  isProfitable,
  usdToShares,
  sharesToUsd,
  calculateMaxLoss,
} from "../src/arb/math";

describe("Arbitrage Math", () => {
  describe("Binary Complement Cost", () => {
    it("calculates cost correctly", () => {
      const result = calculateBinaryComplementCost(0.48, 0.49, 5, 10);
      expect(result.totalCost).toBeCloseTo(0.97, 2);
      expect(result.feeCost).toBeGreaterThan(0);
      expect(result.slippageCost).toBeGreaterThan(0);
    });

    it("handles edge cases", () => {
      const result = calculateBinaryComplementCost(0.01, 0.01, 0, 0);
      expect(result.totalCost).toBeCloseTo(0.02, 2);
      expect(result.feeCost).toBe(0);
      expect(result.slippageCost).toBe(0);
    });
  });

  describe("Multi Outcome Cost", () => {
    it("sums prices correctly", () => {
      const result = calculateMultiOutcomeCost([0.25, 0.25, 0.25, 0.25], 5, 10);
      expect(result.totalCost).toBeCloseTo(1.0, 2);
      expect(result.feeCost).toBeGreaterThan(0);
    });
  });

  describe("Expected Profit", () => {
    it("calculates profit correctly", () => {
      const profit = calculateExpectedProfit(0.95, 0.005, 0.010);
      expect(profit).toBeGreaterThan(0);
      expect(profit).toBeLessThan(0.05);
    });

    it("returns negative for negative profit", () => {
      const profit = calculateExpectedProfit(1.02, 0.01, 0.01);
      expect(profit).toBeLessThan(0);
    });
  });

  describe("Profitability Check", () => {
    it("returns true for profitable arbs", () => {
      const profitable = isProfitable(0.96, 5, 10, 0.002);
      expect(profitable).toBe(true);
    });

    it("returns false for unprofitable arbs", () => {
      const profitable = isProfitable(1.01, 5, 10, 0.002);
      expect(profitable).toBe(false);
    });
  });

  describe("USD to Shares Conversion", () => {
    it("converts correctly at mid-price", () => {
      const shares = usdToShares(100, 0.5);
      expect(shares).toBe(200);
    });

    it("converts correctly at high price", () => {
      const shares = usdToShares(100, 0.9);
      expect(shares).toBeCloseTo(111.11, 1);
    });

    it("throws on invalid price", () => {
      expect(() => usdToShares(100, 1.5)).toThrow();
      expect(() => usdToShares(100, 0)).toThrow();
    });
  });

  describe("Shares to USD Conversion", () => {
    it("converts correctly", () => {
      const usd = sharesToUsd(200, 0.5);
      expect(usd).toBe(100);
    });
  });

  describe("Max Loss Calculation", () => {
    it("calculates max loss on entry", () => {
      const loss = calculateMaxLoss(100, 0.5, 0.3);
      expect(loss).toBeCloseTo(20, 1);
    });

    it("returns zero for same price", () => {
      const loss = calculateMaxLoss(100, 0.5, 0.5);
      expect(loss).toBe(0);
    });
  });
});
