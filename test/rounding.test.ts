import { describe, it, expect } from "vitest";
import {
  roundPrice,
  roundPriceUp,
  roundPriceDown,
  adjustByTicks,
  clamp,
  TICK,
  MIN_PRICE,
  MAX_PRICE,
} from "../src/exec/rounding.js";

describe("rounding", () => {
  describe("TICK constant", () => {
    it("is 0.01", () => {
      expect(TICK).toBe(0.01);
    });
  });

  describe("roundPrice (nearest)", () => {
    it("rounds 0.455 → 0.46", () => {
      expect(roundPrice(0.455)).toBeCloseTo(0.46, 4);
    });

    it("rounds 0.444 → 0.44", () => {
      expect(roundPrice(0.444)).toBeCloseTo(0.44, 4);
    });

    it("leaves exact tick values unchanged", () => {
      expect(roundPrice(0.50)).toBeCloseTo(0.50, 4);
    });

    it("clamps below MIN_PRICE", () => {
      expect(roundPrice(0.001)).toBe(MIN_PRICE);
    });

    it("clamps above MAX_PRICE", () => {
      expect(roundPrice(0.999)).toBe(MAX_PRICE);
    });
  });

  describe("roundPriceUp", () => {
    it("rounds 0.451 up → 0.46", () => {
      expect(roundPriceUp(0.451)).toBeCloseTo(0.46, 4);
    });

    it("exact value stays same", () => {
      expect(roundPriceUp(0.45)).toBeCloseTo(0.45, 4);
    });
  });

  describe("roundPriceDown", () => {
    it("rounds 0.459 down → 0.45", () => {
      expect(roundPriceDown(0.459)).toBeCloseTo(0.45, 4);
    });

    it("exact value stays same", () => {
      expect(roundPriceDown(0.45)).toBeCloseTo(0.45, 4);
    });
  });

  describe("adjustByTicks", () => {
    it("adds ticks", () => {
      const result = adjustByTicks(0.50, 3);
      expect(result).toBeCloseTo(0.53, 4);
    });

    it("subtracts ticks", () => {
      const result = adjustByTicks(0.50, -2);
      expect(result).toBeCloseTo(0.48, 4);
    });

    it("zero ticks = identity", () => {
      expect(adjustByTicks(0.50, 0)).toBeCloseTo(0.50, 4);
    });
  });

  describe("clamp", () => {
    it("clamps below MIN_PRICE", () => {
      expect(clamp(0.005)).toBe(MIN_PRICE);
    });

    it("clamps above MAX_PRICE", () => {
      expect(clamp(1.50)).toBe(MAX_PRICE);
    });

    it("passes through valid values", () => {
      expect(clamp(0.50)).toBe(0.50);
    });
  });

  describe("MIN_PRICE / MAX_PRICE", () => {
    it("MIN is 0.01", () => {
      expect(MIN_PRICE).toBe(0.01);
    });

    it("MAX is 0.99", () => {
      expect(MAX_PRICE).toBe(0.99);
    });
  });
});
