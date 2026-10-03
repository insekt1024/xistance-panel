# TASK-56 evidence — browser evidence as a repeatable release gate

## What it does

`scripts/run-browser-gate.ts` runs the browser suites in sequence and produces one
machine-readable verdict plus sanitized per-suite logs.

```bash
npm run test:browser          # release subset
npm run test:browser -- --all # every suite
npm run test:all              # same as --all
npm run test:browser -- --only smoke-routes
```

Three design decisions, all of them from the acceptance criteria rather than
convenience:

**A suite that cannot run is never a pass.** Every suite exits `77` for "could not
run here" — no Chromium, no build, no matching Prisma engine, no loopback. The gate
maps that to `outcome: "skip"` and a verdict of `incomplete`, or `partial` with
`--allow-skips`. It never becomes `pass`. Collapsing 77 into 0 is precisely how
"browser coverage" ends up claimed when only static inspection ran.

**Logs are scrubbed before they are written.** A failing browser suite can print a
page dump, and a page can contain a session value. `scrub()` runs over the whole log
before it touches disk, so an evidence file cannot carry a secret.

**The verdict says which runtime ran.** Each suite is tagged `artifact` (the staged
standalone release payload) or `source` (`next start` from the checkout). Six green
`source` suites and no `artifact` run is not evidence about the release, so the gate
exits non-zero when `artifactCovered` is false.

## The bug this found in its own first version

Pointing `XT_ASSET_ARTIFACT` at a directory with no `apply-migrations.mjs` reported:

```
--- 2. an empty artifact tree ---
exit=0
         19 passed, 0 failed
=== gate verdict: PASS ===
```

The resolution loop fell through to `dist/artifact` and tested a **different
artifact than the one it was asked about** — a result that looks completely real.
The override is now honored or refused outright:

```
Error: XT_ASSET_ARTIFACT=...\dist\artifact-bogus is not a release payload: it has
no apply-migrations.mjs. Refusing to fall back to another tree, because that would
test an artifact the caller did not ask about.
```

A second defect surfaced the same way: importing `run-browser-gate.ts` to reuse
`scrub` executed three browser suites as an import side effect. `main()` is now
guarded by `require.main === module`.

## Results

Release subset on this host (`win32 x64`, 16 vCPU, 15.8 GiB, Node v26.7.0):

```
=== xistance browser gate ===
mode: release subset
--- artifact-assets (artifact) ---
    ok   artifact-assets: pass (exit 0, 1.3s)   19 passed, 0 failed
--- smoke-routes (source) ---
    ok   smoke-routes: pass (exit 0, 27.4s)     80 passed, 0 failed
--- a11y-browser (source) ---
    ok   a11y-browser: pass (exit 0, 4.3s)      13 passed, 0 failed

=== gate verdict: PASS ===
  3 passed, 0 failed, 0 skipped
  artifact payload exercised: yes
rc=0
```

`verdict.json` (schema `xistance.browser-gate/1`) records the host, the mode, the
counts, `artifactCovered`, and per suite: name, runtime, what it covers, outcome,
exit code, duration, `passed`/`failed`, reason, and the log path.

## Honesty properties, each verified

**A stripped payload fails** — the AC4 condition, run through the gate's own entry
point:

```
--- 1. a real payload with its assets removed ---
exit=1
  FAIL /en: every asset the authenticated page references is served
  FAIL /fa: every asset the authenticated page references is served
  FAIL the Persian route's assets all load
  --- 16 passed, 3 failed ---
```

**A bogus override is refused** — exit 1, with the reason, rather than silently
testing something else.

**The scrubber removes secrets and keeps context:**

```
GET /en 200
authorization: ***
cookie: [REDACTED]
DB URL: file:./data/app.db?password=[REDACTED]
set-cookie: [REDACTED]
PRIVATE KEY [REDACTED_PRIVATE_KEY]
api_key: [REDACTED]
```

The JWT, the session cookie, the password in a connection string, the private key
and the API key are all gone; the request line survives, so a failure is still
diagnosable.

## CI and release wiring

**`.github/workflows/ci.yml`** gains a `browser` job on `ubuntu-latest`, `needs:
verify`: install deps, `npx playwright install --with-deps chromium`, `npm run
build`, build the release manifest, stage the artifact, then `npm run test:browser`.
Evidence is uploaded with `if: always()`.

