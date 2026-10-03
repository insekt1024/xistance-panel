# CI ran 1 of 63 test suites

Found by asking a question nobody had asked in this release: not "do the tests
pass" but **"which tests does CI run?"**

## What was true

| | count |
|---|---|
| `test-*` suites on disk | 63 |
| run by CI's `verify` job | **1** (`test-optimizations.ts`) |
| run by CI's `browser` job | 12 (bundled into `run-browser-gate.ts` to share a server) |
| run by nothing in CI | **50** |

The `verify` job ran version-check, lint, typecheck, optimizations, and audit.
That is a perfectly reasonable-looking job. It is also missing every security
suite, all nine tunnel-method suites, the installer and supply-chain checks, the
release-manifest and workflow tests, and the Persian parity checker.

**This is not hypothetical.** The critical SSH option-injection finding
(`NodeConfigSchema` accepting a username beginning with `-`, which OpenSSH
executes as `ProxyCommand` — RCE on the panel host) was caught by
`test-ssh-destination-injection.ts`, which existed, ran green locally, and was
not in CI. Everything CI executed was green while a remote-code-execution path
sat in the tree.

The remaining suites were not broken or ignored so much as *unrunnable as a
set*. There was no aggregate entry point: each of the 50 had to be typed by
hand, which in practice means the handful an author remembered.

## The fix

`scripts/run-all-tests.ts` — one explicit list, runnable by a person and by CI:

- **`npm run test:unit`** / **`npx tsx scripts/run-all-tests.ts`**
- Added as a `Full local test suite` step in CI's `verify` job.

It runs 48 suites sequentially in ~220s, reports every failure rather than
stopping at the first, and exits non-zero if any fail.

### The list cannot silently go stale

This is the part that matters for the future, and it is an assertion, not a
convention: **a `test-*` file on disk that is registered in neither
`run-all-tests.ts` nor `run-browser-gate.ts` fails the runner.** Adding a suite
now requires deciding where it runs.

Proven non-vacuous — unregistering `test-ssrf-guard.ts` and running a filtered
suite:

```
  1/1 suites passed in 0.6s

  FAILURES (1):
    - test suites on disk that no gate runs (1): test-ssrf-guard.ts.
      Register each in scripts/run-all-tests.ts or in run-browser-gate.ts.
```

Exit 1, naming the exact file. It also asserts the inverse: a suite registered
in *both* runners is a double-count (and one needing a live server cannot be in
this list anyway).

### Two exemptions, both explicit and narrow

- `test-bench-sanitized.ts` takes a `<result.json>` argument; it is a *validator*
  for the benchmark harness, invoked deliberately with real inputs by TASK-57.
- `test-lowram-cgroup-gate.sh` (TASK-61) needs root and a real cgroup; it runs on
  the target Linux host. It is **registered** but excluded from the local run, so
  the orphan check keeps asking where it runs and the answer stays in the file.

## Two real defects the aggregate run exposed immediately

Running all 48 for the first time surfaced failures no single-suite invocation
had:

### 1. `test-release-workflow.ts` asserted against the wrong step

```
AssertionError: artifact upload must fail when the inspected archive is missing
'warn' !== 'error'
```

The test located the upload via `findStepAnywhere(workflow, /upload-artifact/)` —
the **first** one in the file. That is the browser-gate *evidence* upload, which
correctly uses `warn`. The *release archive* upload, one step later, correctly
uses `error`.

So the test was wrong, not the workflow. The giveaway is two lines below the
failure: it also requires a `matrix.architecture`-scoped upload path, and only
the tarball step has one — the test was describing the tarball upload all along
while selecting the evidence upload. Selection now keys on the matrix-scoped
path, and a new assertion pins the distinction: any *other* upload must be
`warn`, so evidence and release can never be confused again.

Mutation-checked both directions:
- with the fix → exit 0
- **MUTANT:** release archive upload set to `warn` → exit 1, `artifact upload
  must fail when the inspected archive is missing` (the intended assertion)
- `release.yml` restored byte-identically

### 2. `test-protected-routes.ts` cannot run on Windows — correctly

```
This host (win32/x64) needs query_engine-windows.dll.node, but the staged
artifact ships only: libquery_engine-debian-openssl-3.0.x.so.node, ...
```

This is **right behaviour**, not a bug: the artifact is single-architecture by
design. But calling it `FAIL` trains people to ignore failures, and skipping it
silently lets it rot. It is reported as `n/a (needs the release target
platform)` — and still makes the runner exit non-zero, because a platform gap
is a gap in the release evidence and must be stated rather than hidden.

## Result

```
  47/48 suites passed in 220.8s
  1 need the release target platform (Ubuntu 22.04/24.04 amd64): test-protected-routes.ts
```

Plus version-check, typecheck, lint (0 errors), and audit (0 vulnerabilities)
all exit 0.

Two of my own bugs surfaced and were fixed during this work: a `len(results)`
typo that crashed the summary, and registering `test-bench-sanitized.ts` as if
it were a standalone suite when it requires an argument.
