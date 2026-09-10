// ---------------------------------------------------------------------------
// Tiny in-memory TTL cache for expensive read paths (dashboard aggregates).
// Deliberately minimal: single-flight per key, stale-while-revalidate-free.
// Only safe for server-side, non-user-specific data.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Cache key namespaces. Every key MUST start with one of these so writers can
// invalidate exactly the reads they affect. Passing no prefix to
// invalidateCache() clears everything, which throws away the traffic
// aggregates — by far the most expensive reads here — so reach for that only
// when the whole dataset is replaced (e.g. a backup restore).
// ---------------------------------------------------------------------------

/** Tunnel + node status counts and the 24h traffic totals (/api/metrics). */
export const CACHE_METRICS = "metrics:";
/** Distinct audit action list backing the activity filter dropdown. */
export const CACHE_ACTIVITY = "activity:";
/** Per-range traffic aggregates (/api/traffic). */
export const CACHE_TRAFFIC = "traffic:";
/** The dashboard's 24h traffic chart. */
export const CACHE_DASHBOARD_TRAFFIC = "dashboard:traffic";

const MAX_ENTRIES = 500;

interface Entry<T> {
  at: number;
  value: T;
}

const store = new Map<string, Entry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();
// Bumped on every invalidate; a resolving computation stores its value only
// if its generation is still current (kills stale write-back).
const generation = new Map<string, number>();

function storeEntry(key: string, value: unknown): void {
  // delete-then-set refreshes recency: Map iterates in insertion order, so
  // the first key is always the stalest — O(1) eviction, no full scan.
  if (store.has(key)) {
    store.delete(key);
  } else if (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next();
    if (!oldest.done) store.delete(oldest.value);
  }
  store.set(key, { at: Date.now(), value });
}

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

  const gen = generation.get(key) ?? 0;
  const p = fn()
    .then((value) => {
      // Invalidated mid-flight: return value to the original caller but do
      // NOT repopulate the store with stale data.
      if ((generation.get(key) ?? 0) !== gen) return value;
      storeEntry(key, value);
      return value;
    })
    .finally(() => {
      // Don't evict a NEWER computation started after an invalidate.
      if (inflight.get(key) === p) inflight.delete(key);
    });
  inflight.set(key, p);
  return p;
}

/** Invalidate one or all cache entries (call after writes that affect them). */
export function invalidateCache(prefix?: string): void {
  if (!prefix) {
    store.clear();
    inflight.clear();
    generation.clear();
    return;
  }
  for (const k of [...store.keys()]) {
    if (k.startsWith(prefix)) store.delete(k);
  }
  // Drop matching in-flight computations AND bump their generation, so when
  // the pending fn resolves it cannot repopulate the store with stale data.
  for (const k of [...inflight.keys()]) {
    if (k.startsWith(prefix)) {
      inflight.delete(k);
      generation.set(k, (generation.get(k) ?? 0) + 1);
    }
  }
}
