/**
 * Token-bucket rate limiter.
 *
 * capacity   – max tokens available at any time
 * refillRate – tokens added per second
 */
export class RateLimiter {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly capacity: number,
    private readonly refillRatePerSecond: number
  ) {
    this.tokens = capacity;
    this.lastRefillMs = Date.now();
  }

  /** Block until `n` tokens are available. */
  async acquire(n: number = 1): Promise<void> {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      this.refill();
      if (this.tokens >= n) {
        this.tokens -= n;
        return;
      }
      const waitMs = ((n - this.tokens) / this.refillRatePerSecond) * 1000 + 5;
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }

  tryAcquire(n: number = 1): boolean {
    this.refill();
    if (this.tokens >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefillMs) / 1000;
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRatePerSecond);
      this.lastRefillMs = now;
    }
  }

  available(): number {
    this.refill();
    return this.tokens;
  }

  reset(): void {
    this.tokens = this.capacity;
    this.lastRefillMs = Date.now();
  }
}

/**
 * Self-tuning rate limiter: backs off on 429 and slowly ramps up on success.
 */
export class AdaptiveRateLimiter {
  private currentRate: number;
  private limiter: RateLimiter;

  constructor(
    initialRatePerSecond: number,
    private readonly maxRate: number = 20,
    private readonly minRate: number = 1
  ) {
    this.currentRate = initialRatePerSecond;
    this.limiter = new RateLimiter(30, initialRatePerSecond);
  }

  async acquire(n: number = 1): Promise<void> {
    return this.limiter.acquire(n);
  }

  recordSuccess(): void {
    // Ramp up 5 % per success, capped
    this.currentRate = Math.min(this.currentRate * 1.05, this.maxRate);
    this.limiter = new RateLimiter(30, this.currentRate);
  }

  recordError(statusCode?: number): void {
    if (statusCode === 429) {
      this.currentRate = Math.max(this.currentRate * 0.5, this.minRate);
    } else {
      this.currentRate = Math.max(this.currentRate * 0.8, this.minRate);
    }
    this.limiter = new RateLimiter(30, this.currentRate);
  }

  getRate(): number {
    return this.currentRate;
  }
}
