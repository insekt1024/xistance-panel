# TASK-23 evidence — bounded caches, reconciliation, and shutdown

**Status:** passed

## Step 2 first: the full inventory

| Map / Set | Owner | Policy before | Verdict |
| --- | --- | --- | --- |
| `query-cache.ts` `store` | web | `MAX_ENTRIES = 500`, O(1) LRU | already bounded |
| `query-cache.ts` `inflight`, `generation` | web | deleted on settle / invalidate | compliant |
| `rate-limit.ts` `buckets` | web | `MAX_BUCKETS = 10_000` + `setInterval` sweep | already bounded |
| `auth.ts` `sessionCache` | web | `MAX_CACHE_ITEMS = 2_000`, TTL 3 s, gated GC | already bounded |
| `traffic.ts` `buckets` | web | request-scoped, released on return | not a leak |
| `forward-supervisor.ts` `active` | web | keyed by node id; deleted in the stop path | compliant |
| `forward-supervisor.ts` `nodeCache` | web | single slot + 30 s TTL | compliant |
| `engine.ts` `runtimes` | engine | deleted on stop / remove / failed deploy | compliant |
| `engine.ts` `mgrCache` | engine | keyed by node name, **never evicted** | bounded by node count |
| `engine.ts` `systemBinCache` | engine | **TTL only, never evicted** | **real gap** |
| `engine.ts` `statusCache` | engine | TTL only, deleted on lifecycle change | **real gap** |
| `engine.ts` `processRunningCache` | engine | TTL only, deleted on stop | **real gap** |
| `eventbus.ts` `listeners` | engine | map entry deleted when the set empties | compliant |
| `forwarder.ts` `sockets` / `flows` | forwarder | per-handle, released in `stop()` | TASK-21 |

Three engine caches had a TTL but **no size cap**. A TTL is not a bound: a
panel that polls a large number of distinct tunnels accumulates an entry per
tunnel for the full TTL window regardless of how long anything has been idle,
and under a burst the peak is set by request rate, not by cache design.

## What was implemented

`packages/tunnel-core/src/bounded.ts`:

- **`BoundedCache`** — size cap plus optional TTL, LRU eviction. `max` is
  clamped to ≥1 so a nonsense `0` cannot silently make the cache unusable.
- **`coalescer`** — shared run-collapsing for reconcile.
- **`createShutdown`** — observable, non-rejecting shutdown.

Applied to the three engine caches (500 / 1 000 / 2 000 entries), each keeping
its existing TTL, so no existing behaviour changed beyond the new ceiling.

## No new global scheduler

The task's note forbids adding a scheduler. `BoundedCache` creates **no timer
at all** — expiry is evaluated lazily on read, and `sweep()` exists so an
existing maintenance owner can reclaim eagerly if it wants to. The time source
is injected, which is also what makes the TTL assertions testable without
sleeping ten minutes in CI.

## A coalescing bug the tests found

The supervisor's hand-rolled coalescer set `queued = true` for **any** caller
arriving mid-run. That made N concurrent callers cause N+1 runs: every joiner
flagged a follow-up nobody had asked for. A caller arriving mid-run now simply
joins — it wants the state that run is producing. `scheduleFollowUp()` is
reserved for the one case that genuinely needs a second pass: a rule write that
landed after the in-flight run had already read the database.

`forward-supervisor.ts` now delegates to the shared helper instead of keeping
its own copy.

## A regression this caught in TASK-20's code

Changing the coalescing semantics surfaced a real defect in `startSerialized`:
an explicit `start()` that arrived while a respawn was in flight returned early
and **never reset the backoff streak**. An operator pressing "start" after a
crash loop would join the in-flight respawn and the streak would not clear.
A respawn still returns early (joining is correct); an explicit start now falls
through and resets.

This is the second time a change in one task has exposed a defect in the
previous task's code, and it is why the full suite is run every time.

## Non-vacuity — and one that had to be rewritten

`test-bounded-caches.ts` covers cap eviction, TTL boundaries (inside, just
before, just after), a nonsense cap, no-TTL behaviour, prefix invalidation,
LRU-vs-insertion-order, coalescing, follow-up scheduling, rejection handling,
and shutdown.

The **joiner** test deadlocked the suite on its first run: it awaited
`Promise.all([j(), j(), j()])` before releasing the gate, and all three resolve
only when the gated run finishes. The test was collecting promises it should
have awaited afterwards. The suite silently stopped mid-file and still exited
`0` — the same green-but-not-finished pattern as before, caught only because I
checked for the summary line rather than the exit code.

The shutdown tests assert against a real `unhandledRejection` listener, and
verify shutdown genuinely waited (elapsed-time assertion) rather than racing.

## Verified

- `test-bounded-caches.ts` — 29/29
- `test-diagnostics.ts` — 22/22
- `test-disposal-cleanup.ts` — 15/15
- `test-retry-bounds.ts` — 22/22
- `test-tunnel-lifecycle.ts` — 21/21
- `test-optimizations.ts` — 77/77
- `typecheck`, `lint`, line endings 54/54 — pass

**24/73 tasks passed.**
