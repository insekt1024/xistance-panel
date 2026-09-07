// ---------------------------------------------------------------------------
// In-memory rate limiting (fixed window). Good enough for a self-hosted panel
// behind reverse proxy / Cloudflare; not a distributed limiter.
// Only imported by API route handlers (always server-side).
// ---------------------------------------------------------------------------

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 10_000;

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
): { ok: boolean; remaining: number } {
  const now = Date.now();
  const existing = buckets.get(key);
  if (!existing || now > existing.resetAt) {
    // Refresh recency so insertion order tracks last use (Map.set on an
    // existing key keeps its original position, which would otherwise pin
    // reused keys at the "oldest" slot and get them wrongly evicted).
    if (existing) buckets.delete(key);
    if (buckets.size >= MAX_BUCKETS) {
      // O(1) eviction: Map preserves insertion order, so the first key is
      // the least-recently-reset bucket. (Previously this scanned all
      // buckets for the oldest resetAt on every insert while full.)
      const oldest = buckets.keys().next();
      if (!oldest.done) buckets.delete(oldest.value);
    }
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: limit - 1 };
  }
  existing.count += 1;
  const remaining = Math.max(0, limit - existing.count);
  if (existing.count > limit) return { ok: false, remaining };
  return { ok: true, remaining };
}

/** Garbage-collect stale buckets every 10 minutes (best effort). */
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) if (now > v.resetAt) buckets.delete(k);
}, 10 * 60 * 1000).unref();
