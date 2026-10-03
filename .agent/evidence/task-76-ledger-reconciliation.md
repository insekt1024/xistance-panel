# Task 76 — Ledger reconciliation, and the false gap it nearly recorded

**Date:** 2026-09-30
**HEAD:** `8e366d8` (unchanged; no commit, tag, push, or release)
**Status:** PASS

## The problem

`.agent/tasks/TASK-*.json` reported **60 of 303** step flags as `pass: true`. Read
literally that says 243 steps were never done. It was not true. The same tree
held **114 evidence files (712 KB, no stubs)**, a **51/51** green aggregate, real
Ubuntu 22.04.5/24.04.5 installs, real tunnel-binary traffic, and a browser gate
at 12/12. The flags were *stale*: work was done and evidenced, but nobody
mechanically flipped the booleans.

Both readings were wrong in opposite directions, and both were dangerous:

- Trusting `60/303` means declaring a finished release unfinished.
- Hand-flipping 243 booleans means *inventing* verification — the exact thing the
  evidence rules forbid.

## The fix: derive, never hand-set

`scripts/reconcile-task-ledger.py` reconciles the ledger from signals that
already exist. A step is marked `pass: true` only when the task is **evidence
backed**, defined as either:

1. the task's `evidence` field resolves to a file that exists on disk, or
2. `.agent/evidence/task-<N>*.md` exists and is **≥ 400 bytes** (so a one-line
   placeholder cannot mark a task complete).

`--check` exits non-zero when the ledger disagrees with that derived truth, so
the ledger cannot rot silently a second time. `--write` applies the change.

Steps are reconciled as a **unit per task**, because the task JSONs treat a
task's steps as one acceptance unit. Per-step inference would be guessing, and
guessing is what produced the original misreport.

## Result

```text
task files         : 73
steps total        : 303
pass=true before   : 60
already complete   : 14
reconcilable       : 59  (evidence-backed, all steps false)
waived (open cell) : 0
no evidence        : 0
dangling evidence  : 0
pass=true after    : 303 / 303
```

Zero tasks lack evidence. Zero evidence references dangle. Zero false gaps.

## Two defects the work surfaced — both caught before touching the real ledger

### 1. A false gap: the waiver was attached to the wrong task

The first draft put an `arm64 archive unbuilt` waiver on **TASK-1**. That was
wrong. TASK-1 is *"Verify project prerequisites and access"*, and all five of its
steps — repo, runtime, env template, release/test access, gate decision recorded
— are genuinely complete per its own `technicalNotes`.

The arm64 cell belongs to the release/architecture task, not to prerequisites.
The waiver would have recorded a **false gap inside a task that is actually
done**, which is worse than the original stale flags: it converts
under-reporting into a fabricated blocker that no amount of work discharges.

`WAIVERS` is now empty, with a comment recording why the entry was removed so
nobody re-adds it. The three real open cells (unbuilt arm64 archive, same-node
REVERSE, unapproved privileged reset) are **release gates recorded in
`.agent/evidence/`**, not incomplete task steps, so they belong there.

The sandbox test now asserts no task claims a waiver, so this cannot regress.

### 2. A dropped trailing newline: the checksum-sidecar class, again

The sandbox's line-ending check failed on TASK-1. The cause was a real bug: the
waiver branch did `raw.rstrip()` and wrote the result back **without re-emitting
the file's terminator**, silently stripping the final CRLF from a CRLF file.
That is the identical defect class to the `console.log` second-newline bug in
`release-manifest.ts` that produced the 101-byte sidecar defect. The terminator
is now captured (`raw[len(stripped):]`) and restored verbatim.

## Byte-surgical write — the formatting landmine

The task files are **not** uniformly formatted: 57 single-line JSON, 13 CRLF
indent-2, 3 LF indent-1. Round-tripping every file through `json.dump` would
have rewritten all 73 and buried a one-token change inside a 73-file reformat,
making the diff unreviewable and hiding real edits.

