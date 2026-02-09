import { describe, it, expect, beforeEach } from "vitest";
import { RiskManager } from "../src/exec/risk";

describe("Risk Manager", () => {
  let riskManager: RiskManager;

  beforeEach(() => {
    riskManager = new RiskManager({
      maxExposureUsd: 1000,
      perMarketMaxUsd: 300,
      dailyStopLossUsd: 200,
      cooldownMs: 5000,
    });
  });

  describe("Trade Permission", () => {
    it("allows trade under limits", () => {
      const check = riskManager.canTrade("BTC", 100);
      expect(check.allowed).toBe(true);
    });

    it("denies trade exceeding global exposure", () => {
      riskManager.updateExposure("BTC", 950, 0);
      const check = riskManager.canTrade("BTC", 100);
      expect(check.allowed).toBe(false);
      expect(check.reason).toContain("global");
    });

    it("denies trade exceeding per-market exposure", () => {
      riskManager.updateExposure("BTC", 200, 200);
      const check = riskManager.canTrade("BTC", 150);
      expect(check.allowed).toBe(false);
      expect(check.reason).toContain("per-market");
    });

    it("denies trade during cooldown", () => {
      riskManager.activateCooldown();
      const check = riskManager.canTrade("BTC", 50);
      expect(check.allowed).toBe(false);
      expect(check.reason).toContain("cooldown");
    });
  });

  describe("Exposure Tracking", () => {
    it("updates exposure correctly", () => {
      riskManager.updateExposure("BTC", 100, 100);
      let state = riskManager.getState();
      expect(state.globalExposureUsd).toBe(100);
      expect(state.perMarketExposureUsd.get("BTC")).toBe(100);

      riskManager.updateExposure("BTC", 50, 50);
      state = riskManager.getState();
      expect(state.globalExposureUsd).toBe(150);
      expect(state.perMarketExposureUsd.get("BTC")).toBe(150);
    });

    it("prevents negative exposure", () => {
      riskManager.updateExposure("BTC", 100, 100);
      riskManager.updateExposure("BTC", -200, -200);
      const state = riskManager.getState();
      expect(state.globalExposureUsd).toBe(0);
      expect(state.perMarketExposureUsd.get("BTC")).toBe(0);
    });
  });

  describe("Loss Tracking", () => {
    it("records losses", () => {
      riskManager.recordLoss(50);
      let state = riskManager.getState();
      expect(state.dailyLossUsd).toBe(50);

      riskManager.recordLoss(75);
      state = riskManager.getState();
      expect(state.dailyLossUsd).toBe(125);
    });

    it("prevents trading after daily stop loss", () => {
      riskManager.recordLoss(200);
      const check = riskManager.canTrade("BTC", 50);
      expect(check.allowed).toBe(false);
      expect(check.reason).toContain("stop loss");
    });
  });

  describe("Daily Reset", () => {
    it("resets daily loss", () => {
      riskManager.recordLoss(100);
      let state = riskManager.getState();
      expect(state.dailyLossUsd).toBe(100);

      riskManager.resetDaily();
      state = riskManager.getState();
      expect(state.dailyLossUsd).toBe(0);
    });
  });
});
