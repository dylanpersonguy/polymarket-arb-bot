export class RateLimiter {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private capacity: number,
    private refillRatePerSecond: number
  ) {
    this.tokens = capacity;
    this.lastRefillMs = Date.now();
  }

  async acquire(tokensNeeded: number = 1): Promise<void> {
    while (true) {
      this.refill();

      if (this.tokens >= tokensNeeded) {
        this.tokens -= tokensNeeded;
        return;
      }

      const timeToWaitMs = ((tokensNeeded - this.tokens) / this.refillRatePerSecond) * 1000;
      await new Promise((resolve) => setTimeout(resolve, timeToWaitMs + 10));
    }
  }

  tryAcquire(tokensNeeded: number = 1): boolean {
    this.refill();

    if (this.tokens >= tokensNeeded) {
      this.tokens -= tokensNeeded;
      return true;
    }

    return false;
  }

  private refill(): void {
    const nowMs = Date.now();
    const elapsedSeconds = (nowMs - this.lastRefillMs) / 1000;
    const tokensToAdd = elapsedSeconds * this.refillRatePerSecond;

    if (tokensToAdd > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
      this.lastRefillMs = nowMs;
    }
  }

  getAvailableTokens(): number {
    this.refill();
    return this.tokens;
  }

  reset(): void {
    this.tokens = this.capacity;
    this.lastRefillMs = Date.now();
  }
}

export class AdaptiveRateLimiter {
  private limiter: RateLimiter;
  private errorCount = 0;
  private successCount = 0;

  constructor(initialRatePerSecond: number, private maxRate: number = 100) {
    this.limiter = new RateLimiter(100, initialRatePerSecond);
  }

  async acquire(tokensNeeded: number = 1): Promise<void> {
    return this.limiter.acquire(tokensNeeded);
  }

  recordSuccess(): void {
    this.successCount++;
    if (this.successCount > 10 && this.errorCount === 0) {
      // Gradually increase rate
      const currentRate = this.limiter.getAvailableTokens() / 100;
      if (currentRate < this.maxRate) {
        this.limiter = new RateLimiter(100, Math.min(currentRate * 1.1, this.maxRate));
        this.successCount = 0;
      }
    }
  }

  recordError(statusCode?: number): void {
    this.errorCount++;

    if (statusCode === 429) {
      // Too many requests: reduce rate significantly
      const currentRate = this.limiter.getAvailableTokens() / 100;
      this.limiter = new RateLimiter(100, Math.max(currentRate * 0.5, 1));
    }

    this.successCount = 0;
  }

  reset(): void {
    this.limiter.reset();
    this.errorCount = 0;
    this.successCount = 0;
  }
}