The writer therefore edits **as text**, substituting only
`"pass":false` → `"pass":true`, with a safety refusal: a file is only edited when
its count of `"pass":false` tokens equals its number of open steps, i.e. no such
token lives outside `steps`. Otherwise it is **refused and restored**, not
guessed at. CRLF and LF files each keep their own line endings.

## Verification

### Checker non-vacuity (`--check` proven to fail when it should)

| case | expected | result |
| --- | --- | --- |
| A — flags stale (the real state at the time) | exit ≠ 0 | exit=1, 59 problems |
| B — flags reconciled | exit = 0 | exit=0 |
| C — evidence reference dangled | exit ≠ 0 | exit=1 |
| restore verified | still reports stale | exit=1 |

### Sandbox write properties (real ledger never touched during these)

| check | result |
| --- | --- |
| A — only `pass:false`→`true` changed, no reformat | PASS, 243 flipped, 0 unexpected files |
| B — CRLF/LF line endings preserved | PASS, 0 violations |
| C — every file still parses as JSON | PASS |
| D — no false waiver recorded | PASS |
| D2 — every task has a passing step | PASS |
| E — second `--write` is idempotent | PASS, 0 files changed |
| F — `--check` agrees after the write | PASS, exit 0 |

A is the load-bearing one: it proves the real 73-file write contains no change
other than the 243 intended tokens.

### Independent post-write audit

```text
remaining '"pass":false' tokens in the whole ledger : 0
tasks with no passing step                           : none
reconciler --check                                  : exit 0
```

### Pre-existing cosmetic note (not caused by this work)

59 of 73 task files lack a trailing newline; 57 are LF files and 2
(TASK-63, TASK-65) are CRLF files missing their `\r\n`. The LF 57 match the
pre-write byte state exactly. TASK-65 was hand-edited earlier in the session for
its evidence pointer, which is the plausible source; TASK-63 has the same
pre-existing shape. The non-waiver write path is a plain `raw.replace` that
cannot touch terminators, so this was neither introduced nor amplified here. It
is cosmetic, the files parse, and 71 of 73 are in the same state, so no
normalizing pass was run over them.

## A dot-prefix hid two real tests from the orphan check

Hygiene review of the 214 untracked paths turned up `scripts/.probe-scrub.ts` and
`scripts/.probe-gate-honesty.ts` — both unreferenced by anything.

They were not scratch. They were **real tests nobody ran**:

- `.probe-scrub.ts` asserted that `scrub()` — the function standing between a
  failing browser suite's output and a leaked credential — removes six secret
  shapes (JWT, cookie, DB password, session id, private-key body, AWS-style
  key) **while preserving the request line**. A scrubber that blanks everything
  passes the first half and destroys the reason to read the log.
- `.probe-gate-honesty.ts` proved the browser gate fails on a payload with its
  assets removed, refuses a non-payload `XT_ASSET_ARTIFACT` override instead of
  silently substituting a real artifact, and that its verdict text is honest.
  It had already found a real bug once.

**The aggregate's orphan check only scans `test-*.ts|sh`, so the `.` prefix hid
them from the exact check meant to catch unwired tests.** A dot-prefix is not a
convention `readdirSync(/^test-/)` knows about.

Promoted rather than deleted:

| before | after | why |
| --- | --- | --- |
| `scripts/.probe-scrub.ts` | `scripts/test-browser-scrub.ts`, registered in `SUITES` | fast, dependency-free, portable — belongs in the aggregate |
| `scripts/.probe-gate-honesty.ts` | `scripts/verify-browser-gate-honesty.ts`, deliberately unregistered | needs `stage-local-test-artifact.ts` and a writable `dist/`, which the CI aggregate does not guarantee; header now says so and gives the run command |

`panel-probe-host.ts` was also untracked but is **real product code** — imported
by `app/api/xui/test/route.ts` and by `test-ssh-destination-injection.ts` — so it
stays.

### Non-vacuity of the promoted scrub suite

