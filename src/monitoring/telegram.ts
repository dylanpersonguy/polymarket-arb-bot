import pino from "pino";

const logger = pino({ name: "Telegram" });

export interface TelegramConfig {
  botToken: string;
  chatId: string;
  enabled: boolean;
}

/**
 * Lightweight Telegram notifier.  Uses the Bot API via fetch.
 */
export class TelegramNotifier {
  private readonly baseUrl: string;

  constructor(private readonly cfg: TelegramConfig) {
    this.baseUrl = `https://api.telegram.org/bot${cfg.botToken}`;
  }

  get enabled(): boolean {
    return this.cfg.enabled && !!this.cfg.botToken && !!this.cfg.chatId;
  }

  async sendMessage(text: string, parseMode: "HTML" | "Markdown" = "HTML"): Promise<void> {
    if (!this.enabled) return;

    try {
      const res = await fetch(`${this.baseUrl}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: this.cfg.chatId,
          text,
          parse_mode: parseMode,
          disable_web_page_preview: true,
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        logger.warn({ status: res.status, body }, "Telegram API error");
      }
    } catch (err) {
      logger.error({ err: String(err) }, "Failed to send Telegram message");
    }
  }

  async notifyTrade(tradeId: string, market: string, profit: number, legs: number): Promise<void> {
    const emoji = profit > 0 ? "✅" : "⚠️";
    const msg = [
      `${emoji} <b>Trade ${tradeId.slice(0, 8)}</b>`,
      `Market: ${market}`,
      `Legs: ${legs}`,
      `Profit: $${profit.toFixed(4)}`,
    ].join("\n");
    await this.sendMessage(msg);
  }

  async notifyError(context: string, error: string): Promise<void> {
    const msg = `🚨 <b>Error</b>\nContext: ${context}\n<code>${error.slice(0, 500)}</code>`;
    await this.sendMessage(msg);
  }

  async notifyRiskEvent(event: string, details: string): Promise<void> {
    const msg = `🛑 <b>Risk Event</b>\n${event}\n${details}`;
    await this.sendMessage(msg);
  }

  async notifyDailySummary(stats: {
    trades: number;
    pnl: number;
    wins: number;
    losses: number;
  }): Promise<void> {
    const msg = [
      "📊 <b>Daily Summary</b>",
      `Trades: ${stats.trades}`,
      `Wins/Losses: ${stats.wins}/${stats.losses}`,
      `Net P&L: $${stats.pnl.toFixed(4)}`,
    ].join("\n");
    await this.sendMessage(msg);
  }

  /**
   * Alert when a gap is approaching profitability.
   * Only fires if the gap is within `thresholdBps` of being profitable.
   */
  private lastGapAlertAt = new Map<string, number>();
  private readonly gapAlertCooldownMs = 60_000; // 1 minute between alerts per market

  async notifyGapAlert(
    market: string,
    gapPct: number,
    askYes: number,
    askNo: number
  ): Promise<void> {
    const now = Date.now();
    const lastAlert = this.lastGapAlertAt.get(market) ?? 0;
    if (now - lastAlert < this.gapAlertCooldownMs) return;

    this.lastGapAlertAt.set(market, now);

    const emoji = gapPct <= 0 ? "🔥" : "👀";
    const msg = [
      `${emoji} <b>Gap Alert</b>`,
      `Market: ${market}`,
      `Gap: ${gapPct.toFixed(2)}%`,
      `Ask YES: ${askYes.toFixed(2)} | Ask NO: ${askNo.toFixed(2)}`,
      gapPct <= 0 ? "⚡ PROFITABLE — within arb range!" : `📐 ${gapPct.toFixed(2)}% from profitability`,
    ].join("\n");
    await this.sendMessage(msg);
  }

  /**
   * Alert on cross-event arb candidates.
   */
  async notifyCrossEventArb(
    marketA: string,
    marketB: string,
    divergencePct: number,
    estimatedProfitPct: number
  ): Promise<void> {
    const msg = [
      "🔗 <b>Cross-Event Arb</b>",
      `A: ${marketA}`,
      `B: ${marketB}`,
      `Divergence: ${divergencePct.toFixed(1)}%`,
      `Est. Profit: ${estimatedProfitPct.toFixed(1)}%`,
    ].join("\n");
    await this.sendMessage(msg);
  }

  /**
   * Scanner discovery notification.
   */
  async notifyScannerDiscovery(
    count: number,
    topMarket: string,
    topScore: number
  ): Promise<void> {
    const msg = [
      "🔍 <b>Scanner Discovery</b>",
      `Found: ${count} new markets`,
      `Top: ${topMarket}`,
      `Score: ${topScore.toFixed(0)}`,
    ].join("\n");
    await this.sendMessage(msg);
  }
}
