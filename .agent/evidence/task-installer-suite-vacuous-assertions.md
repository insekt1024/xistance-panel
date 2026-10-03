# Installer suite: three vacuous assertions found by independent review, fixed

## Verdict: 3 real test defects, all fixed and now proven to kill mutants

An independent read-only review of the test suites flagged
`scripts/test-release-installer.sh` as asserting on a bare word rather than on
the behaviour. I confirmed the claim myself before changing anything, by
deleting the real code and re-running the suite's own grep.

## The defect

`release-install.sh:477-488` applies database migrations like this:

```bash
if [[ -f "$CANDIDATE_DIR/apply-migrations.mjs" ]]; then
  info "Applying database migrations…"
  MIGRATION_DB="${DATA_DIR}/app.db"
  "$NODE_BIN" "$CANDIDATE_DIR/apply-migrations.mjs" \
    --database "file:${MIGRATION_DB}" \
    --migrations "$CANDIDATE_DIR/packages/db/prisma/migrations" \
    || die "Database migration failed. The release was not activated." 7
  ok "Database schema is up to date."
else
  die "The artifact does not include apply-migrations.mjs; refusing to activate…"
fi
```

The suite's assertion was:

```bash
if grep -qE 'apply-migrations' "$RELEASE_INSTALL_SH"; then
```

`apply-migrations` appears on **three** lines: the existence guard (477), the
real invocation (480), and the `die()` message in the `else` branch (486). The
pattern therefore matches the guard and the error text, so deleting the
migration call entirely leaves the assertion green.

**Proof.** I deleted lines 478–484 (the whole invocation, verified by asserting
the first and last deleted lines contained the expected text first, so the
mutation could not silently no-op). Result:

```
remaining apply-migrations lines:
477:if [[ -f "$CANDIDATE_DIR/apply-migrations.mjs" ]]; then
479:  die "The artifact does not include apply-migrations.mjs; refusing to activate
  ✓ release-install.sh applies database migrations before activation   <-- still green
  ✗ release-install.sh is syntactically valid bash
  --- 38 passed, 1 failed ---
```

The suite did exit 1, but **the migration assertion still passed.** The only
thing that caught the mutant was a `bash -n` syntax check firing on the empty
`if` body — an accident, not a check. A syntactically valid mutant that
replaced the call with a no-op comment would have passed the whole suite.

This is the trap the reviewer's report states and I can now confirm from the
output: a red suite is not the same as the *right* assertion firing. Reading
which assertion failed is the part that matters.

## The fix

Three assertions replacing one, each targeting a distinct property:

| assertion | what it pins |
|---|---|
| `applies database migrations before activation` | the invocation itself — `^\s*"\$NODE_BIN" "\$CANDIDATE_DIR/apply-migrations\.mjs"` |
| `passes the target database and migration set` | the `--database` and `--migrations` arguments are actually passed, so the applier cannot be invoked as a no-op |
| `a failed migration aborts activation instead of proceeding` | the `\|\| die "Database migration failed` guard still exists |

39 assertions → **41 passed, 0 failed**, exit 0 on clean source.

## Non-vacuity: three mutants, each killed by the intended assertion

Each mutation was applied to `release-install.sh`, run, then reverted and
byte-compared against a backup (`diff -q` → identical every time).

| mutant | result | killed by |
|---|---|---|
| delete the migration invocation (478–484) | 37 passed, **4 failed** | invocation + arguments + abort-on-failure (plus the pre-existing syntax check) |
| delete only the migration `--database` line | 40 passed, **1 failed** | `passes the target database and migration set` |
| replace `\|\| die "Database migration failed…"` with `\|\| warn` | 40 passed, **1 failed** | `a failed migration aborts activation instead of proceeding` |

Every mutant now fails the assertion that was written to catch it. Previously,
the second and third mutants would have passed outright.

## Methodology notes for the record

Two mutations initially appeared to be caught when they were not applied at all:

1. A first mutant used a literal `…` (U+2026) copied from the rendered file. The
   on-disk bytes are different, so the `assert old in s` guard fired, the mutant
   was never written, and the suite ran against **unmodified** source. Reported
   as "39 passed" — which reads identically to success.
2. A later mutant matched on `l.strip().startswith('--database')` and found
   **two** lines, because `create-admin.mjs` is also called with `--database`.
   The assertion caught the ambiguity rather than deleting an arbitrary line.

Both are why the mutation scripts assert on the exact line content before
writing, and both are recorded here because the failure mode is silent: a
mutation harness that does not apply its mutation reports the clean suite's
result. The first version of this file's own evidence would have claimed a
kill that never happened.

Three attempts at the same line index also produced three different meanings
(0-indexed vs 1-indexed, and the invocation vs its argument). The final working
form locates the line by content — `startswith('--database')` **and**
`'MIGRATION_DB' in line` — which is unambiguous because `create-admin` uses
`$DATA_DIR/app.db`, not `$MIGRATION_DB`.

## What this does not prove

`test-release-installer.sh` is a **static** suite: it reads the shell source and
asserts on its text. 41 green assertions mean the script contains the right
invocation, not that the installer runs correctly on Ubuntu. That needs
TASK-61 end-to-end on the target host, which is still unverified because no
target VPS is available.
