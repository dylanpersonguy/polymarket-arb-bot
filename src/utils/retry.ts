import { sleep } from "./sleep.js";

export interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  jitter?: boolean;
  retryIf?: (error: Error) => boolean;
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;
}

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

function isRetryable(error: Error): boolean {
  const msg = error.message;
  if (RETRYABLE_STATUS_CODES.has(Number(msg))) return true;
  if (/429|5\d{2}|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up/i.test(msg)) return true;
  return false;
}

function parseRetryAfterMs(error: Error): number | null {
  const match = /retry-after:\s*(\d+)/i.exec(error.message);
  if (match) return Number(match[1]) * 1000;
  return null;
}

export async function retry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    initialDelayMs = 200,
    maxDelayMs = 10_000,
    backoffMultiplier = 2,
    jitter = true,
    retryIf = isRetryable,
    onRetry,
  } = opts;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt >= maxAttempts - 1 || !retryIf(lastError)) {
        throw lastError;
      }

      // Honor Retry-After header if present
      const retryAfter = parseRetryAfterMs(lastError);
      let delayMs: number;

      if (retryAfter !== null) {
        delayMs = retryAfter;
      } else {
        const exponential = initialDelayMs * Math.pow(backoffMultiplier, attempt);
        const capped = Math.min(exponential, maxDelayMs);
        const jitterMs = jitter ? Math.random() * capped * 0.3 : 0;
        delayMs = capped + jitterMs;
      }

      onRetry?.(attempt + 1, lastError, delayMs);
      await sleep(delayMs);
    }
  }

  throw lastError ?? new Error("Retry exhausted");
}

/**
 * Circuit breaker: stops calling a service after too many consecutive failures,
 * waits a reset period, then allows a probe request.
 */
export class CircuitBreaker {
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime = 0;
  private state: "closed" | "open" | "half-open" = "closed";

  constructor(
    private readonly failureThreshold: number = 5,
    private readonly successThreshold: number = 2,
    private readonly resetTimeoutMs: number = 30_000
  ) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      if (Date.now() - this.lastFailureTime > this.resetTimeoutMs) {
        this.state = "half-open";
        this.successCount = 0;
      } else {
        throw new Error("Circuit breaker is open — backing off");
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.failureCount = 0;
    if (this.state === "half-open") {
      this.successCount++;
      if (this.successCount >= this.successThreshold) {
        this.state = "closed";
      }
    }
  }

  private onFailure(): void {
    this.lastFailureTime = Date.now();
    this.failureCount++;
    if (this.failureCount >= this.failureThreshold) {
      this.state = "open";
    }
  }

  getState(): "closed" | "open" | "half-open" {
    return this.state;
  }

  reset(): void {
    this.state = "closed";
    this.failureCount = 0;
    this.successCount = 0;
  }
}
