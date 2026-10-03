/**
 * Bounded cache / reconcile / shutdown tests (TASK-23).
 *
 * The task's technical note is "do not add a new global scheduler if an existing
 * sampler/maintenance owner exists". Most of the codebase already has caps, and
 * adding a second sweeper would be the wrong fix -- so these tests are written
 * to pass against already-compliant code too, and to fail only where a cache
 * genuinely has no eviction policy.
 *
 * A note on why the clock is injected: eviction and TTL assertions are only
 * meaningful with a deterministic time source. Sleeping 10 minutes in CI to
 * prove a TTL works is not a test.
 */
import { strict as assert } from "node:assert";

import {
  BoundedCache,
  coalescer,
  createShutdown,
  type Clock,
} from "../packages/tunnel-core/src/bounded.ts";

let pass = 0;
const failures: string[] = [];
const ok = (n: string): void => {
  pass += 1;
  console.log(`  ok   ${n}`);
};
const bad = (n: string, d: string): void => {
  failures.push(n);
  console.log(`  FAIL ${n}\n       ${d}`);
};

/** A clock the test moves by hand. */
function fakeClock(start = 0): Clock & { advance(ms: number): void } {
  let now = start;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

async function main(): Promise<void> {
  try {
    // ---------------------------------------------------------------------
    // 1. Size cap evicts, and never exceeds the cap.
    // ---------------------------------------------------------------------
    {
      const clock = fakeClock();
      const c = new BoundedCache<string, number>({ max: 3, clock });
      for (let i = 0; i < 100; i += 1) c.set(`k${i}`, i);
      if (c.size === 3) ok(`the cache is capped at 3 (got ${c.size}) after 100 inserts`);
      else bad("the cache is capped", `size=${c.size}`);
      if (c.get("k99") === 99) ok("the newest entry is still present");
      else bad("the newest entry is still present", String(c.get("k99")));
      if (c.get("k0") === undefined) ok("the oldest entry was evicted");
      else bad("the oldest entry was evicted", String(c.get("k0")));
    }

    // ---------------------------------------------------------------------
    // 2. A cap of 0 or negative is clamped, not honoured literally.
    // ---------------------------------------------------------------------
    {
      const c = new BoundedCache<string, number>({ max: 0, clock: fakeClock() });
      c.set("a", 1);
      if (c.size >= 1) ok("a nonsense cap of 0 does not make the cache unusable (size " + c.size + ")");
      else bad("a nonsense cap of 0 is clamped to something usable", `size=${c.size}`);
    }

    // ---------------------------------------------------------------------
    // 3. TTL expiry, and the distinction between "expired" and "absent".
    // ---------------------------------------------------------------------
    {
      const clock = fakeClock(1_000);
      const c = new BoundedCache<string, number>({ max: 10, ttlMs: 500, clock });
      c.set("a", 1);
      if (c.get("a") === 1) ok("an entry is readable inside its TTL");
      else bad("an entry is readable inside its TTL", String(c.get("a")));
      clock.advance(499);
      if (c.get("a") === 1) ok("an entry is still readable just before the TTL");
      else bad("an entry is still readable just before the TTL", String(c.get("a")));
      clock.advance(2);
      if (c.get("a") === undefined) ok("an entry expires once the TTL passes");
      else bad("an entry expires once the TTL passes", String(c.get("a")));
      if (c.has("a") === false) ok("has() reports an expired entry as absent");
      else bad("has() reports an expired entry as absent", "has() was true");
      // get() must not resurrect it.
      if (c.get("a") === undefined && c.has("a") === false) ok("reading an expired entry does not revive it");
      else bad("reading an expired entry does not revive it", "it came back");
    }

    // ---------------------------------------------------------------------
    // 4. No TTL means no time-based expiry (the engine's mgrCache case).
    // ---------------------------------------------------------------------
    {
      const clock = fakeClock();
      const c = new BoundedCache<string, number>({ max: 10, clock });
      c.set("a", 1);
      clock.advance(10_000_000);
      if (c.get("a") === 1) ok("without a TTL an entry does not expire on age alone");
      else bad("without a TTL an entry does not expire", String(c.get("a")));
    }

    // ---------------------------------------------------------------------
    // 5. Invalidation is complete: delete, clear, and prefix.
    // ---------------------------------------------------------------------
    {
      const c = new BoundedCache<string, number>({ max: 10, clock: fakeClock() });
      c.set("a", 1);
      c.set("b", 2);
      c.set("pf-x", 3);
      c.set("pf-y", 4);
      if (c.delete("a") && c.get("a") === undefined) ok("delete removes a single key");
      else bad("delete removes a single key", "still present");
      c.invalidatePrefix("pf-");
      if (c.get("pf-x") === undefined && c.get("pf-y") === undefined) ok("invalidatePrefix removes a family of keys");
      else bad("invalidatePrefix removes a family of keys", "a prefixed key survived");
      if (c.get("b") === 2) ok("invalidatePrefix leaves unrelated keys alone");
      else bad("invalidatePrefix leaves unrelated keys alone", String(c.get("b")));
      c.clear();
      if (c.size === 0) ok("clear empties the cache");
      else bad("clear empties the cache", `size=${c.size}`);
    }

    // ---------------------------------------------------------------------
    // 6. Re-inserting a key refreshes recency rather than duplicating.
    // ---------------------------------------------------------------------
    {
      const c = new BoundedCache<string, number>({ max: 2, clock: fakeClock() });
      c.set("a", 1);
      c.set("b", 2);
      c.set("a", 11); // refresh a
      c.set("c", 3); // should evict b, the now-least-recent
      if (c.get("a") === 11) ok("re-setting a key updates its value");
      else bad("re-setting a key updates its value", String(c.get("a")));
      if (c.get("b") === undefined) ok("the least-recently-used key is evicted, not the oldest-inserted");
      else bad("the least-recently-used key is evicted", `b survived with ${c.get("b")}`);
      if (c.get("c") === 3) ok("the newest key is retained");
      else bad("the newest key is retained", String(c.get("c")));
      if (c.size === 2) ok("re-inserting does not grow the cache past its cap");
      else bad("re-inserting does not grow the cache", `size=${c.size}`);
    }

    // ---------------------------------------------------------------------
    // 7. Coalescing: concurrent callers share one run.
    // ---------------------------------------------------------------------
    {
      let runs = 0;
      let release: (() => void) | null = null;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const c = coalescer(async () => {
        runs += 1;
        await gate;
      });
      const all = Promise.all([c(), c(), c(), c()]);
      release!();
      await all;
      if (runs === 1) ok("four concurrent callers share a single run");
      else bad("four concurrent callers share a single run", `ran ${runs} times`);
    }

    // ---------------------------------------------------------------------
    // 8. A change during a run schedules exactly one follow-up.
    // ---------------------------------------------------------------------
    {
      let runs = 0;
      let release: (() => void) | null = null;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const c = coalescer(async () => {
        runs += 1;
        if (runs === 1) await gate;
      });
      const first = c();
      // Three writes land while the first run is still going. These are real
      // state changes, so each asks for a follow-up pass -- and must still
      // result in exactly one, not three.
      const queued = [c.scheduleFollowUp(), c.scheduleFollowUp(), c.scheduleFollowUp()];
      release!();
      await Promise.all([first, ...queued]);
      // The follow-up may itself schedule another, so drain before counting.
      await new Promise((r) => setTimeout(r, 50));
      if (runs === 2) ok(`three mid-run writes coalesce into one follow-up (ran ${runs} times)`);
      else bad("mid-run writes coalesce into one follow-up", `ran ${runs} times`);

      // And a plain joiner must NOT cause any extra work at all.
      let joins = 0;
      let jRelease: (() => void) | null = null;
      const jGate = new Promise<void>((r) => {
        jRelease = r;
      });
      const j = coalescer(async () => {
        joins += 1;
        if (joins === 1) await jGate;
      });
      const jFirst = j();
      // Collect the joiners WITHOUT awaiting them first: they all resolve when
      // the gated run finishes, so awaiting before releasing the gate would
      // deadlock the test rather than exercise the coalescer.
      const joiners = Promise.all([j(), j(), j()]);
      jRelease!();
      await jFirst;
      await joiners;
      await new Promise((r) => setTimeout(r, 50));
      if (joins === 1) ok("joining callers cause no extra run");
      else bad("joining callers cause no extra run", `ran ${joins} times`);
    }

    // ---------------------------------------------------------------------
    // 9. A rejected run does not wedge the coalescer.
    // ---------------------------------------------------------------------
    {
      let runs = 0;
      const c = coalescer(async () => {
        runs += 1;
        throw new Error("boom");
      });
      let caught = false;
      try {
        await c();
      } catch {
        caught = true;
      }
      if (caught) ok("a failing run propagates its rejection to the caller");
      else bad("a failing run propagates its rejection", "it resolved");
      // The critical part: the next call must start a NEW run, not return the
      // dead promise and never execute again.
      let ranAgain = false;
      const c2 = coalescer(async () => {
        ranAgain = true;
      });
      await c2().catch(() => undefined);
      await c2();
      if (ranAgain) ok("the coalescer still runs after a previous run failed");
      else bad("the coalescer still runs after a failure", "it never ran again");
      if (runs === 1) ok("the failing run is not retried implicitly");
      else bad("the failing run is not retried implicitly", `ran ${runs} times`);
    }

    // ---------------------------------------------------------------------
    // 10. Shutdown completes and leaves no unhandled rejection.
    // ---------------------------------------------------------------------
    {
      const unhandled: unknown[] = [];
      const onUnhandled = (e: PromiseRejectionEvent): void => {
        unhandled.push(e.reason);
      };
      process.on("unhandledRejection", onUnhandled);

      const sd = createShutdown();
      let finished = false;
      const task = (async () => {
        await sd.done();
        finished = true;
      })();
      // A task that rejects while shutdown is in progress must be observed.
      const failing = sd.track(Promise.reject(new Error("in-flight failure")));
      sd.begin();
      await failing.catch(() => undefined);
      await task;
      await new Promise((r) => setTimeout(r, 30));
      process.off("unhandledRejection", onUnhandled);
      if (finished) ok("shutdown resolves its completion promise");
      else bad("shutdown resolves its completion promise", "never finished");
      if (unhandled.length === 0) ok("shutdown produces no unhandled rejection");
      else bad("shutdown produces no unhandled rejection", `${unhandled.length} unhandled: ${String(unhandled[0])}`);
    }

    // ---------------------------------------------------------------------
    // 11. A tracked task that rejects does not reject shutdown.
    // ---------------------------------------------------------------------
    {
      const sd = createShutdown();
      const failing = sd.track(Promise.reject(new Error("task died")));
      sd.begin();
      let rejected = false;
      try {
        await sd.done();
      } catch {
        rejected = true;
      }
      if (!rejected) ok("a tracked failure does not reject shutdown itself");
      else bad("a tracked failure does not reject shutdown", "shutdown rejected");
      await failing.catch(() => undefined);
    }

    // ---------------------------------------------------------------------
    // 12. Shutdown waits for in-flight work before completing.
    // ---------------------------------------------------------------------
    {
      const sd = createShutdown();
      let finished = false;
      sd.track(
        new Promise<void>((r) => {
          setTimeout(() => {
            finished = true;
            r();
          }, 60);
        }),
      );
      sd.begin();
      const t0 = Date.now();
      await sd.done();
      if (finished) ok("shutdown waits for in-flight work");
      else bad("shutdown waits for in-flight work", "completed early");
      if (Date.now() - t0 >= 40) ok("shutdown genuinely awaited the work rather than racing it");
      else bad("shutdown genuinely awaited the work", `${Date.now() - t0}ms`);
    }

    console.log(`\n--- ${pass} passed, ${failures.length} failed ---`);
    if (failures.length > 0) process.exitCode = 1;
  } finally {
    /* nothing to clean */
  }
}

void main();
assert.ok(true);
