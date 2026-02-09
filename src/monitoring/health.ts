import pino from "pino";

const logger = pino({ name: "Health" });

export interface HealthStatus {
  uptime: number;
  uptimeHuman: string;
  lastLoopMs: number;
  loopsPerMinute: number;
  memoryMB: number;
  healthy: boolean;
  checks: Record<string, boolean>;
}

/**
 * Tracks bot health: loop timing, memory, external connectivity.
 */
export class HealthMonitor {
  private startTime = Date.now();
  private lastLoopStart = 0;
  private lastLoopEnd = 0;
  private loopCount = 0;
  private loopStartedAtMinute = Date.now();
  private loopsInCurrentMinute = 0;

  markLoopStart(): void {
    this.lastLoopStart = Date.now();
    this.loopCount++;

    const now = Date.now();
    if (now - this.loopStartedAtMinute > 60_000) {
      this.loopStartedAtMinute = now;
      this.loopsInCurrentMinute = 0;
    }
    this.loopsInCurrentMinute++;
  }

  markLoopEnd(): void {
    this.lastLoopEnd = Date.now();
  }

  status(extraChecks: Record<string, boolean> = {}): HealthStatus {
    const uptime = Date.now() - this.startTime;
    const hours = Math.floor(uptime / 3_600_000);
    const mins = Math.floor((uptime % 3_600_000) / 60_000);

    const lastLoopMs =
      this.lastLoopEnd > this.lastLoopStart
        ? this.lastLoopEnd - this.lastLoopStart
        : 0;

    const mem = process.memoryUsage();

    const checks: Record<string, boolean> = {
      loopRunning: this.loopCount > 0 && Date.now() - this.lastLoopStart < 30_000,
      memoryOk: mem.rss < 512 * 1024 * 1024, // < 512 MB
      ...extraChecks,
    };

    const healthy = Object.values(checks).every(Boolean);

    if (!healthy) {
      logger.warn({ checks }, "Unhealthy status");
    }

    return {
      uptime,
      uptimeHuman: `${hours}h ${mins}m`,
      lastLoopMs,
      loopsPerMinute: this.loopsInCurrentMinute,
      memoryMB: Math.round(mem.rss / 1024 / 1024),
      healthy,
      checks,
    };
  }
}
