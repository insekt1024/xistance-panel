// ---------------------------------------------------------------------------
// Tiny in-memory TTL cache for expensive read paths (dashboard aggregates).
// Deliberately minimal: single-flight per key, stale-while-revalidate-free.
// Only safe for server-side, non-user-specific data.
// ---------------------------------------------------------------------------

interface Entry<T> {
  at: number;
  value: T;
}

const store = new Map<string, Entry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

export async function cached<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const hit = store.get(key) as Entry<T> | undefined;
  if (hit && now - hit.at < ttlMs) return hit.value;

  // Single-flight: concurrent callers share one in-progress computation.
  const pending = inflight.get(key) as Promise<T> | undefined;
  if (pending) return pending;

  const p = fn()
    .then((value) => {
      store.set(key, { at: Date.now(), value });
      return value;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, p);
  return p;
}

/** Invalidate one or all cache entries (call after writes that affect them). */
export function invalidateCache(prefix?: string): void {
  if (!prefix) {
    store.clear();
    return;
  }
  for (const k of store.keys()) {
    if (k.startsWith(prefix)) store.delete(k);
  }
}