The manifest step is required and not redundant: `stageReleaseArtifact` refuses
without a `release-manifest.json` in the repo root, and it does not build one
itself. The existing `Stage public and static assets` step in `release.yml` **is**
now redundant — `stageReleaseArtifact` calls `stageReleaseAssets` internally — but
it is harmless and was left in place rather than churned.

**`.github/workflows/release.yml`** runs the gate in the `artifact` job on `amd64`
only, after inspection and **before** `Create archive`, so a failing browser run
blocks publication. amd64-only is deliberate: it is the architecture the suites can
boot, and a gate that cannot run must not be recorded as having run.

Both workflows were verified to parse with a real YAML parser:
`ci.yml PARSES OK jobs: ['verify', 'browser', 'build']` and
`release.yml PARSES OK jobs: ['version', 'artifact', 'publish', 'docker']`.

## Manual fallback when a runner is unavailable

The task requires a clear fallback rather than a silent pass. There are two:

- `npm run test:browser` exits `77` and prints *"Suites could not run. Re-run with
  --allow-skips to record this as `partial` instead of `incomplete`, and do NOT
  record browser coverage for a partial or incomplete verdict."*
- Each suite can be run directly — `npx tsx scripts/test-smoke-routes.ts` — and its
  per-suite log is written to `.agent/tmp-smoke/gate-<id>/` either way.

`.agent/tmp-smoke/` is now gitignored: even scrubbed, a browser log is not source.

## Acceptance criteria

| AC | Proved by | Result |
|---|---|---|
| 1. A documented command starts the disposable app/test DB and runs the browser suite, or CI runs it automatically | `npm run test:browser`, plus the `browser` job in `ci.yml` and a gate step in `release.yml` | pass |
| 2. The gate runs on the staged/prebuilt artifact at least once before publication | `artifact-assets` suite boots `dist/artifact`; `release.yml` runs the gate before `Create archive` | pass — `artifact payload exercised: yes` |
| 3. Failures produce sanitized logs and a clear manual fallback | `scrub()` verified against six secret shapes; exit 77 + `--allow-skips` guidance + per-suite direct invocation | pass |
| 4. The release checklist links to the exact evidence file and records the environment | `verdict.json` records host and per-suite log paths; the verdict file is named in the output | pass — this file is the evidence entry point |

## Recorded gaps

**The gate has not run on `ubuntu-latest`.** The workflow is written and parses, but
no CI run has executed it — that requires a push, which is gated on the whole PRD
being complete. Everything above is from local runs on this Windows host.

**`artifact-assets` ran against `dist/artifact-local`, not `dist/artifact`.** The
release payload is single-architecture and this host is not a target, so the suite
used the local fixture described in `task-55.md`. On `ubuntu-latest` the same suite
boots the real `dist/artifact` with no fixture, which is what the CI job does.

**`source`-runtime suites use `next start`, not the artifact.** That is deliberate —
they test behaviour, and behaviour does not change between the two runtimes — but
it means the artifact-specific coverage is the `artifact-assets` suite alone. The
verdict's `artifactCovered` field exists so this stays visible rather than implied.

## Gates

| Gate | Result |
|---|---|
| `npx eslint scripts/run-browser-gate.ts scripts/test-artifact-assets.ts` | 0 errors, 0 warnings |
| `npm run test:browser` (release subset) | exit 0 — 3 passed, 0 failed, 0 skipped, artifact covered |
| Gate honesty probe | assets removed → exit 1 naming the asset checks; bogus override → refused |
| Scrub probe | 6 secret shapes removed, request context preserved |
| `ci.yml` / `release.yml` YAML parse | both parse; jobs listed above |
| Regression: `test-smoke-tunnel-diagnostics.ts` | 69 passed, 0 failed (unchanged) |
| Regression: `test-artifact-assets.ts` | 19 passed, 0 failed (unchanged) |

## Files

- `scripts/run-browser-gate.ts` — the gate: suite list, skip semantics, scrub, verdict
- `scripts/test-artifact-assets.ts` — artifact-runtime suite; override now honored or refused
- `.github/workflows/ci.yml` — new `browser` job
- `.github/workflows/release.yml` — gate in the `artifact` job before archiving
- `.gitignore` — `.agent/tmp-smoke/`
- `package.json` — `test:browser`, `test:all`, `test:artifact`, `stage:artifact`
