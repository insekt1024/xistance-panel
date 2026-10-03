# TASK-115 — `apply-migrations.mjs` never found the migrations, and said "nothing to apply"

**Status: fixed and mutation-proven. A test was pinning the bug.**

## The defect

```js
const migrationsDir = path.resolve(
  options.migrations ||
    path.join(path.dirname(new URL(import.meta.url).pathname), "packages/db/prisma/migrations"),
);
```

Two independent faults, either of which alone is fatal on Windows:

**1. `.pathname` on a `file://` URL.** On Windows a file URL's pathname is
`/E:/code/...` — a leading slash. `path.dirname` on that yields `/E:`. Then
`path.join("/E:", "packages/db/prisma/migrations")` sees an **absolute** second
argument and **discards the first**, producing:

```
E:\E:\codes\Projects\Xistance-Tunnel\xistance-panel\scripts\packages\db\prisma\migrations
```

**2. A missing `..`.** Even with a correct script directory, `scripts/` is not the
repo root — the migrations are at `<repo>/packages/db/prisma/migrations`, one level
up. The join produced `…\scripts\packages\db\prisma\migrations`, which does not
exist.

## The failure mode is the dangerous one

`readMigrations()` on a nonexistent directory returns `[]`. The script then takes
the "bare invocation, nothing to apply" branch, prints:

```
no migrations found in E:\E:\...\scripts\packages\db\prisma\migrations; nothing to apply
```

…and **exits 0**.

A silent success on a release whose schema was never created. The next symptom is
`no such table: User` from a live server, with the installer long gone. This is
precisely the failure `apply-migrations.mjs` was written to prevent — and the fix
to that earlier bug introduced a route straight back into it.

It was found while building the dashboard-legibility harness, which could not
start the app: the server came up **healthy** (it creates an empty database on
connect, so `/api/health` returned 200) and only failed much later, with a **500 on
login**, because the user table did not exist.

## The fix

```js
path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "packages/db/prisma/migrations")
```

`fileURLToPath` handles the platform correctly — it is not optional here.

## The test was pinning the defect

`test-apply-migrations.ts` asserted:

```js
const bareRun = run(["--database", `file:${nested}`]);
assert.equal(bareRun.status, 0, "a bare invocation with nothing to apply is a no-op");
assert.match(bareRun.stdout, /no migrations found/, "and it must still say so");
```

That passed **only because the path was broken**. It now asserts the correct
behaviour, and additionally verifies the schema rather than a message:

```js
assert.match(bareRun.stdout, /applied \d|migrations up to date/, "...");
assert.doesNotMatch(bareRun.stdout, /no migrations found/, "the default path is wrong again");
// and the tables must actually exist
assert.ok(tables.includes("User") && tables.includes("_prisma_migrations"), ...);
```

## Verification

| check | result |
| --- | --- |
| bare invocation | `applied 20260823214332_init`, **1 applied, 1 total** |
| tables created | **11**: `User`, `Session`, `Tunnel`, `Node`, `PortForward`, `ApiKey`, `AuditLog`, `Setting`, `NotificationWebhook`, `TrafficSample`, `_prisma_migrations` |
| re-run (idempotent) | `migrations up to date` |
| from a different cwd | migrations found and applied |
| `--migrations` bogus path | still fails, non-zero |
| **mutation**: revert to `.pathname` + drop `..` | **exit 1**, failing with the exact defect text |
| `test-apply-migrations.ts` | **PASS** |

The mutation is what matters: it fails with

```
a bare invocation must APPLY the repository migrations, not report none found:
no migrations found in E:\E:\codes\...\scripts\packages\db\prisma\migrations; nothing to apply
```

so the test can no longer pass against the bug it was written for.

## Why this was never caught

Every caller that passed `--migrations` explicitly — including
`release-install.sh` — took the working branch. Only the **bare** invocation was
broken, and the bare invocation is exactly the one whose result reads like
success. `test-apply-migrations.ts` covered the bare case but asserted the broken
behaviour, so it was a **green test pinning a defect** rather than a missing test.

## The lesson

**A test that asserts a "no-op" must prove the no-op is correct, not merely that
nothing happened.** "No migrations found" is indistinguishable from "the path is
wrong". Assert the *outcome* — tables that exist — and any path regression turns
the suite red instead of green.

And: when a test's expectation is a failure mode that reads as success, suspect the
test before the code.