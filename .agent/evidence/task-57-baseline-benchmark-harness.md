# TASK-57 — low-RAM baseline benchmark harness

## Verdict: all four acceptance criteria met, each by execution rather than assertion

The harness (`scripts/bench-baseline.ts`, `scripts/lib/resource-budgets.ts`,
`scripts/resource-gate.ts`) existed and ran, but TASK-57 had no evidence file, so
nothing about it had actually been *checked*. This pass verified it against a real
run rather than reading the code and agreeing with it.

## AC1 — records host, artifact, and workload identity

From a real result (`win32-x64-16vcpu`):

| field | value |
|---|---|
| platform / arch | `win32` / `x64` |
| osRelease | `10.0.26200` |
| cpuModel | `13th Gen Intel(R) Core(TM) i5-13400` |
| vcpu | `16` |
| totalMemoryBytes | `16957431808` |
| freeMemoryBytesAtStart | `5516324864` |
| swapBytes | `null` |
| nodeVersion | `v26.7.0` |
| cgroupMemoryLimitBytes / cgroupCpuLimit | `null` |
| comparable | `win32-x64-16vcpu` |
| artifact.sizeBytes | `133474925` |
| workload.digest | `f55df24ca71de319` |
| workload.controlRequests | `88` |

`swapBytes` and the cgroup limits are `null` because this is Windows with no
container limit — the *keys* are still present, which is what lets a reader tell
"no swap" apart from "never looked". The test asserts key presence, not
truthiness, specifically for this reason.

## AC2 — install/startup separate, and throughput not claimed

Phases are distinct, with install deliberately carrying **0 measured requests**
(it is setup, not work):

```
install    0 requests
startup    2 requests
control   88 requests
reconnect  3 requests
```

Install internals are broken out so setup cost is never charged to the workload:

```
migrationsMs     56.993
adminBootstrapMs 91.928
fixtureSeedMs   275.042
```

`fixtureSeedMs` is labelled as setup explicitly, because it is 3–5x the cost of
the migrations it precedes and folding it into a measured phase would have made
the harness look 4x slower than it is.

Three claims are explicitly **not** made (`notMeasured`):

- tunnel throughput
- bandwidth
- live transport re-establishment between real peers (only control-plane
  stop/status/start recovery is measured)

## AC3 — output is machine-readable and sanitized

This was the criterion most likely to be quietly wrong, because a benchmark file
is written next to the repo and read by the release gate — a secret in it becomes
a secret in a committed artifact. `scripts/test-bench-sanitized.ts` (39
assertions) checks a **real result file**, not a fixture, so it cannot pass by
construction.

11 credential classes are scanned for: JWT secret, encryption key, bearer token,
JWT-shaped triple, hex blob ≥32 chars, base64 blob ≥40 chars, private key block,
connection string, set-cookie value, password assignment, admin email literal.
Plus a recursive key scan for row-like and secret-material keys
(`passwordHash`, `encrypted`, `ciphertext`, `iv`, `salt`, …).

Result: **39 passed, 0 failed** on the real file, and 39/39 again on two
independently regenerated files.

**Non-vacuity proven.** Planted secrets into a copy:

```
FAIL no JWT secret        — found: jwtSecret
FAIL no JWT-shaped triple — found: eyJhbG...xIn0.
FAIL no connection string — found: postgres://
FAIL no admin email literal — found: admin@example.com
                            35 passed, 4 failed   exit 1
```

Stripping the `notMeasured` block:

```
FAIL the result declares what it did not measure
FAIL tunnel throughput is explicitly NOT claimed
FAIL bandwidth is explicitly NOT claimed
FAIL live peer reconnection is not claimed as measured
                            35 passed, 4 failed   exit 1
```

The first planting attempt errored (`KeyError: 'fixture'` — the real path is
`workload.fixture`) and the run exited 1 **without ever executing the
sanitization assertions**. A non-zero exit there could have been read as
"the check caught it". It caught nothing; the script died first. The
corrected run is the one recorded above.

## AC4 — baseline regenerable from a clean fixture, comparable to a candidate

Two independent regenerations from a clean fixture produced **identical**
workload digests, so the workload is deterministic and the comparison is valid:

```
regen-a  digest=f55df24ca71de319  comparable=win32-x64-16vcpu
regen-b  digest=f55df24ca71de319  comparable=win32-x64-16vcpu
```

Both sanitization-clean (39/39 each). Comparison A→B: **exit 0**.

Comparability is a hard stop, not a warning: mismatched `host.comparable` or
`workload.digest` exits **3** before any percentage is computed, because a 10%
rule applied across two different hosts measures the hosts, not the code.

## Exit-code contract, verified on real files

| invocation | exit | why |
|---|---|---|
| `--result` with no baseline | **1** | regression is a *required* budget and is unmeasured |
| `--result --baseline` (equivalent runs) | **0** | 9 pass, 0 fail; the 1 unknown is advisory |
| missing result file | **2** | usage error, never a pass |

## A correction worth recording

I initially read the output as a contradiction: `summary: 9 pass, 0 fail, 1
unknown (0 required)` printed alongside `RELEASE BLOCKED`. It is not one. The
`throughput.absolute` unknown is **advisory** — the PRD forbids absolute
throughput claims without a real representative tunnel benchmark, and none
exists. The required-unknown that blocked was **regression** on the no-baseline
path. "We did not measure it" is correctly distinguishable from "it is within
budget" (exit 1 vs 0), which is the whole point of the distinction.

## Residual limits, stated plainly

- Measured on a 16-vCPU desktop, **not** the low-RAM target. The budgets are
  defined against a documented host; these numbers do not yet prove the panel
  runs inside the budget *on that host*.
- `throughput.absolute` remains `unknown` and will stay so until a real
  representative tunnel benchmark exists (TASK-65, needs the VPS).
- No committed baseline, so `resource-gate.ts` is not yet wired into CI. That is
  TASK-70's remaining scope.
