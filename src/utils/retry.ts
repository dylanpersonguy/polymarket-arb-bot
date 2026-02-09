import { sleep } from "./sleep.js";

export interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  jitter?: boolean;
  onRetry?: (attempt: number, error: Error) => void;
}

export async function retry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    initialDelayMs = 100,
    maxDelayMs = 5000,
    backoffMultiplier = 2,
    jitter = true,
    onRetry,
  } = options;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < maxAttempts - 1) {
        const exponentialDelay = initialDelayMs * Math.pow(backoffMultiplier, attempt);
        const cappedDelay = Math.min(exponentialDelay, maxDelayMs);
        const jitterAmount = jitter ? Math.random() * cappedDelay * 0.1 : 0;
        const delayMs = cappedDelay + jitterAmount;

        onRetry?.(attempt + 1, lastError);
        await sleep(delayMs);
      }
    }
  }

  throw lastError || new Error("Retry exhausted");
}

export class CircuitBreaker {
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime: number | null = null;
  private state: "closed" | "open" | "half-open" = "closed";

  constructor(
    private failureThreshold: number = 5,
    private successThreshold: number = 2,
    private resetTimeoutMs: number = 30000
  ) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      const timeSinceLastFailure = Date.now() - (this.lastFailureTime || 0);
      if (timeSinceLastFailure > this.resetTimeoutMs) {
        this.state = "half-open";
        this.successCount = 0;
      } else {
        throw new Error("Circuit breaker is open");
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
        this.successCount = 0;
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

  getState(): string {
    return this.state;
  }
}
