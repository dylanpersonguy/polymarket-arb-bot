export function nowMs(): number {
  return Date.now();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function elapsedMs(startMs: number): number {
  return Date.now() - startMs;
}

export function isStale(lastUpdatedMs: number, maxAgeMs: number): boolean {
  return Date.now() - lastUpdatedMs > maxAgeMs;
}

/** Returns ms-since-midnight so we can detect day rolls. */
export function msSinceMidnightUtc(): number {
  const now = new Date();
  return (
    now.getUTCHours() * 3_600_000 +
    now.getUTCMinutes() * 60_000 +
    now.getUTCSeconds() * 1_000 +
    now.getUTCMilliseconds()
  );
}

/** Unique trade id for logging */
export function tradeId(): string {
  return `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
