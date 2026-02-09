/**
 * Simple in-process metrics collector.
 * Counters and gauges with periodic logging.
 */
import pino from "pino";

const logger = pino({ name: "Metrics" });

export class Metrics {
  private counters = new Map<string, number>();
  private gauges = new Map<string, number>();
  private histograms = new Map<string, number[]>();
  private startTime = Date.now();

  /* ---- Counters ---- */

  inc(name: string, delta = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + delta);
  }

  getCounter(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  /* ---- Gauges ---- */

  gauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  getGauge(name: string): number {
    return this.gauges.get(name) ?? 0;
  }

  /* ---- Histograms (simple array-based) ---- */

  observe(name: string, value: number): void {
    const arr = this.histograms.get(name) ?? [];
    arr.push(value);
    // Keep last 1000 observations
    if (arr.length > 1000) arr.shift();
    this.histograms.set(name, arr);
  }

  percentile(name: string, p: number): number {
    const arr = this.histograms.get(name);
    if (!arr || arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.min(Math.ceil((p / 100) * sorted.length) - 1, sorted.length - 1);
    return sorted[Math.max(0, idx)];
  }

  /* ---- Snapshot ---- */

  snapshot(): Record<string, unknown> {
    const snap: Record<string, unknown> = {
      uptimeMs: Date.now() - this.startTime,
    };

    for (const [k, v] of this.counters) snap[`counter.${k}`] = v;
    for (const [k, v] of this.gauges) snap[`gauge.${k}`] = v;
    for (const [k] of this.histograms) {
      snap[`hist.${k}.p50`] = this.percentile(k, 50);
      snap[`hist.${k}.p95`] = this.percentile(k, 95);
      snap[`hist.${k}.p99`] = this.percentile(k, 99);
    }

    return snap;
  }

  /** Log current metrics at info level. */
  log(): void {
    logger.info(this.snapshot(), "metrics");
  }

  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
    this.startTime = Date.now();
  }
}
