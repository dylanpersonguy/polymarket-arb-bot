import pino from "pino";
import type { Market, MarketBinary, MarketMulti } from "../config/schema.js";

const logger = pino({ name: "MarketScanner" });

export interface MarketScannerConfig {
  /** How often to scan for new markets (ms). */
  intervalMs: number;
  /** Minimum USD liquidity on the top level to include a market. */
  minLiquidityUsd: number;
  /** Polymarket API base URL for market discovery. */
  apiBaseUrl?: string;
}

interface PolymarketApiMarket {
  condition_id: string;
  question: string;
  slug: string;
  tokens: Array<{
    token_id: string;
    outcome: string;
  }>;
  active: boolean;
  closed: boolean;
  volume: string;
  liquidity: string;
}

/**
 * #9 — Automatic market discovery.
 *
 * Periodically queries the Polymarket API for active markets with sufficient
 * liquidity and converts them to the internal Market schema.
 *
 * NOTE: This is a skeleton that uses the public Polymarket CLOB REST API.
 * The exact endpoint and response format should be verified against the
 * latest Polymarket API docs.
 */
export class MarketScanner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private discoveredMarkets: Market[] = [];

  constructor(
    private cfg: MarketScannerConfig
  ) {}

  /* ---- lifecycle ---- */

  start(onNewMarkets: (markets: Market[]) => void): void {
    this.timer = setInterval(async () => {
      try {
        const fresh = await this.scan();
        if (fresh.length > 0) {
          onNewMarkets(fresh);
        }
      } catch (err) {
        logger.error({ err: String(err) }, "Market scan failed");
      }
    }, this.cfg.intervalMs);

    logger.info({ intervalMs: this.cfg.intervalMs }, "Market scanner started");
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getDiscoveredMarkets(): Market[] {
    return [...this.discoveredMarkets];
  }

  /* ---- scanning ---- */

  async scan(): Promise<Market[]> {
    const apiBase = this.cfg.apiBaseUrl ?? "https://clob.polymarket.com";

    const response = await fetch(`${apiBase}/markets`, {
      headers: { "Accept": "application/json" },
    });

    if (!response.ok) {
      logger.warn({ status: response.status }, "Market API returned non-OK");
      return [];
    }

    const raw: PolymarketApiMarket[] = await response.json() as PolymarketApiMarket[];

    const candidates = raw.filter((m) => {
      if (!m.active || m.closed) return false;
      const liq = parseFloat(m.liquidity ?? "0");
      return liq >= this.cfg.minLiquidityUsd;
    });

    const newMarkets: Market[] = [];
    const existingSlugs = new Set(this.discoveredMarkets.map((m) => m.name));

    for (const c of candidates) {
      if (existingSlugs.has(c.slug)) continue;

      const market = this.toMarket(c);
      if (market) {
        newMarkets.push(market);
        this.discoveredMarkets.push(market);
      }
    }

    if (newMarkets.length > 0) {
      logger.info({ count: newMarkets.length }, "Discovered new markets");
    }

    return newMarkets;
  }

  private toMarket(raw: PolymarketApiMarket): Market | null {
    if (!raw.tokens || raw.tokens.length < 2) return null;

    // Binary if exactly 2 outcomes
    if (raw.tokens.length === 2) {
      const yes = raw.tokens.find((t) => t.outcome.toLowerCase() === "yes");
      const no = raw.tokens.find((t) => t.outcome.toLowerCase() === "no");
      if (yes && no) {
        return {
          kind: "binary",
          name: raw.slug,
          conditionId: raw.condition_id,
          yesTokenId: yes.token_id,
          noTokenId: no.token_id,
        } as MarketBinary;
      }
    }

    // Multi-outcome
    return {
      kind: "multi",
      name: raw.slug,
      conditionId: raw.condition_id,
      outcomes: raw.tokens.map((t) => ({
        tokenId: t.token_id,
        label: t.outcome,
      })),
    } as MarketMulti;
  }
}
