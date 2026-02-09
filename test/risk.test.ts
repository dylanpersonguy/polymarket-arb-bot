import { describe, it, expect, beforeEach } from "vitest";
import { RiskManager, RiskConfig } from "../src/exec/risk.js";

const baseCfg: RiskConfig = {
  maxExposureUsd: 500,
  perMarketMaxUsd: 150,
  dailyStopLossUsd: 100,
  maxOpenOrders: 5,
  cooldownMs: 1000,
  safeModeErrorThreshold: 3,
  perMarketCooldownMs: 2000,    // #10
  minBalanceUsd: 50,            // #12
};

describe("RiskManager", () => {
  let risk: RiskManager;

  beforeEach(() => {
    risk = new RiskManager(baseCfg);
  });

  describe("canTrade", () => {
    it("allows a normal trade", () => {
      const result = risk.canTrade("market-A", 50);
      expect(result.allowed).toBe(true);
    });

    it("blocks when global exposure exceeded", () => {
      risk.updateExposure("market-A", 490, 490);
      const result = risk.canTrade("market-A", 20);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("global exposure");
    });

    it("blocks when per-market exposure exceeded", () => {
      risk.updateExposure("market-A", 0, 140);
      const result = risk.canTrade("market-A", 20);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("per-market");
    });

    it("blocks when daily stop-loss reached", () => {
      risk.recordLoss(110);
      const result = risk.canTrade("market-A", 10);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("stop-loss");
    });

    it("#12 blocks when balance is below minimum", () => {
      risk.updateBalance(30); // below minBalanceUsd=50
      const result = risk.canTrade("market-A", 10);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Balance");
      expect(result.reason).toContain("below minimum");
    });

    it("#12 blocks when balance is insufficient for trade", () => {
      risk.updateBalance(100);
      const result = risk.canTrade("market-A", 200); // need 200, have 100
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Insufficient balance");
    });

    it("#12 allows when balance is sufficient", () => {
      risk.updateBalance(1000);
      const result = risk.canTrade("market-A", 50);
      expect(result.allowed).toBe(true);
    });
  });

  describe("maxOpenOrders", () => {
    it("blocks when max open orders reached", () => {
      for (let i = 0; i < 5; i++) risk.recordOrderPlaced();
      const result = risk.canTrade("market-A", 10);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("open orders");
    });

    it("allows after orders closed", () => {
      for (let i = 0; i < 5; i++) risk.recordOrderPlaced();
      risk.recordOrderClosed(3);
      const result = risk.canTrade("market-A", 10);
      expect(result.allowed).toBe(true);
    });
  });

  describe("cooldown", () => {
    it("blocks during global cooldown", () => {
      risk.activateCooldown();
      const result = risk.canTrade("market-A", 10);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("cooldown");
    });

    it("#10 blocks during per-market cooldown", () => {
      risk.activateMarketCooldown("market-A");
      const resultA = risk.canTrade("market-A", 10);
      expect(resultA.allowed).toBe(false);
      expect(resultA.reason).toContain("market-A");
      expect(resultA.reason).toContain("cooldown");

      // Other markets should not be blocked
      const resultB = risk.canTrade("market-B", 10);
      expect(resultB.allowed).toBe(true);
    });
  });

  describe("safe mode", () => {
    it("activates after consecutive errors exceed threshold", () => {
      expect(risk.isSafeMode()).toBe(false);

      risk.recordError();
      risk.recordError();
      risk.recordError();

      expect(risk.isSafeMode()).toBe(true);

      const result = risk.canTrade("market-A", 10);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Safe mode");
    });

    it("resets consecutive errors on success", () => {
      risk.recordError();
      risk.recordError();
      risk.recordSuccess();
      risk.recordError();

      expect(risk.isSafeMode()).toBe(false);
    });

    it("clearSafeMode resets safe mode", () => {
      risk.recordError();
      risk.recordError();
      risk.recordError();
      expect(risk.isSafeMode()).toBe(true);

      risk.clearSafeMode();
      expect(risk.isSafeMode()).toBe(false);
    });
  });

  describe("day roll", () => {
    it("resets daily loss on new UTC day", () => {
      risk.recordLoss(80);
      const state = risk.getState();
      expect(state.dailyLossUsd).toBe(80);

      risk.resetDaily();
      const after = risk.getState();
      expect(after.dailyLossUsd).toBe(0);
    });
  });

  describe("updateExposure", () => {
    it("tracks global and per-market exposure", () => {
      risk.updateExposure("market-A", 100, 100);
      risk.updateExposure("market-B", 50, 50);

      const state = risk.getState();
      expect(state.globalExposureUsd).toBe(150);
    });

    it("does not go below zero", () => {
      risk.updateExposure("market-A", -500, -500);
      const state = risk.getState();
      expect(state.globalExposureUsd).toBe(0);
    });
  });

  describe("balance tracking (#12)", () => {
    it("updateBalance stores the balance", () => {
      risk.updateBalance(1234);
      const state = risk.getState();
      expect(state.lastKnownBalanceUsd).toBe(1234);
    });
  });

  describe("reset", () => {
    it("clears all state including new fields", () => {
      risk.updateExposure("market-A", 200, 200);
      risk.recordLoss(50);
      risk.recordError();
      risk.activateMarketCooldown("market-A");
      risk.updateBalance(500);

      risk.reset();
      const state = risk.getState();
      expect(state.globalExposureUsd).toBe(0);
      expect(state.dailyLossUsd).toBe(0);
      expect(state.consecutiveErrors).toBe(0);
      expect(state.lastKnownBalanceUsd).toBe(Infinity);
    });
  });
});
