# Task 77 — arm64 feasibility gate: DISCHARGED

**Date:** 2026-09-30
**HEAD:** `8e366d8` (unchanged; no commit, tag, push, or release)
**Status:** PASS — feasibility **proven feasible**; the arm64 **build itself is
still unrun** and remains a separate gate.

## The gap this closes

`.agent/prd/PRD.md` L42:

> Both `amd64` and `arm64` are required for the release artifact, subject to an
> explicit feasibility gate in TASK-1.

Two problems with the state that claim rested on:

1. **The gate was pointed at the wrong task.** TASK-1 is *"Verify project
   prerequisites and access"*; its five steps are repo, runtime, env template,
   release/test access, and gate decision. The architecture feasibility gate is
   TASK-3, whose step 4 requires: *"A feasibility check records the actual Next
   standalone output and Prisma/native dependency behavior."*
2. **The feasibility check recorded the mapping but not the behavior.**
   `.agent/evidence/release-contract.md` names `arm64` in the target-architecture
   line and mentions "the Prisma query engine" generically, but never records
   whether an arm64 engine **exists** for the pinned Prisma version. That is the
   single fact the arm64 release cell's success depends on.

So the gate was not merely unverified — it was unrecorded, and the release
matrix carried an arm64 cell whose feasibility nobody had actually established.

## The answer, from the authoritative source

Prisma resolves the engine for **the machine that generates the client**. So the
question is: does a linux-arm64 engine exist for Prisma `6.19.3`?

```text
pinned engines commit : c2990dca591cba766e3b7ef5d9e8a84796e47ab7
(Prisma 6.19.3, via node_modules/@prisma/engines-version)
```

Probed `https://binaries.prisma.sh/all_commits/<commit>/<platform>/query-engine.gz`:

| target | platform string | HTTP |
| --- | --- | --- |
| **control** x64 | `debian-openssl-3.0.x` | **200** |
| **control** x64 | `debian-openssl-1.1.x` | **200** |
| arm64 GNU/Linux | `linux-arm64-openssl-3.0.x` | **200** |
| arm64 GNU/Linux | `linux-arm64-openssl-1.1.x` | **200** |
| arm64 musl/Alpine | `linux-musl-arm64-openssl-3.0.x` | **200** |
| arm64 static | `linux-static-arm64` | **200** |

**Conclusion: arm64 is feasible.** Prisma 6.19.3 publishes native linux-arm64
query engines. The PRD's conditional clause is satisfied; arm64 is a required
target, not an optional one.

The platform strings are not guesses — they are read from
`node_modules/@prisma/get-platform/dist/*.js`, whose `binaryTargets` array lists
exactly the supported target names for the pinned version.

## Two probe defects this had to survive

Both were caught by the control, and both are the reason the earlier session
recorded "no arm64 conclusion".

### 1. Wrong input path → every probe 404'd

The first run read `enginesVersion` at the **top level** of
`@prisma/engines-version/package.json`. That field does not exist; the value
lives at `prisma.enginesVersion`. `console.log(undefined)` produced the literal
string `undefined`, the URL gained a `undefined` path segment, and **all eight
probes returned 404 — including the x64 control.**

That is the trap: with no control, eight 404s read as "arm64 is not published".
The fix is a guard that rejects a non-sha input before probing:

```bash
if [ -z "$COMMIT" ] || [ "$COMMIT" = "undefined" ]; then exit 2; fi
case "$COMMIT" in [0-9a-f]*) ;; *) exit 2 ;; esac
```

**A probe that cannot fail on a bad input is a probe that will report absence.**

### 2. Wrong platform name → arm64 "absent" when it exists

The second run used `debian-openssl-3.0.x-arm64` (an `-arm64` **suffix**). No
such target exists, so it 404'd — while the x64 control returned **200**. A 200
control with a 404 subject is genuinely ambiguous: either the subject is
unpublished, or its name is wrong.

The tie was broken by reading the authoritative `binaryTargets` list from the
installed `@prisma/get-platform`, which shows the real names are **prefixed**
(`linux-arm64-openssl-3.0.x`), not suffixed. Re-probing with the real names
returned 200 for all four arm64 targets.

**Rule: when a control succeeds and a subject 404s, you do not yet have absence —
you have an unverified name.** Get the name from the same source that produces
it, not from a plausible guess. This is the second time in this release work that
a guessed URL shape produced a false negative; the first was the `all_commits`
path itself.

## What this does NOT establish

Feasible ≠ built ≠ tested. The following remain open and are **not** claimed:

1. **No arm64 artifact exists.** The matrix cell is wired to
   `ubuntu-24.04-arm` and mutation-verified (TASK-73), but no arm64 job has run.
2. **This host cannot execute arm64.** QEMU/binfmt is not registered here:
   `docker run --platform linux/arm64 alpine` → `exec format error`, while the
   amd64 control returns `x86_64`. So arm64 staging cannot be emulated locally;
   it needs a real arm64 runner.
3. **Only the query engine was probed.** The payload also contains sharp native
   modules. Sharp resolves its own per-platform packages, and the artifact
   inspection has not been run against an arm64 tree, so sharp's arm64
   availability is unverified by this probe.

## Recorded in the release contract

`.agent/evidence/release-contract.md` now states the pinned commit, the probed
URL template, the control/subject table, and the explicit conclusion, so the
next reader gets the answer instead of re-deriving it — or, worse, inheriting the
earlier "unverified" state.

## Gate results

```text
version:check  7/7 files match 1.2.0
typecheck      0 errors
lint           0 errors, 23 warnings (pre-existing)
reconcile      --check exit 0
```

No `v1.2.0` tag, commit, push, or public release exists. All credential values
are `[REDACTED]`; this probe used only a public binaries host and the public
pinned commit sha.
