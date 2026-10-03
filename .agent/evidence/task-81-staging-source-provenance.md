# TASK-81 — staging read the wrong build's Prisma engines

**Status: fixed, pinned by a mutation-tested suite (4/4 killed).** Found while
producing the first arm64 artifact. It is a correctness defect in the release
path, not a test-harness convenience.

## The defect

`stageReleaseArtifact()` resolved both inputs against the local machine:

```ts
const standaloneRoot = path.join(repoRoot, "apps", "web", ".next", "standalone");
sourceRoot: path.resolve(repoRoot, options.prismaClientSource ?? DEFAULT_PRISMA_CLIENT_SOURCE),
```

Both are correct *only* when the build ran on the same machine as the staging
run. Producing the arm64 artifact from this Windows host hit it directly:

```
Generated Prisma client has no native query engine for arm64 in
…\packages\db\generated\client. Found:
  libquery_engine-debian-openssl-3.0.x.so.node,
  libquery_engine-linux-musl-openssl-3.0.x.so.node,
  query_engine-windows.dll.node.
```

**The loud failure is the safe one.** The risk is silent: payload from build A,
engines from build B. The arm allowlist from TASK-78 passes (the arm64 engine is
present), the manifest matches the digest of what was staged, and the artifact
ships an arm64 tree containing x64 and Windows engines. Every check passes and
the artifact is wrong.

## The fix

Two options, both defaulted so no existing caller changes:

- `standaloneRoot` / `--standalone <dir>` — the tree to stage from.
- `prismaClientSource` / `--prisma-client <dir>` — now **defaults to the tree
  being staged**, not the in-repo client. Without this, pointing the payload at
  one build while silently receiving another build's engines stays possible.

The repository path remains the fallback for the no-option case, which is what
every normal single-machine build uses.

## The suite: `test-stage-source-architecture.ts` (5 assertions)

| assertion | what it pins |
| --- | --- |
| an explicit standalone root is staged instead of the repo build | payload origin |
| the Prisma client defaults to the staged tree, not the repo checkout | the mixed-architecture risk |
| an explicit client source still overrides both | precedence |
| without `standaloneRoot` the repo build is still used | no regression for the normal path |
| a foreign-only client is rejected for the target architecture | the existing guard still fires, and leaves no partial artifact |

## Two assertion bugs the suite found in itself

Neither was visible without mutation testing.

**Truncated failure messages hid the reason.** `check()` printed only the first
line, so every inspection failure rendered as `Staged release artifact failed
inspection:` — a header, not a cause. The missing fixture files were invisible
until the full message printed.

**The payload-origin assertion was vacuous.** It originally compared engines in
the staged artifact. `stagePrismaClient()` runs *after* the payload copy and
overwrites the client directory, so both trees produce the same final state — the
mutant passed because the assertion read a value it could not distinguish.

Fix: each fixture tree writes a `BUILD-MARKER.txt` that exists only in that tree,
and the assertion reads it. No client-side override can fake a file that was
never copied. A sanity assertion now fails the test if the two fixtures are ever
made identical — which is exactly what had silently disarmed it.

**Lesson:** when a stage assembles an artifact from several sources, an
assertion about the result may be reading a value only one source determines.
Assert on something the *other* source cannot influence, and verify your two
fixtures actually differ.

## Mutation testing: 4/4 killed, 0 survivors, 0 invalid

External harness (`~/AppData/Local/hermes/cache/scratch/mut-stage-src.py`,
deliberately outside the repository). Baseline must PASS before any mutation is
counted.

| mutant | result |
| --- | --- |
| **m0 — the original defect verbatim** (`standaloneRoot` ignored, hardcoded repo path) | **killed** |
| m1 — client source always from the repo checkout | killed |
| m2 — explicit `prismaClientSource` ignored | killed |
| m3 — `standaloneRoot` defaults to a nonsense path | killed |

m0 survived the first run, which is what exposed the vacuous assertion. All four
die through a **named** `FAIL` line — none via a transform or parse error — and
the target file was byte-identical after every mutation.

## Second defect found in the same round: the run record could not explain itself

An aggregate run recorded only `"test-disposal-cleanup.ts (exit 1)"`. That
cannot say *which* assertion broke, so the only way to learn was to re-run the
suite. `last-aggregate-run.json` now carries `failureDetail[]` with the failing
lines per suite, plus a fallback to the error text for suites that *die* instead
of reporting a failed assertion.

Verified by deliberately breaking a suite, reading the record, and restoring the
source byte-identically. The probe immediately identified three real failures that
had been opaque exit codes:

