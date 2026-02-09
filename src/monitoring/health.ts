export interface HealthStatus {
  status: "healthy" | "degraded" | "unhealthy";
  lastHeartbeat: number;
  circuitBreakerState: string;
  errorCount: number;
  successCount: number;
}

export class HealthMonitor {
  private lastHeartbeat = Date.now();
  private errorCount = 0;
  private successCount = 0;
  private circuitBreakerState = "closed";

  recordSuccess(): void {
    this.successCount++;
    this.lastHeartbeat = Date.now();
  }

  recordError(): void {
    this.errorCount++;
  }

  setCircuitBreakerState(state: string): void {
    this.circuitBreakerState = state;
  }

  getStatus(): HealthStatus {
    const now = Date.now();
    const heartbeatAgeMs = now - this.lastHeartbeat;

    let status: "healthy" | "degraded" | "unhealthy" = "healthy";

    if (this.circuitBreakerState === "open" || heartbeatAgeMs > 30000) {
      status = "unhealthy";
    } else if (this.errorCount > 5 || heartbeatAgeMs > 15000) {
      status = "degraded";
    }

    return {
      status,
      lastHeartbeat: this.lastHeartbeat,
      circuitBreakerState: this.circuitBreakerState,
      errorCount: this.errorCount,
      successCount: this.successCount,
    };
  }

  reset(): void {
    this.errorCount = 0;
    this.successCount = 0;
    this.lastHeartbeat = Date.now();
  }
}
