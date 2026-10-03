# TASK-117 — the low-resource gate was silently migrating nothing

**Status: fixed, mutation-proven. `RESULT: PASS`, 80 MiB peak charge under the
256 MiB / 1 vCPU cap.**

## The defect

`test-lowram-cgroup-gate.sh` invoked the migration applier with no flags:

```bash
$NODE apply-migrations.mjs > "$DBDIR/migrate.log" 2>&1
```

The real installer passes **both**:

```bash
"$NODE_BIN" "$CANDIDATE_DIR/apply-migrations.mjs" \
  --database "file:${MIGRATION_DB}" \
  --migrations "$CANDIDATE_DIR/packages/db/prisma/migrations"
```

So the applier fell back to its script-relative default — one level **above** the
artifact root — which does not exist:

```
no migrations found in /root/xt-gate-NNNN/packages/db/prisma/migrations; nothing to apply
```

…and **exited 0**.

## Why the failure surfaced 90 seconds later, in the wrong place

The gate reported `apply-migrations rc=0` and moved on. The next step failed:

```
create-admin rc=1 (85282ms)
admin creation failed: no such table: User
FAIL: admin bootstrap did not complete under the cap
```

So a missing-flag bug was reported as an **admin bootstrap failure under memory
pressure** — pointing at the memory cap, when the memory cap was never involved.
The cgroup readback showed `oom 0`, which the gate had available and did not use
to contradict the diagnosis.

This is the third instance of one shape in a row (TASK-115, TASK-116, this): **a
step that reports success while doing nothing, and a later step that reports the
consequence.**

## The fix

1. pass both flags, matching `release-install.sh` exactly;
2. **assert the schema exists** after the migration step, before anything depends
   on it.

```bash
cat > "$DBDIR/check-schema.mjs" <<'PROBE'
import { DatabaseSync } from "node:sqlite";
const path = process.argv[2].replace(/^file:/, "");
const db = new DatabaseSync(path);
const row = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='User'")
  .get();
db.close();
process.exit(row ? 0 : 1);
PROBE

if ! $NODE "$DBDIR/check-schema.mjs" "$DATABASE_URL" 2>/dev/null; then
  echo "FAIL: migrations reported success but the User table does not exist"
```

The probe is a **file**, not `node -e`. A single-quoted SQL string inside a
single-quoted `-e` argument terminates the shell string early, which produced a
syntax error 30 lines away from the cause.

`rc=0` is not proof the schema was created — an empty migrations directory exits 0
**by design**. Only the table the next step needs is evidence.

## Mutation evidence

| condition | result |
| --- | --- |
| gate as fixed | `RESULT: PASS`, 80 MiB peak, exit 0 |
| `--migrations` removed | **`FAIL: migrations reported success but the User table does not exist`**, exit 1 |
| restored | `RESULT: PASS`, exit 0 |

The mutation fails **at the migration step with the real cause**, instead of 90
seconds later at admin bootstrap with a misleading one.

## What this does not close

The gate still requires **root under WSL** (`wsl -u root`), because it writes
`memory.max`/`cpu.max` under `/sys/fs/cgroup`. An unprivileged WSL user gets
`mkdir: Permission denied`, which is correct — the constraint cannot be applied
without privilege. `run-all-tests.ts` already documents this invocation; the gate
script's own usage line says "inside WSL as root".

## The lesson

**When a step reports success, check the thing the next step needs.** Exit codes
come from the step that ran; they are not evidence about the state that step was
supposed to produce.

And: when a failure names a *resource* (memory, time, a cap), check whether the
resource was actually involved before believing it. `oom 0` was in the output the
whole time.