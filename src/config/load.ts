import * as fs from "fs";
import * as path from "path";
import pino from "pino";
import {
  Config,
  ConfigSchema,
  EnvSchema,
  Market,
  MarketSchema,
  Env,
} from "./schema.js";

const logger = pino({ name: "Config" });

export function loadEnv(): Env {
  const envPath = path.join(process.cwd(), ".env");
  if (fs.existsSync(envPath)) {
    const contents = fs.readFileSync(envPath, "utf-8");
    for (const line of contents.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (key && !process.env[key]) {
        process.env[key] = value;
      }
    }
  }

  return EnvSchema.parse({
    POLYMARKET_PRIVATE_KEY: process.env.POLYMARKET_PRIVATE_KEY ?? "",
    POLYMARKET_API_KEY: process.env.POLYMARKET_API_KEY,
    POLYMARKET_API_SECRET: process.env.POLYMARKET_API_SECRET,
    POLYMARKET_API_PASSPHRASE: process.env.POLYMARKET_API_PASSPHRASE,
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
    MODE: process.env.MODE ?? "dry",
    LOG_LEVEL: process.env.LOG_LEVEL ?? "info",
    KILL_SWITCH: process.env.KILL_SWITCH ?? "0",
  });
}

export function loadConfig(configPath?: string): Config {
  const resolved = configPath ?? path.join(process.cwd(), "config.json");
  if (!fs.existsSync(resolved)) {
    throw new Error(`Config file not found: ${resolved}`);
  }
  return ConfigSchema.parse(JSON.parse(fs.readFileSync(resolved, "utf-8")));
}

export function loadMarkets(marketsPath?: string): Market[] {
  const resolved = marketsPath ?? path.join(process.cwd(), "markets.json");
  if (!fs.existsSync(resolved)) {
    throw new Error(`Markets file not found: ${resolved}`);
  }
  const data = JSON.parse(fs.readFileSync(resolved, "utf-8"));
  if (!Array.isArray(data)) {
    throw new Error("markets.json must be a JSON array");
  }
  return data.map((m: unknown, i: number) => {
    try {
      return MarketSchema.parse(m);
    } catch (e) {
      throw new Error(`Invalid market at index ${i}: ${e}`);
    }
  });
}

/**
 * Hot-reload: watch config.json for changes and call `onReload` with the new config.
 * Uses debouncing to avoid rapid re-reads. Returns a cleanup function.
 *
 * Only "safe" runtime fields are updated — structural fields like `wsEnabled`
 * and `marketDiscoveryEnabled` require a restart.
 */
export type HotReloadableFields = Pick<Config,
  | "pollingIntervalMs"
  | "minProfit"
  | "takerFeeBps"
  | "makerFeeBps"
  | "slippageBps"
  | "maxExposureUsd"
  | "perMarketMaxUsd"
  | "dailyStopLossUsd"
  | "maxOpenOrders"
  | "orderTimeoutMs"
  | "cooldownMs"
  | "perMarketCooldownMs"
  | "minTopSizeUsd"
  | "maxSpreadBps"
  | "kellyFraction"
  | "bankrollUsd"
  | "oppCooldownMs"
  | "positionMaxAgeMs"
  | "trailingStopBps"
  | "enableLiveTrading"
>;

export function watchConfig(
  configPath: string | undefined,
  onReload: (newCfg: Config) => void
): () => void {
  const resolved = configPath ?? path.join(process.cwd(), "config.json");
  let debounceTimer: NodeJS.Timeout | null = null;
  let lastMtime = 0;

  const watcher = fs.watch(resolved, () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      try {
        const stat = fs.statSync(resolved);
        if (stat.mtimeMs === lastMtime) return; // no actual change
        lastMtime = stat.mtimeMs;

        const newCfg = loadConfig(resolved);
        logger.info("Config hot-reloaded from disk");
        onReload(newCfg);
      } catch (err) {
        logger.warn({ err: String(err) }, "Failed to hot-reload config — keeping current");
      }
    }, 500);
  });

  return () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    watcher.close();
  };
}
