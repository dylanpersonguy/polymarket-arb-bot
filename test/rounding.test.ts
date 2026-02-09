import { describe, it, expect } from "vitest";
import { roundPrice, roundPriceUp, roundPriceDown, adjustPriceByTicks, clampPrice } from "../src/exec/rounding";

describe("Price Rounding", () => {
  describe("Round Price", () => {
    it("rounds to nearest tick", () => {
      expect(roundPrice(0.5037, 0.0001)).toBeCloseTo(0.5037, 4);
      expect(roundPrice(0.50375, 0.0001)).toBeCloseTo(0.5038, 4);
    });

    it("handles very small numbers", () => {
      expect(roundPrice(0.0001, 0.0001)).toBeCloseTo(0.0001, 4);
    });
  });

  describe("Round Price Up", () => {
    it("rounds up to next tick", () => {
      expect(roundPriceUp(0.50375, 0.0001)).toBeCloseTo(0.5038, 4);
    });

    it("returns same if already on tick", () => {
      expect(roundPriceUp(0.5037, 0.0001)).toBeCloseTo(0.5037, 4);
    });
  });

  describe("Round Price Down", () => {
    it("rounds down to previous tick", () => {
      expect(roundPriceDown(0.50375, 0.0001)).toBeCloseTo(0.5037, 4);
    });
  });

  describe("Adjust Price By Ticks", () => {
    it("moves price up", () => {
      const adjusted = adjustPriceByTicks(0.5, 10, 0.0001);
      expect(adjusted).toBeCloseTo(0.501, 4);
    });

    it("moves price down", () => {
      const adjusted = adjustPriceByTicks(0.5, -10, 0.0001);
      expect(adjusted).toBeCloseTo(0.499, 4);
    });
  });

  describe("Clamp Price", () => {
    it("clamps above 1", () => {
      expect(clampPrice(1.5)).toBe(1);
    });

    it("clamps below 0", () => {
      expect(clampPrice(-0.1)).toBe(0);
    });

    it("returns same for valid prices", () => {
      expect(clampPrice(0.5)).toBe(0.5);
    });
  });
});
