export interface Metrics {
  opportunitiesDetected: number;
  opportunitiesExecuted: number;
  tradesSucceeded: number;
  tradesFailed: number;
  totalPnL: number;
  averageProfitBps: number;
  uptime: number;
}

export class MetricsCollector {
  private startTime = Date.now();
  private opportunitiesDetected = 0;
  private opportunitiesExecuted = 0;
  private tradesSucceeded = 0;
  private tradesFailed = 0;
  private totalPnL = 0;
  private profitBpsValues: number[] = [];

  recordOpportunityDetected(profitBps: number): void {
    this.opportunitiesDetected++;
    this.profitBpsValues.push(profitBps);
  }

  recordOpportunityExecuted(): void {
    this.opportunitiesExecuted++;
  }

  recordTradeSuccess(pnl: number): void {
    this.tradesSucceeded++;
    this.totalPnL += pnl;
  }

  recordTradeFailed(loss: number = 0): void {
    this.tradesFailed++;
    this.totalPnL -= loss;
  }

  getMetrics(): Metrics {
    const averageProfitBps =
      this.profitBpsValues.length > 0
        ? this.profitBpsValues.reduce((a, b) => a + b, 0) / this.profitBpsValues.length
        : 0;

    return {
      opportunitiesDetected: this.opportunitiesDetected,
      opportunitiesExecuted: this.opportunitiesExecuted,
      tradesSucceeded: this.tradesSucceeded,
      tradesFailed: this.tradesFailed,
      totalPnL: this.totalPnL,
      averageProfitBps,
      uptime: Date.now() - this.startTime,
    };
  }

  reset(): void {
    this.opportunitiesDetected = 0;
    this.opportunitiesExecuted = 0;
    this.tradesSucceeded = 0;
    this.tradesFailed = 0;
    this.totalPnL = 0;
    this.profitBpsValues = [];
  }
}
