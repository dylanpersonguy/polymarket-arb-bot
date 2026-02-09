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
