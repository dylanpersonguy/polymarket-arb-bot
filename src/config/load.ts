import * as fs from "fs";
import * as path from "path";
import { Config, ConfigSchema, EnvSchema, Market, MarketSchema, Env } from "./schema.js";

export function loadEnv(): Env {
  // Load .env file
  const envPath = path.join(process.cwd(), ".env");
  if (fs.existsSync(envPath)) {
    const contents = fs.readFileSync(envPath, "utf-8");
    const lines = contents.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        const [key, ...valueParts] = trimmed.split("=");
        const value = valueParts.join("=").trim();
        if (key && value && !process.env[key]) {
          process.env[key] = value;
        }
      }
    }
  }

  const env = {
    POLYMARKET_PRIVATE_KEY: process.env.POLYMARKET_PRIVATE_KEY || "",
    POLYMARKET_API_KEY: process.env.POLYMARKET_API_KEY,
    POLYMARKET_API_SECRET: process.env.POLYMARKET_API_SECRET,
    POLYMARKET_API_PASSPHRASE: process.env.POLYMARKET_API_PASSPHRASE,
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
    MODE: process.env.MODE || "dry",
    LOG_LEVEL: process.env.LOG_LEVEL || "info",
    KILL_SWITCH: process.env.KILL_SWITCH || "0",
  };

  return EnvSchema.parse(env);
}

export function loadConfig(configPath?: string): Config {
  const resolvedPath = configPath || path.join(process.cwd(), "config.json");

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(
      `Config file not found at ${resolvedPath}. Create config.json with required settings.`
    );
  }

  const contents = fs.readFileSync(resolvedPath, "utf-8");
  const data = JSON.parse(contents);

  return ConfigSchema.parse(data);
}

export function loadMarkets(marketsPath?: string): Market[] {
  const resolvedPath = marketsPath || path.join(process.cwd(), "markets.json");

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(
      `Markets file not found at ${resolvedPath}. Create markets.json with market definitions.`
    );
  }

  const contents = fs.readFileSync(resolvedPath, "utf-8");
  const data = JSON.parse(contents);

  if (!Array.isArray(data)) {
    throw new Error("markets.json must contain an array of markets");
  }

  return data.map((market) => MarketSchema.parse(market));
}
