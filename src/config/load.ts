import * as fs from "fs";
import * as path from "path";
import {
  Config,
  ConfigSchema,
  EnvSchema,
  Market,
  MarketSchema,
  Env,
} from "./schema.js";

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
