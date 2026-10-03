# TASK-107 — the rollback drill, executed on both target OSes

**Status: 20/20, exit 0, on Ubuntu 22.04.5 and Ubuntu 24.04.5 amd64.**

PRD section 15 requires "Installation/readiness and **update/rollback drills** pass
on the real Ubuntu VPS". Installs and updates were proven (TASK-90, TASK-98), but
**`xt-rollback` had never been invoked on a target.** The release *installs* the
helper on every run, so its presence was asserted — an installed-but-unexecuted
operator command is a documented intent, not a passing drill.

## What the drill asserts, per target

| # | property | result |
| --- | --- | --- |
| 1 | the rollback helper is installed and executable | ok |
| 2 | the panel is healthy **before** the drill | ok |
| 3 | rollback to a **non-existent** release is refused (`rc=1`) | ok |
| 4 | the refused rollback left `current` **untouched** | ok |
| 5 | rollback to a real previous release succeeds (`rc=0`) | ok |
| 6 | `current` now points at the rolled-back release | ok |
| 7 | the panel is healthy **after** rollback (200) | ok |
| 8 | the API still refuses unauthenticated access (401) | ok |
| 9 | `active-release.json` swapped `active`/`previous` — **reversible** | ok |
| 10 | the panel is returned to the release that **ships** | ok |

Case 3/4 matter most: an operator must not be able to point the panel at a hole,
and a refusal must not disturb the running release.

## Two real defects in my own suite, both found by running it

### 1. A two-writer bug that only showed on the second target

The suite writes a small Node helper (`xt-list-releases.mjs`) that the target
runs to enumerate releases and their payload digests. I wrote it at module scope
**and** re-wrote it inside the per-target loop — the second write happening
*after* the `docker cp`, so:

- the first target received the good file,
- every later target silently received the **previous run's** file.

The symptom was `no release carries payload e731bc6068600941; found 0 release(s)`
on `xt24` only, with `xtinst` passing 10/10 in the same run. A defect that
appears on the *second* iteration is almost always state carried between
iterations. One writer, one artefact.

### 2. Restoring by directory name does not work

My first restore step called `xt-rollback <the release that was active before>`.
That failed on both targets. `xt-rollback` moves to the recorded **`previous`**,
so after the drill the original release is the drilled release's *parent*, not a
movable target — naming a directory is not enough to get back.

Fixed by identifying the shipping release by its **payload digest** (what it
actually contains) rather than by directory name, which is also immune to
directory ordering changing between runs.

### 3. A template literal that could not hold a newline

The emitted helper was built with a backtick template literal containing `\\n`.
The escape kept collapsing, so the generated file shipped an unterminated string
literal and died on the target with `SyntaxError: Invalid or unexpected token`.
Rebuilt as an array of lines joined with `String.fromCharCode(10)`, which cannot
collapse. This is the same class as the earlier `console.log("\n")` trap noted
in `renderChecksumFile`: a newline written by accident is a second line.

## Idempotence

The suite is safe to re-run: it ends by returning the panel to the shipping
release and asserting the payload digest matches, so a second run starts from the
same state as the first. Confirmed by the run above following three prior
partially-failed runs.

## What this closes

The update/rollback drill half of the PRD §15 KPI is now proven on both required
target OSes, by executing the real installed operator command — not by asserting
that the file exists.

## What it does not close

1. The release workflow has still never executed on a real runner.
2. Native arm64 is proven only under QEMU (with a `bsdtar` shim for the install).
3. The approval-gated distinct-host `REVERSE` proof and the live password-reset
   command remain unexecuted.
