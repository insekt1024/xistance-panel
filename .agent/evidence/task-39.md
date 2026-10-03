# TASK-39 — Update and recovery audit records

## Status

**PASSED.** `npx tsx scripts/test-release-audit.ts` → **28 passed, 0 failed,
0 skipped**, exit 0, against the real production build over HTTP. Typecheck and
targeted ESLint clean. TASK-39 is marked passed.

## The gap

The panel audited its own actions (`tunnel.create`, `user.delete`,
`webhook.update`) but not the actions an operator performs *on the running
installation*. An update, a migration, a readiness probe, a rollback and a
restore all change what is deployed, and none of them left a record. After an
incident the first questions are "what changed, when, and did it work" — and
none of those had an answer in the trail.

## Integration point

`apps/web/src/lib/release-audit.ts` — a recorder over the EXISTING `AuditLog`
table.

No migration. The existing schema (`actorId` / `action` / `target` / `details` /
`ip` / `createdAt`, indexed on `actorId+createdAt`, `createdAt`, and `action`)
already represents the event; what was missing was a caller. The task's own
technical note says not to add a table if the existing action metadata can
represent the event, and it can.

## Design decisions

**1. Record the outcome, not the attempt.** A row is written only once the
action's result is known. An audit row written before the work says
"update.started", the process is then killed, and the trail claims an update
happened with no way to tell which half. Every failure action therefore carries
a `.failed` suffix, and the absence of either `X.ok` or `X.failed` is itself the
signal that the process died mid-update.

**2. Allowlisted details.** Only a fixed key set (`version`, `from`, `to`,
`outcome`, `errorCategory`, `attempts`) is serialised, with deterministic key
order. An allowlist, not a denylist: a denylist of "password" and "token" misses
`--private-key`, `DATABASE_URL` and whatever the next caller invents.

**3. Bounded error categories.** A thrown value is reduced to one of ten
categories by `classifyError()`; the raw message is never persisted. A raw
Prisma or SQLite error can embed a file path, a fragment of SQL, or an argument
that is a password — all of which would land in a table an admin can read. The
full message goes to the service log via `console.error`, where it belongs.

**4. No fabricated actor.** `update.sh` over SSH has no logged-in user, so
`actorId` is null. An unattributed system action is real information; inventing
a user id for it would be a lie.

## Defect found while wiring this up

`apps/web/src/lib/maintenance.ts` prunes `AuditLog` rows older than 90 days.
That is right for day-to-day actions, but it would have deleted exactly the
release records answering "which version has this box run for the last six
months?". The prune now excludes `RETAINED_RELEASE_ACTIONS` by action rather
than extending everyone's retention window.

## Call site

`apps/web/app/api/settings/backup/route.ts` — a backup export is the one
release-lifecycle action the panel itself performs, so it records
`release.restore` alongside the existing operator-facing
`settings.backup-export` row.

## Verification

| Acceptance criterion | Proved by |
|---|---|
| AC1 — fields present, no secrets | allowlist check, closed category set, `no record contains a secret-shaped value — 71 rows walked` |
| AC2 — recorded only after the outcome; survives pagination | `a record exists only for a completed action`, `records survive pagination — page1=50 page2=1, no overlap`, `a recovery record is reachable past the first page — release.rollback.failed on page 2` |
| AC3 — failures queryable, attempted ≠ completed | `a failed rollback is distinguishable from a successful one — 3 ok / 6 failed, no action reused` |
| AC4 — authorization | `the audit API refuses an unauthenticated caller — HTTP 401`, `the audit API refuses a non-admin — HTTP 403`, per-user rate limit |
| AC5 — full matrix | all seven ok/failed outcomes recorded; `a host-side action is recorded with no fabricated actor — 9 records, actorId null` |

Two properties are asserted that were previously untested and that the filler
rows exist to force: the release records are seeded BEFORE the filler so they
fall onto page 2, and the matrix walks the whole trail rather than page 1. A
matrix reading only page 1 reported seven outcomes "missing" that were merely
paginated away — a false negative that looked like a broken recorder.

## Two real defects this suite found

### 1. `Checks.ok(name, extra)` silently discarded a third argument

The harness signature was `ok(name, extra)`. Call sites written as
`ok(name, condition, extra)` had their boolean **dropped**, so the check reported
`ok` regardless of the condition — three assertions in this suite were vacuous
for exactly that reason, and they printed as passing while asserting nothing.

Fixed by adding `expect(name, condition, extra)` as a *separate* method rather
than an optional parameter. A boolean argument that can be forgotten is a
vacuous assertion that reports success either way; a method named `expect`
cannot be called without a condition. `ok()` keeps its two-argument form for the
274 existing call sites that use it inside a real `if`/`else` branch.

### 2. The suite was writing to the developer's local database

`packages/db/src/index.ts` falls back to `packages/db/prisma/dev.db` when
`DATABASE_URL` is unset. The unit section imported the recorder — which chains
through `src/lib/api` to `@xistance/db` — **before** setting the URL, so the
module singleton locked onto the dev default. Each run appended its release
records to that file: **87 stray rows** had accumulated, while the HTTP
assertions read an empty harness database and reported "the recorder writes
nothing" — pointing at the recorder when the fault was the test's own wiring.

Fixed by setting `DATABASE_URL` and clearing `globalThis.prisma` at the very top
of `main()`, before any import of the package. **Import order, not statement
order, decides which URL the client is built with**; the assignment had to move
above the first dynamic import, not merely above the assertion that read the
count. A `PRAGMA database_list` assertion now guards the binding on every run,
because this failure mode is entirely silent.

The 87 rows were deleted. The user's own 4 rows in that file were left intact
(verified: `auth.login` ×3, `sec.test-action` ×1).

## Also fixed in the shared harness

`Checks.skip()` called `process.exit`, discarding every result collected so far:
the run ended with no `--- N passed, M failed ---` summary at all, so genuine
failures above the skip were invisible. It now records the skip and continues.

`scripts/test-smoke-nodes-tunnels.ts` used that same `skip()` to bail out when
there is no production build or no Chromium. Those are "cannot run at all"
bail-outs, not partial coverage, so they got a local `bail()` that still exits
with `EXIT_SKIP`; otherwise the suite would have run with no browser and reported
a wall of vacuous passes. Verified: `24 passed, 0 failed`.

## Not covered

Retention is asserted structurally — the retained-action set is excluded from
the prune predicate and that relationship is checked directly — not by running a
90-day clock. No mutation coverage for this task.

## Notes

- The XUI private-network SSRF exception and all existing audit schema and
  indexes are untouched.
