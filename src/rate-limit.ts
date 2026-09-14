type Bucket = { count: number; resetAt: number };

export class FixedWindowLimiter {
  private buckets = new Map<string, Bucket>();
  private hits = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  hit(key: string): boolean {
    const now = Date.now();
    const current = this.buckets.get(key);
    if (!current || now >= current.resetAt) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      this.hits += 1;
      if (this.hits % 1024 === 0) this.prune(now);
      return this.limit >= 1;
    }
    if (current.count >= this.limit) return false;
    current.count += 1;
    this.hits += 1;
    return true;
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now >= bucket.resetAt) this.buckets.delete(key);
    }
  }
}