import * as fs from "fs";
import pino from "pino";

const logger = pino({ name: "RiskManager" });

export interface RiskConfig {
  maxExposureUsd: number;
  perMarketMaxUsd: number;
  dailyStopLossUsd: number;
  maxOpenOrders: number;
  cooldownMs: number;
  safeModeErrorThreshold: number;
  perMarketCooldownMs?: number;     // #10 — per-market cooldown
  minBalanceUsd?: number;           // #12 — balance floor
}

export interface RiskState {
  globalExposureUsd: number;
  perMarketExposureUsd: Map<string, number>;
  openOrderCount: number;
  dailyLossUsd: number;
  cooldownEndMs: number;
  consecutiveErrors: number;
  safeModeActive: boolean;
  lastDayUtc: number;
  perMarketCooldownEnd: Map<string, number>;  // #10
  lastKnownBalanceUsd: number;                 // #12
}

export class RiskManager {
  private state: RiskState;

  constructor(private cfg: RiskConfig) {
    this.state = {
      globalExposureUsd: 0,
      perMarketExposureUsd: new Map(),
      openOrderCount: 0,
      dailyLossUsd: 0,
      cooldownEndMs: 0,
      consecutiveErrors: 0,
      safeModeActive: false,
      lastDayUtc: this.todayUtc(),
      perMarketCooldownEnd: new Map(),
      lastKnownBalanceUsd: Infinity,
    };
  }

  /* ---------- pre-trade checks ---------- */

  canTrade(
    marketName: string,
    estimatedExposureUsd: number
  ): { allowed: boolean; reason?: string } {
    // Kill switch
    if (this.isKillSwitchActive()) {
      return { allowed: false, reason: "Kill switch is active" };
    }

    // Safe mode
    if (this.state.safeModeActive) {
      return { allowed: false, reason: "Safe mode — too many consecutive errors" };
    }

    // Global cooldown
    const now = Date.now();
    if (now < this.state.cooldownEndMs) {
      return { allowed: false, reason: `In cooldown for ${this.state.cooldownEndMs - now}ms` };
    }

    // #10 — Per-market cooldown
    const mktCooldownEnd = this.state.perMarketCooldownEnd.get(marketName) ?? 0;
    if (now < mktCooldownEnd) {
      return { allowed: false, reason: `Market ${marketName} on cooldown for ${mktCooldownEnd - now}ms` };
    }

    // Daily stop-loss
    this.maybeDayRoll();
    if (this.state.dailyLossUsd >= this.cfg.dailyStopLossUsd) {
      return { allowed: false, reason: "Daily stop-loss reached" };
    }

    // #12 — Balance floor check
    if (this.cfg.minBalanceUsd !== undefined && this.state.lastKnownBalanceUsd < this.cfg.minBalanceUsd) {
      return { allowed: false, reason: `Balance $${this.state.lastKnownBalanceUsd.toFixed(2)} below minimum $${this.cfg.minBalanceUsd}` };
    }

    // #12 — Check if we can afford this trade
    if (this.state.lastKnownBalanceUsd < estimatedExposureUsd) {
      return { allowed: false, reason: `Insufficient balance: need $${estimatedExposureUsd.toFixed(2)}, have $${this.state.lastKnownBalanceUsd.toFixed(2)}` };
    }

    // Global exposure
    if (this.state.globalExposureUsd + estimatedExposureUsd > this.cfg.maxExposureUsd) {
      return { allowed: false, reason: "Would exceed global exposure limit" };
    }

    // Per-market exposure
    const mktExp = this.state.perMarketExposureUsd.get(marketName) ?? 0;
    if (mktExp + estimatedExposureUsd > this.cfg.perMarketMaxUsd) {
      return { allowed: false, reason: "Would exceed per-market exposure limit" };
    }

    // Max open orders
    if (this.state.openOrderCount >= this.cfg.maxOpenOrders) {
      return { allowed: false, reason: "Max open orders reached" };
    }

    return { allowed: true };
  }

  /* ---------- state updates ---------- */

  updateExposure(marketName: string, globalDelta: number, marketDelta: number): void {
    this.state.globalExposureUsd = Math.max(0, this.state.globalExposureUsd + globalDelta);
    const cur = this.state.perMarketExposureUsd.get(marketName) ?? 0;
    this.state.perMarketExposureUsd.set(marketName, Math.max(0, cur + marketDelta));
  }

  /** #12 — Update known balance from API. */
  updateBalance(balanceUsd: number): void {
    this.state.lastKnownBalanceUsd = balanceUsd;
  }

  recordOrderPlaced(): void {
    this.state.openOrderCount++;
  }

  recordOrderClosed(n: number = 1): void {
    this.state.openOrderCount = Math.max(0, this.state.openOrderCount - n);
  }

  recordLoss(lossUsd: number): void {
    this.state.dailyLossUsd += lossUsd;
    logger.warn({ lossUsd, totalDailyLoss: this.state.dailyLossUsd }, "Loss recorded");
  }

  activateCooldown(): void {
    this.state.cooldownEndMs = Date.now() + this.cfg.cooldownMs;
    logger.info({ untilMs: this.state.cooldownEndMs }, "Cooldown activated");
  }

  /** #10 — Per-market cooldown after a trade or failure on a specific market. */
  activateMarketCooldown(marketName: string): void {
    const ms = this.cfg.perMarketCooldownMs ?? this.cfg.cooldownMs;
    this.state.perMarketCooldownEnd.set(marketName, Date.now() + ms);
    logger.info({ marketName, ms }, "Per-market cooldown activated");
  }

  recordError(): void {
    this.state.consecutiveErrors++;
    if (this.state.consecutiveErrors >= this.cfg.safeModeErrorThreshold) {
      this.state.safeModeActive = true;
      logger.error("SAFE MODE activated — switching to DRY_RUN");
    }
  }

  recordSuccess(): void {
    this.state.consecutiveErrors = 0;
  }

  /* ---------- kill switch ---------- */

  isKillSwitchActive(): boolean {
    if (process.env.KILL_SWITCH === "1") return true;
    try {
      return fs.existsSync("./KILL_SWITCH");
    } catch {
      return false;
    }
  }

  /* ---------- day roll ---------- */

  private todayUtc(): number {
    return Math.floor(Date.now() / 86_400_000);
  }

  private maybeDayRoll(): void {
    const today = this.todayUtc();
    if (today !== this.state.lastDayUtc) {
      logger.info("New UTC day — resetting daily counters");
      this.state.dailyLossUsd = 0;
      this.state.lastDayUtc = today;
    }
  }

  resetDaily(): void {
    this.state.dailyLossUsd = 0;
    this.state.lastDayUtc = this.todayUtc();
  }

  getState(): RiskState {
    return { ...this.state };
  }

  isSafeMode(): boolean {
    return this.state.safeModeActive;
  }

  /** Manual reset of safe mode (requires operator intervention). */
  clearSafeMode(): void {
    this.state.safeModeActive = false;
    this.state.consecutiveErrors = 0;
  }

  reset(): void {
    this.state = {
      globalExposureUsd: 0,
      perMarketExposureUsd: new Map(),
      openOrderCount: 0,
      dailyLossUsd: 0,
      cooldownEndMs: 0,
      consecutiveErrors: 0,
      safeModeActive: false,
      lastDayUtc: this.todayUtc(),
      perMarketCooldownEnd: new Map(),
      lastKnownBalanceUsd: Infinity,
    };
  }
}
