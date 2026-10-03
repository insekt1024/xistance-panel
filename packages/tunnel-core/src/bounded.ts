/**
 * Bounded caches, coalescing, and observable shutdown (TASK-23).
 *
 * Every long-lived Map in this codebase needs a documented answer to two
 * questions: what is the eviction policy, and what cancels it. This module
 * provides that answer once, so individual caches do not each reinvent an
 * ad-hoc cap and disagree about what "bounded" means.
 *
 * Design constraints taken from the task:
 *  - no NEW global scheduler. Nothing here creates a timer. Expiry is evaluated
 *    lazily on read, and a caller that wants eager sweeping calls `sweep()` from
 *    an existing maintenance owner. That is why the module takes an injected
 *    clock instead of owning one.
 *  - shutdown must be observable and must never reject because a task failed.
 */

export interface Clock {
  now(): number;
}

const systemClock: Clock = { now: () => Date.now() };

export interface BoundedCacheOptions {
  /** Hard cap on retained entries. Clamped to at least 1. */
  max: number;
  /** Optional time-to-live. Omit for "no age-based expiry". */
  ttlMs?: number;
  clock?: Clock;
}

/**
 * A size-capped, optionally TTL'd, LRU cache.
 *
 * Eviction is LRU rather than insertion-order because the entries here are
 * re-read constantly (status polled every few seconds, binaries probed on every
 * deploy): the entries worth keeping are the ones being used, not the ones
 * inserted first.
 *
 * No timer is created. `sweep()` exists so an existing maintenance owner can
 * reclaim expired entries eagerly, but correctness never depends on it -- an
 * expired entry is filtered on read regardless.
 */
export class BoundedCache<K extends string, V> {
  private readonly map = new Map<K, { value: V; at: number }>();
  private readonly max: number;
  private readonly ttlMs: number | null;
  private readonly clock: Clock;

  constructor(opts: BoundedCacheOptions) {
    // A cap of 0 would make the cache silently useless; clamp instead of
    // honouring a nonsense configuration.
    this.max = Math.max(1, Math.floor(opts.max));
    this.ttlMs = opts.ttlMs && opts.ttlMs > 0 ? opts.ttlMs : null;
    this.clock = opts.clock ?? systemClock;
  }

  get size(): number {
    return this.map.size;
  }

  /** True only if present AND unexpired. */
  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  get(key: K): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (this.isExpired(e)) {
      // Drop on read so a stale entry cannot be resurrected, and so a read is
      // enough to release the memory.
      this.map.delete(key);
      return undefined;
    }
    // Refresh recency.
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }

  set(key: K, value: V): void {
    // Delete first so re-setting moves the key to the most-recent slot rather
    // than leaving a stale duplicate position in insertion order.
    this.map.delete(key);
    this.map.set(key, { value, at: this.clock.now() });
    this.evictIfNeeded();
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  /** Remove every key starting with `prefix`. Returns how many were removed. */
  invalidatePrefix(prefix: string): number {
    let n = 0;
    for (const k of [...this.map.keys()]) {
      if (k.startsWith(prefix)) {
        this.map.delete(k);
        n += 1;
      }
    }
    return n;
  }

  clear(): void {
    this.map.clear();
  }

  /**
   * Drop expired entries eagerly.
   *
   * Optional and never required for correctness. Provided so an existing
   * maintenance loop (the traffic sampler, the rate-limit sweeper) can reclaim
   * memory without this module owning a timer of its own.
   */
  sweep(): number {
    let n = 0;
    for (const [k, e] of [...this.map.entries()]) {
      if (this.isExpired(e)) {
        this.map.delete(k);
        n += 1;
      }
    }
    return n;
  }

  keys(): K[] {
    return [...this.map.keys()];
  }

  private isExpired(e: { at: number }): boolean {
    return this.ttlMs !== null && this.clock.now() - e.at >= this.ttlMs;
  }

  private evictIfNeeded(): void {
    while (this.map.size > this.max) {
      // Map preserves insertion order, and `get` re-inserts on read, so the
      // first key is the least-recently-used.
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }
}

/**
 * Collapse concurrent invocations into one run.
 *
 * Callers arriving while a run is in flight join it. A call that arrives
 * *during* a run schedules exactly one follow-up, so the last write still gets
 * applied without an unbounded queue of duplicate work.
 *
 * The follow-up is chained rather than fired independently: that is what
 * guarantees "at most one pending", and it also means a failed run cannot be
 * re-entered while the previous one is still unwinding.
 */
export function coalescer<T>(fn: () => Promise<T>, onError?: (err: unknown) => void) {
  let inFlight: Promise<T> | null = null;
  let queued = false;

  const run = (): Promise<T> => {
    if (inFlight) {
      // A caller arriving mid-run JOINS that run -- it wants the state that run
      // is producing, not a second pass. Setting `queued` here (the previous
      // behaviour) made N concurrent callers cause N+1 runs, because each
      // joiner flagged a follow-up nobody had asked for.
      return inFlight;
    }
    const p = (async () => {
      try {
        return await fn();
      } finally {
        inFlight = null;
        if (queued) {
          queued = false;
          // Chained onto the finished run, and its own rejection is routed to
          // onError so a failed follow-up cannot become an unhandled rejection.
          void run().catch((e) => onError?.(e));
        }
      }
    })();
    inFlight = p;
    return p;
  };

  /**
   * Request exactly one follow-up run, if none is already pending.
   *
   * This is the correct entry point for a write that lands while a reconcile is
   * in flight: that write genuinely was not seen by the run in progress, so a
   * second pass is required. It is deliberately distinct from calling `run()`
   * again, which means "join the run already happening".
   */
  const scheduleFollowUp = (): Promise<T> => {
    if (!queued) queued = true;
    return run();
  };

  return Object.assign(run, { scheduleFollowUp });
}

export interface Shutdown {
  /** Register in-flight work that shutdown must wait for. */
  track<T>(p: Promise<T>): Promise<T>;
  /** Signal that shutdown has begun; `done()` resolves once work settles. */
  begin(): void;
  /** Resolves when tracked work has settled. Never rejects. */
  done(): Promise<void>;
  /** True once `done()` has resolved. */
  readonly isDown: boolean;
}

/**
 * Track in-flight work so shutdown can wait for it, without ever rejecting.
 *
 * `track` is what makes an in-flight failure observable *without* letting it
 * become an unhandled rejection at shutdown time: the promise is registered
 * with a handler immediately, so Node has a consumer even if the original
 * caller has long since gone away.
 */
export function createShutdown(): Shutdown {
  const pending = new Set<Promise<unknown>>();
  let resolveDone: (() => void) | null = null;
  let started = false;
  let down = false;
  const donePromise = new Promise<void>((r) => {
    resolveDone = r;
  });

  const settle = (): void => {
    if (started && pending.size === 0 && !down) {
      down = true;
      resolveDone?.();
    }
  };

  return {
    track<T>(p: Promise<T>): Promise<T> {
      // Register a settled-marker so we know when the work is finished without
      // caring whether it resolved or rejected.
      const marker = p.then(
        () => undefined,
        () => undefined,
      );
      pending.add(marker);
      marker.then(() => {
        pending.delete(marker);
        settle();
      });
      return p;
    },
    begin(): void {
      started = true;
      settle();
    },
    done(): Promise<void> {
      if (down) return Promise.resolve();
      return donePromise;
    },
    get isDown(): boolean {
      return down;
    },
  };
}
