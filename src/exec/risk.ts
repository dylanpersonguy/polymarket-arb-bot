import pino from "pino";

const logger = pino({ name: "RiskManager" });

export interface RiskState {
  globalExposureUsd: number;
  perMarketExposureUsd: Map<string, number>;
  openOrderCount: number;
  dailyLossUsd: number;
  lastTradeTimeMs: number;
  cooldownEndMs: number;
}

export class RiskManager {
  private state: RiskState = {
    globalExposureUsd: 0,
    perMarketExposureUsd: new Map(),
    openOrderCount: 0,
    dailyLossUsd: 0,
    lastTradeTimeMs: 0,
    cooldownEndMs: 0,
  };

  constructor(private config: { maxExposureUsd: number; perMarketMaxUsd: number; dailyStopLossUsd: number; cooldownMs: number }) {}

  canTrade(marketName: string, estimatedExposure: number): { allowed: boolean; reason?: string } {
    const now = Date.now();

    // Check kill switch
    if (this.isKillSwitchActive()) {
      return { allowed: false, reason: "Kill switch is active" };
    }

    // Check cooldown
    if (now < this.state.cooldownEndMs) {
      const waitMs = this.state.cooldownEndMs - now;
      return { allowed: false, reason: `In cooldown for ${waitMs}ms` };
    }

    // Check global exposure
    if (this.state.globalExposureUsd + estimatedExposure > this.config.maxExposureUsd) {
      return { allowed: false, reason: "Would exceed global exposure limit" };
    }

    // Check per-market exposure
    const currentMarketExp = this.state.perMarketExposureUsd.get(marketName) || 0;
    if (currentMarketExp + estimatedExposure > this.config.perMarketMaxUsd) {
      return { allowed: false, reason: "Would exceed per-market exposure limit" };
    }

    // Check daily stop loss
    if (this.state.dailyLossUsd >= this.config.dailyStopLossUsd) {
      return { allowed: false, reason: "Daily stop loss reached" };
    }

    return { allowed: true };
  }

  updateExposure(
    marketName: string,
    globalDelta: number,
    marketDelta: number
  ): void {
    this.state.globalExposureUsd = Math.max(0, this.state.globalExposureUsd + globalDelta);
    const current = this.state.perMarketExposureUsd.get(marketName) || 0;
    this.state.perMarketExposureUsd.set(marketName, Math.max(0, current + marketDelta));
  }

  recordTrade(): void {
    this.state.lastTradeTimeMs = Date.now();
    this.state.openOrderCount++;
  }

  recordFill(size: number = 1): void {
    this.state.openOrderCount = Math.max(0, this.state.openOrderCount - size);
  }

  recordLoss(lossUsd: number): void {
    this.state.dailyLossUsd += lossUsd;
    logger.warn({ lossUsd, totalDailyLoss: this.state.dailyLossUsd }, "Loss recorded");
  }

  activateCooldown(): void {
    this.state.cooldownEndMs = Date.now() + this.config.cooldownMs;
    logger.info(`Cooldown activated until ${new Date(this.state.cooldownEndMs).toISOString()}`);
  }

  isKillSwitchActive(): boolean {
    // Check for KILL_SWITCH env var
    return process.env.KILL_SWITCH === "1" || require("fs").existsSync("./KILL_SWITCH");
  }

  resetDaily(): void {
    this.state.dailyLossUsd = 0;
  }

  getState(): RiskState {
    return { ...this.state };
  }

  reset(): void {
    this.state = {
      globalExposureUsd: 0,
      perMarketExposureUsd: new Map(),
      openOrderCount: 0,
      dailyLossUsd: 0,
      lastTradeTimeMs: 0,
      cooldownEndMs: 0,
    };
  }
}
