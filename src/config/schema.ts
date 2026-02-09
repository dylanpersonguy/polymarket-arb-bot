import { z } from "zod";

export const MarketBinarySchema = z.object({
  name: z.string(),
  kind: z.literal("binary"),
  yesTokenId: z.string(),
  noTokenId: z.string(),
  resolutionGroup: z.string().optional(),
});

export const MarketOutcomeSchema = z.object({
  label: z.string(),
  tokenId: z.string(),
});

export const MarketMultiSchema = z.object({
  name: z.string(),
  kind: z.literal("multi"),
  outcomes: z.array(MarketOutcomeSchema).min(2),
  resolutionGroup: z.string().optional(),
});

export const MarketSchema = z.union([MarketBinarySchema, MarketMultiSchema]);

export type MarketBinary = z.infer<typeof MarketBinarySchema>;
export type MarketMulti = z.infer<typeof MarketMultiSchema>;
export type Market = z.infer<typeof MarketSchema>;

export const ConfigPaperSchema = z.object({
  fillProbability: z.number().min(0).max(1).default(0.85),
  extraSlippageBps: z.number().min(0).default(5),
});

export const ConfigSchema = z.object({
  marketsFile: z.string().default("./markets.json"),
  pollingIntervalMs: z.number().min(100).default(400),
  minProfit: z.number().min(0).default(0.002),
  feeBps: z.number().min(0).default(5),
  slippageBps: z.number().min(0).default(10),
  maxExposureUsd: z.number().min(100).default(500),
  perMarketMaxUsd: z.number().min(50).default(150),
  dailyStopLossUsd: z.number().min(10).default(100),
  maxOpenOrders: z.number().min(1).default(10),
  orderTimeoutMs: z.number().min(500).default(1500),
  cooldownMs: z.number().min(500).default(2500),
  minTopSizeUsd: z.number().min(1).default(20),
  priceImprovementTicks: z.number().min(0).default(0),
  enableLiveTrading: z.boolean().default(false),
  enableTelegram: z.boolean().default(true),
  paper: ConfigPaperSchema.optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export const EnvSchema = z.object({
  POLYMARKET_PRIVATE_KEY: z.string().min(1),
  POLYMARKET_API_KEY: z.string().optional(),
  POLYMARKET_API_SECRET: z.string().optional(),
  POLYMARKET_API_PASSPHRASE: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  MODE: z.enum(["dry", "paper", "live"]).default("dry"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  KILL_SWITCH: z
    .string()
    .transform((v) => v === "1" || v.toLowerCase() === "true")
    .default("0"),
});

export type Env = z.infer<typeof EnvSchema>;