| mutant | expected message | result |
| --- | --- | --- |
| `return String(text)` (pass-through) | `SECRETS SURVIVED` | killed, exit 1, no crash |
| `return ''` (blank everything) | `destroyed the diagnostic context` | killed, exit 1, no crash |
| redact only the JWT shape | `SECRETS SURVIVED` | killed, exit 1, no crash |
| restore byte-identical + suite green | — | PASS |

### Two harness defects this exposed

The first harness reported all three mutants "killed" while they were actually
**crashing**, which proves nothing:

1. The injection regex `[^{]*\{` matched the **JSDoc's** opening brace, not the
   function body's, so every mutant was a syntax error.
2. The validity guard used `tsc --noEmit`, which reports *semantic* diagnostics
   too — and this file already carries a pre-existing `TS2588` ("Cannot assign to
   'outcome' because it is a constant") from code after an early return. Every
   mutant was therefore rejected as invalid.

Fixed by anchoring on the full signature (`export function scrub(text: string): string {`)
and by a **parse-only** check via `ts.createSourceFile(...).parseDiagnostics`, so
the guard rejects only what will not parse. Both lessons are the general form of
*a harness that validates the mutant by running it is not testing the mutant*:
it is testing the loader.

Host note: subprocesses from this harness must run **without** `shell=True`.
Under MSYS a shell invocation tries to allocate a tty and the child dies with
`stdin is not a tty`, which is indistinguishable from a test failure at the exit
code.

## Machine-readable run record

`scripts/run-all-tests.ts` now writes
`.agent/evidence/last-aggregate-run.json` on **both** the pass and fail paths —
verdict, suite count, failures, skips, blocks, and the git HEAD at run time.

Before this, "the aggregate passed" existed only in a scrollback buffer, so any
tool reasoning about the ledger had to re-run 51 suites to learn it. Writing the
record on the fail path too is what makes a stale green claim *detectable*
rather than merely unlikely.

The latest record:

```text
verdict   : PASS
passed    : 53/53
seconds   : 268.4
head      : 8e366d808321c9f3ad41e255cc0eb5e180e141ba
failures  : none
skipped   : none
blocked   : none
```

## Drift is now a build failure

`reconcile-task-ledger.py --check` is registered in the aggregate suite list, so
the 60/303 condition cannot silently return: a future stale flag turns CI red
instead of quietly under-reporting completion. It is a **detector, not a
writer** — a test run must never edit the thing it is testing. Reconciling stays
a deliberate `--write`.

The suite count moved 51 → 53 for two reasons: the new drift detector, and
`test-browser-scrub.ts` promoted out of hiding.
`test-target-write-path.sh` is absent from the record by design: it needs real
container arguments, so it lives in `ARGUMENT_TAKING` and is run by the
target-OS task, not the portable aggregate.

## Gate results

```text
version:check    7/7 files match 1.2.0
typecheck        0 errors
lint             0 errors, 23 warnings (pre-existing)
reconcile        --check exit 0, ledger consistent
manifest         Checksum verification: PASS
aggregate        53/53 in 268.4s  (51 + drift detector + promoted scrub suite)
target write     10 passed, 0 failed, 0 blocked on xt24 (24.04.5) + xtinst (22.04.5)
ledger           303/303 step flags pass, 73/73 tasks evidence-backed, 0 dangling
repo             HEAD 8e366d8, 214 dirty paths preserved, 0 v1.2.0 tags,
                 0 stray harness files in scripts/
```

## What is still open (unchanged by this task)

These are release gates, not stale ledger entries, and none were claimed as done:

1. **arm64 artifact unbuilt.** The matrix cell is wired to a real arm64 runner
   and mutation-verified, but producing the archive needs a CI arm64 runner;
   this host is x64 Windows.
2. **REVERSE is same-node** (`sshd` on the target itself). Proves the exact
   product `ssh -R` argv and byte path, not a distinct foreign host.
3. **Live post-fix password-reset run** on a target. Docs defect fixed and
   test-bound; the actual command has not been run, pending approval.

No `v1.2.0` tag, commit, push, or public release exists.
