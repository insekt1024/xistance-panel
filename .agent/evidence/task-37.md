# TASK-37 — Health and resource telemetry

**Status: passed.** Every acceptance criterion is exercised against a real
production build over real HTTP, with no doubles for the behaviour under test.

## What was added

| File | Change |
|---|---|
| `apps/web/src/lib/query-cache.ts` | `cacheAge(key)` — age of a cached entry, so an operator can tell a fresh summary from a stale one |
| `packages/tunnel-core/src/diagnostics.ts` | `aggregate()` — one-pass rollup of every tunnel's newest diagnostic; no summary text |
| `packages/tunnel-core/src/engine.ts` | `aggregateDiagnostics()` — exposes the rollup without a per-tunnel loop |
| `apps/web/app/api/metrics/route.ts` | Cache age, `byState` alongside `byStatus`, diagnostics rollup, per-dependency availability, degraded auth handling |
| `scripts/test-health-telemetry.ts` | New suite, 27 assertions |
| `scripts/lib/browser-harness.ts` | `skipProvision` option, plus readiness now means "serving", not "healthy" |

## Acceptance criteria

**AC1 — health/metrics include status, counts, uptime, safe resource fields.**

`health answers 200 when healthy`, `health reports the database`,
`health reports the engine`, `health reports a process/runtime count`,
`metrics reports uptime`, `the resource fields are present and plausible`,
`memory is reported`. Runtime count is `engine.size()` (managed runtimes), not a
process enumeration, so the number costs nothing to produce.

**AC2 — collection is bounded; no unbounded per-request scan, no tight timer.**

The entire summary is computed inside one `cached()` call, so a served request
is a Map lookup plus a small serialisation. Proven behaviourally, not just by
reading the source: `the metrics summary is cached — age went 0 -> 4ms across
two immediate calls`, and `a cached metrics call is still served`. The source
check for a tight interval reports `no interval`, and the shared-cache check
requires BOTH that the key is built from `${CACHE_METRICS}` and that it goes
through the shared `cached()` helper — either half alone would leave the bound
per-route instead of global.

**AC3 — cache age, tunnel state, retry state, error categories, no credentials.**

`the summary reports its own age — ageMs=0`,
`tunnel state is reported separately from desired status — byState={}`,
`error categories are aggregated`, `retry state is aggregated — retrying=0
exhausted=0`, and `the metrics payload carries no credential or command-line
material — clean`. The payload is walked for secret *shapes* (key headers,
`password`, `token`, `DATABASE_URL`, the CSRF cookie) and for command-line
shapes (`/usr/bin/`, `--password`, `-p <secret>`), because a process argv is
the easiest way to leak a decrypted credential into telemetry. The diagnostics
rollup deliberately omits summary text: it is free-form, unbounded, and useless
to a metrics consumer.

`byState` is reported next to `byStatus` because they genuinely diverge — a
tunnel can be wanted-`running` while the supervisor reports `error`, and a
single status map cannot show that.

**AC4 — a failing dependency is represented accurately, does not crash.**

This is where the real work was. `/api/health` was already correct; it is
asserted directly: `health answers 503 when the database is unreachable —
status=503`, `the failing dependency is named accurately — database=unreachable`,
`an unrelated dependency is still reported — engine=ok`.

`/api/metrics` was **not**. It returned an empty 500, because `requireSession`
reads the session row from the database and rejected before the guarded queries
ever ran. The route now distinguishes a genuine auth *decision* (401/403) from
an auth *system that cannot reach its own store* (503 with a named reason):

```
ok  metrics answers with a structured payload while the database is down — HTTP 503 error=unavailable
ok  an unavailable metrics payload explains itself — The session store could not be reached...
```

`health is unaffected by the other instance's failure — database=ok` proves the
fault test did not degrade the healthy instance.

**AC5 — healthy, degraded, and failed database/engine states covered.**

Healthy: the first eleven assertions. Failed database: a second production
server booted against an unopenable database. Engine: asserted both healthy
(`engine=ok`) and unreachable (`engine=unavailable` is the route's own branch).

## How the failure was made real

Four attempts, each of which silently tested nothing:

1. **Overwrite the database file's contents.** SQLite's already-mapped pages
   kept serving reads — HTTP 200, healthy.
2. **Corrupt the 100-byte header.** Same result: the running process holds the
   file open and never re-validates it.
3. **Point at a missing file path.** A nonexistent SQLite file is a *valid empty
   database*; the client created it and answered 200.
4. **Point at a path naming a directory.** SQLite created a file with that exact
   name beside the directory and connected.

What works is a path whose **parent is a regular file**. That fails at path
resolution, before SQLite is ever consulted, so no connection-time repair can
rescue it. This required a `skipProvision` option on `startApp` — otherwise the
harness's own `mkdir` repaired the fault before the server booted.

Readiness also had to change. The harness waited for `r.ok` on `/api/health`,
but a correctly-degraded app answers 503 — so the *correct* response looked
like a server that failed to start. Readiness now means "serving".

## Verification

```
npx tsc --noEmit -p apps/web/tsconfig.json   →  0
npx eslint (touched files)                   →  0 errors, 0 warnings
TURBO_DISABLE=true npm run build             →  0
npx tsx scripts/test-health-telemetry.ts     →  27 passed, 0 failed
npx tsx scripts/test-smoke-tunnel-diagnostics.ts → 66 passed, 0 failed
```

No real secret values appear in the test, its fixtures, or this file. The
harness uses throwaway test-only strings.