```
test-port-forward.ts        -> ['Error: bind EACCES 0.0.0.0:61672']
test-locale-parity.ts       -> ['ReferenceError: notDefinedAnywhere is not defined']
test-lowram-cgroup-gate.sh  -> ['FAIL: >32MiB still charged after exit (leak or orphan)']
```

The first of those answers an open question. `test-disposal-cleanup.ts` had
failed once during an aggregate and passed standalone, and was recorded as a
flake with no recorded cause. `EACCES` on an ephemeral port is a **port collision
under parallel load**, not a product defect — and neither is the cgroup
accounting race in the low-RAM gate. Both are environmental contention between
suites that bind real resources.

A detail worth keeping: the fallback regex must match the **whole** error
constructor name. `ReferenceError:` has no word boundary before `Error`, so a
bare `\bError:` pattern silently misses every error subclass — the first
implementation of this fallback recorded nothing at all, and looked like a
working feature that simply had no data.

## Environment note

The scratch backup of the amd64 `release-manifest.json` was pruned, so it was
regenerated with the exact workflow inputs (version `1.2.0`, full HEAD
`8e366d808321c9f3ad41e255cc0eb5e180e141ba`, `amd64`,
`xistance-panel-v1.2.0-amd64.tar.gz`, `apps/web/.next/standalone`, Prisma
`6.19.3`). Verified: `architecture: amd64`, `releaseTag: v1.2.0`,
`schemaVersion: 1`.

## Third defect, found by the second one: a fake clock is not a real process

The new `failureDetail` immediately paid for itself by turning opaque exit codes
into named assertions. It exposed a failure in `test-retry-bounds.ts`:

```
FAIL after recovery the next failure restarts at the base delay
```

That name is misleading. Under load the assertion fails because the test's
*exhaustion* loop never accumulated enough attempts to reach the ceiling — not
because recovery-to-base-delay is broken. Three assertions in a different group
were the real ones:

```
FAIL repeated failure reaches a terminal state
FAIL no next delay once exhausted
FAIL an exhausted handle holds no pending timer
```

### The defect

```ts
for (let i = 0; i < 10; i += 1) {
  await clock.advance(10_000);        // moves VIRTUAL time forward
  await new Promise((r) => setTimeout(r, 25));  // hopes 25 ms is enough
}
```

The clock is fake; the child is real. Advancing virtual time fires the pending
timer, but spawn and exit are asynchronous and take longer than 25 ms on a loaded
machine. The handle is still mid-cycle when the loop advances again, so the retry
sequence never reaches `maxAttempts` and the handle never exhausts. The test then
asserts a product guarantee against a state the test itself prevented from
occurring. The product was correct throughout.

### The fix

Poll for the state the iteration is supposed to produce, using the `waitFor`
helper this same file already documented for exactly this class of bug:

```ts
for (let i = 0; i < 10; i += 1) {
  const before = handle.retryState().attempts + (handle.retryState().exhausted ? 1 : 0);
  await clock.advance(10_000);
  await waitFor(() => {
    const s = handle.retryState();
    return s.exhausted || s.attempts + (s.exhausted ? 1 : 0) > before;
  }, `retry cycle ${i + 1} to take effect`);
  await new Promise((r) => setTimeout(r, 5));
}
```

A second fixed sleep on the *recovery* assertion — `setTimeout(r, 40)` racing
an asynchronous `exit` event — got the same treatment.

### Proof, under the load that reproduces it

External harness (`mut-retry-race.py`), 8 CPU burners, 4 runs each, real suite
both ways:

| form | runs failed |
| --- | --- |
| original fixed sleep | **3 of 4** |
| polled for the event | **0 of 4** |

The harness restores the source byte-identically, and reports `INCONCLUSIVE`
rather than claiming success when the defect fails to reproduce — a mutant that
does not fail proves nothing.

### Two harness bugs this round, both of which faked a result

**The mutation anchor excluded the loop's closing brace.** The mutant source was
syntactically invalid, so the suite died before printing a summary. The harness
read `0 failed` from output that contained no result at all and reported it as a
pass. An empty capture and a passing run are different things — check for the
expected summary line, not just the absence of `FAIL`.

**The first mutant targeted the wrong code.** It reverted only the recovery
sleep, not the exhaustion loop that was actually failing, so once the recovery
sleep was fixed the mutant passed cleanly. Read the failing assertion's real
cause from the captured names before writing the mutation.

## Still not covered here

The arm64 **service start and persistence gate** remain unproven: the installer's
`tar` extraction fails under QEMU emulation with
`Cannot open: Invalid argument`, while a control extraction in `/tmp` succeeds.
That is an emulation limitation rather than a product defect, and diagnosing it
further required a command that was not approved. See `task-80-arm64-build.md`.

No credentials, tokens, private keys, or connection details appear in this file.