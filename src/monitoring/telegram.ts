import pino from "pino";
import https from "https";

const logger = pino({ name: "Telegram" });

export interface TelegramConfig {
  botToken: string;
  chatId: string;
  enabled: boolean;
}

export class TelegramNotifier {
  private apiUrl: string;

  constructor(private config: TelegramConfig) {
    this.apiUrl = `https://api.telegram.org/bot${config.botToken}/sendMessage`;
  }

  async send(text: string): Promise<void> {
    if (!this.config.enabled || !this.config.botToken || !this.config.chatId) {
      return;
    }

    return new Promise((resolve) => {
      const data = JSON.stringify({
        chat_id: this.config.chatId,
        text: text.substring(0, 4096), // Telegram limit
        parse_mode: "HTML",
      });

      const options = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      };

      const req = https.request(this.apiUrl, options, (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          if (res.statusCode !== 200) {
            logger.warn({ statusCode: res.statusCode, response: body }, "Telegram send failed");
          } else {
            logger.debug("Telegram message sent");
          }
          resolve();
        });
      });

      req.on("error", (error) => {
        logger.error({ error }, "Telegram request error");
        resolve();
      });

      req.write(data);
      req.end();
    });
  }

  async sendOpportunity(marketName: string, profit: number, profitBps: number): Promise<void> {
    const text = `<b>📊 Arbitrage Opportunity Detected</b>\n\n<b>Market:</b> ${marketName}\n<b>Profit:</b> ${profit.toFixed(4)} (${profitBps.toFixed(0)}bps)`;
    await this.send(text);
  }

  async sendTrade(result: { success: boolean; loss?: number; ordersPlaced: string[] }): Promise<void> {
    const status = result.success ? "✅ SUCCESS" : "❌ FAILED";
    const details = result.loss ? `\n<b>Loss:</b> $${result.loss.toFixed(2)}` : "";
    const text = `<b>🔄 Trade Execution</b>\n${status}${details}`;
    await this.send(text);
  }

  async sendKillSwitch(): Promise<void> {
    await this.send("<b>🛑 KILL SWITCH ACTIVATED - Trading stopped immediately</b>");
  }

  async sendError(message: string): Promise<void> {
    await this.send(`<b>⚠️ Error:</b> ${message}`);
  }
}
