import { z } from "zod";

/* ---------- Market watchlist schemas ---------- */

export const MarketBinarySchema = z.object({
  name: z.string().min(1),
  kind: z.literal("binary"),
  yesTokenId: z.string().min(1),
  noTokenId: z.string().min(1),
  conditionId: z.string().optional(),
  resolutionGroup: z.string().optional(),
});

export const MarketOutcomeSchema = z.object({
  label: z.string().min(1),
  tokenId: z.string().min(1),
});

export const MarketMultiSchema = z.object({
  name: z.string().min(1),
  kind: z.literal("multi"),
  outcomes: z.array(MarketOutcomeSchema).min(2),
  conditionId: z.string().optional(),
  resolutionGroup: z.string().optional(),
});

export const MarketSchema = z.discriminatedUnion("kind", [MarketBinarySchema, MarketMultiSchema]);

export type MarketBinary = z.infer<typeof MarketBinarySchema>;
export type MarketMulti = z.infer<typeof MarketMultiSchema>;
export type Market = z.infer<typeof MarketSchema>;

/* ---------- Paper-trading config ---------- */

export const ConfigPaperSchema = z.object({
  fillProbability: z.number().min(0).max(1).default(0.85),
  extraSlippageBps: z.number().min(0).default(5),
});

/* ---------- Main config schema ---------- */

export const ConfigSchema = z.object({
  marketsFile: z.string().default("./markets.json"),
  pollingIntervalMs: z.number().min(100).default(400),
  minProfit: z.number().min(0).default(0.002),

  /* ---- Fee model (#4) ---- */
  feeBps: z.number().min(0).default(200),           // legacy / fallback
  takerFeeBps: z.number().min(0).default(200),       // 2 % Polymarket taker fee
  makerFeeBps: z.number().min(0).default(0),         // 0 % Polymarket maker fee
  slippageBps: z.number().min(0).default(10),

  /* ---- Exposure ---- */
  maxExposureUsd: z.number().min(10).default(500),
  perMarketMaxUsd: z.number().min(10).default(150),
  dailyStopLossUsd: z.number().min(5).default(100),
  maxOpenOrders: z.number().min(1).default(10),

  /* ---- Execution (#6, #15) ---- */
  orderTimeoutMs: z.number().min(500).default(5000),  // raised from 1500
  cooldownMs: z.number().min(500).default(2500),
  perMarketCooldownMs: z.number().min(0).default(5000), // #10 per-market cooldown
  concurrentLegs: z.boolean().default(true),             // #6 concurrent legs
  adaptiveTimeoutEnabled: z.boolean().default(true),     // #15 adaptive timeout
  adaptiveTimeoutMinMs: z.number().min(500).default(2000),
  adaptiveTimeoutMaxMs: z.number().min(1000).default(15000),

  /* ---- Detection (#1, #8) ---- */
  minTopSizeUsd: z.number().min(1).default(20),
  priceImprovementTicks: z.number().min(-5).max(5).default(0),
  maxSpreadBps: z.number().min(0).default(500),        // #8 reject wide spread legs
  useBookDepthForDetection: z.boolean().default(true),  // #1 full VWAP detection

  /* ---- Sizing (#5) ---- */
  kellyFraction: z.number().min(0.01).max(1.0).default(0.25),
  bankrollUsd: z.number().min(0).default(1000),        // Kelly bankroll reference

  /* ---- Position management (#14) ---- */
  positionMaxAgeMs: z.number().min(0).default(600_000), // 10 min
  trailingStopBps: z.number().min(0).default(200),      // 2 %

  /* ---- Duplicate suppression (#11) ---- */
  oppCooldownMs: z.number().min(0).default(10_000),

  /* ---- WebSocket (#7) ---- */
  wsEnabled: z.boolean().default(false),
  wsUrl: z.string().default("wss://ws-subscriptions-clob.polymarket.com/ws/market"),

  /* ---- Market discovery (#9) ---- */
  marketDiscoveryEnabled: z.boolean().default(false),
  marketDiscoveryIntervalMs: z.number().min(10_000).default(300_000),
  marketDiscoveryMinLiquidityUsd: z.number().min(0).default(5_000),
  marketDiscoveryMaxLiquidityUsd: z.number().min(0).default(500_000),
  marketDiscoveryIncludeNegRisk: z.boolean().default(true),
  marketDiscoveryIncludeBinary: z.boolean().default(true),
  marketDiscoveryMinScore: z.number().min(0).default(25),
  marketDiscoveryMaxOutcomes: z.number().min(2).default(60),

  enableLiveTrading: z.boolean().default(false),
  enableTelegram: z.boolean().default(true),
  safeModeErrorThreshold: z.number().min(1).default(5),
  paper: ConfigPaperSchema.default({}),
});

export type Config = z.infer<typeof ConfigSchema>;

/* ---------- Environment schema ---------- */

export const EnvSchema = z.object({
  POLYMARKET_PRIVATE_KEY: z.string().min(1, "POLYMARKET_PRIVATE_KEY is required"),
  POLYMARKET_API_KEY: z.string().optional(),
  POLYMARKET_API_SECRET: z.string().optional(),
  POLYMARKET_API_PASSPHRASE: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  DASHBOARD_PORT: z.string().optional(),
  MODE: z.enum(["dry", "paper", "live"]).default("dry"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  KILL_SWITCH: z
    .string()
    .transform((v) => v === "1" || v.toLowerCase() === "true")
    .default("0"),
});

export type Env = z.infer<typeof EnvSchema>;
