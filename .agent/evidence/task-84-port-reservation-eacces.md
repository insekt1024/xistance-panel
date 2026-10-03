# TASK-84 — two suites were dying on ports Windows had reserved

**Status: closed. Root-caused, fixed at the class level, and the fix is
mutation-proven non-vacuous (5/5 killed).**

## The symptom, and how it was misread

Two aggregate runs failed with no code change anywhere:

```
test-port-forward.ts     -> Error: bind EACCES 0.0.0.0:59005
test-disposal-cleanup.ts -> Error: bind EACCES 0.0.0.0:59035
```

Both had been attributed to machine load — twice, in two separate runs, with a
plausible-sounding justification each time (QEMU containers churning, CPU
burners). That reading was wrong. Load was present, but load was not the cause:
the ports are chosen, not contended.

The third occurrence, during the TASK-83 aggregate, came with a different
detail — `59005` and `59035` are both inside a contiguous block. That is not
what a collision looks like.

## The actual cause

```
$ netsh int ipv4 show excludedportrange protocol=tcp
  49673-49772   49773-49872   50202-50301   58514-58613
  58614-58713   61046-61145   61284-61383   61553-61652
  64435-64534   64535-64634   64649-64748   64786-64885

$ netsh int ipv4 show dynamicport tcp
  Start Port : 49152   Number of Ports : 16384
```

Windows allocates ephemeral ports from **49152–65535**, and Hyper-V, WSL and the
Docker networking stack reserve blocks out of **exactly that span**. A reserved
port fails with **EACCES**, not EADDRINUSE.

Every allocator in the repo did this:

```ts
const s = net.createServer();
s.listen(0, "127.0.0.1", () => { /* read the port, close, hand it on */ });
```

`listen(0)` asks the OS for a port — from the pool the reservations live in.

Measured on this host with five containers running:

| probe | result |
| --- | --- |
| explicit `0.0.0.0` bind on 61553 / 61600 / 64550 | **EACCES** |
| explicit `0.0.0.0` bind on 50010 (not reserved) | ok |
| 40 × `listen(0)` on `0.0.0.0` | min **51355**, max **51394** — 40/40 inside the reserved pool |
| 40 explicit binds in 20000–40000 | **0 failures** |

The reservations are also **dynamic**: a block appears when a container starts
and is reclaimed when it stops. That is why a suite could be green for hours and
then die with no code change — the signature I twice misread as load.

## Why retrying did not help

Both suites already retried eight times, and still failed. Measured: all eight
draws come from the same pool, so retrying cannot escape it. The retries were
luck, and eight draws is not enough to beat the odds while a container is
mid-startup.

There was a second, subtler bug in the same code. It probed on `127.0.0.1` and
then bound `0.0.0.0`:

```ts
s.listen(0, "127.0.0.1", () => { ... });   // probe
if (await bindableOnAllInterfaces(p)) ...   // then verify the wildcard
```

A wildcard bind covers loopback and is refused wherever a reservation exists, so
the loopback probe does not predict it. The forwarder binds `0.0.0.0`, so the
probe has to be the wildcard bind.

## The fix, applied to the class

New module `scripts/lib/pick-port.ts`: draw candidates from **20000–40000**,
below the ephemeral range where Windows keeps no reservations, and confirm each
on the exact interface the caller will bind.

Eleven call sites were rewritten, not the two that happened to fail:

| file | previous |
| --- | --- |
| `lib/staged-app.ts` | `listen(0)` + loopback probe |
| `lib/browser-harness.ts` | `listen(0)` + loopback probe |
| `test-port-forward.ts` | `listen(0)` × 8-retry, then a separate `bindableOnAllInterfaces` |
| `test-disposal-cleanup.ts` | `listen(0)` × 8-retry, then `canBind` |
| `test-port-allocation.ts` | local `listen(0)` copy |
| `test-auth-security.ts`, `test-rate-limit.ts` | inline `createServer().listen(0)` copies |
| `test-a11y-browser.ts`, `test-dialog-keyboard.ts`, `test-rtl-browser.ts`, `test-smoke-auth.ts`, `test-state-a11y.ts`, `test-protected-routes.ts` | local `freePort()` copies |

Seven distinct copy-paste shapes existed. Now there is one allocator.

Dead code removed: `bindableOnAllInterfaces` (superseded), the now-unused
`canBind` path, and nine `node:net` imports that nothing referenced any more.

## Verification

With all five containers running — i.e. reservations live:

```
test-port-forward.ts      32 passed, 0 failed
test-disposal-cleanup.ts  15 passed, 0 failed
test-port-allocation.ts   27 passed, 0 failed
test-pick-port.ts         10 passed, 0 failed
```

typecheck 0 errors. Lint 22 problems / 0 errors — down from a 23 baseline.

## The part that mattered: proving the test can fail

The consuming suites exercise the allocator ~15 times per run, and the defect
has a failure rate of a few percent. A suite that samples fifteen ports has a
good chance of missing it **every time**. So mutation testing was run first,
before registering anything:

```
m0-listen-zero (ask the OS)       SURVIVED
m1-loopback-probe                 SURVIVED
m2-no-confirm (skip the bind)     SURVIVED
m3-single-attempt (one try)       SURVIVED
m4-dynamic-range (use 49152+)     KILLED
```

1/5. The original defect itself was invisible to the tests that had been
failing because of it.

The fix was a property test (`test-pick-port.ts`) asserting the allocator's
contract directly over 60 draws, plus **an injected probe** so the contested
condition is manufactured instead of waited for. `pickPort` takes an optional
`PortProbe`, which is what makes retry behaviour deterministically testable at
all.

Final result:

```
m0-listen-zero: KILLED      m3-single-attempt: KILLED
m1-loopback-probe: KILLED   m4-dynamic-range: KILLED
m2-no-confirm: KILLED

killed 5/5, 0 survivors, 0 invalid
source restored byte-identically: True
```

## A fixture bug worth recording

The first version of the retry test refused ports `20000–20004` and passed
`ok` for "retried past a refusal" on a run that never touched them — the
allocator draws at random from 20001 values, so the fixture was simply not
visited. It reported a false green. The fixture now refuses the first N
candidates the allocator *actually reaches*, and asserts on the count.

The lesson is the general one: a fixture keyed to a fixed port number is not
testing a random allocator, it is testing a coincidence.

## Remaining load-dependent failures

One earlier failure was genuinely load-related and is not covered by this fix:
`test-lowram-cgroup-gate.sh` (`>32MiB still charged after exit`) is a cgroup
accounting threshold, not a port. It passes on a quiet machine and was
confirmed load-sensitive separately.

No credentials, tokens, private keys, or connection details appear in this file.
