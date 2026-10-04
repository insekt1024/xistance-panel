# TASK-142 — the CI infrastructure gap is closed; targets are built, not assumed

The last open blocker was that `test-rollback-drill` and
`test-target-runs-shipped-payload` needed `xtinst`/`xt24` — containers that
existed only on one developer's machine. Nothing in the repository created
them. The only references to those names anywhere were the two suites that
needed them.

`scripts/create-target-os.sh` now builds them.

## It does not weaken any gate

The suites' contract was already correct and is unchanged:

- **Docker absent** → the suite SKIPS. A gate that cannot run must not be
  recorded as having run.
- **Docker present, target missing** → the suite FAILS.

Creating the targets turns a skip into a real execution. No suite became more
permissive and no skip was added.

## Four defects found by running it, not reading it

**1. The stock `ubuntu:*` images have no systemd.**

```
exec: "/sbin/init": stat /sbin/init: no such file or directory
```

Worse than a failed run: a target without an init would install a unit that
never starts and then fail readiness for the wrong reason. The script now
builds an image with `systemd` installed and **asserts `/sbin/init` exists**
before using it. Verified: stock `ubuntu:22.04` has no `/sbin/init`; the built
image does.

**2. The installer requires a `v`-prefixed version.** It failed with exactly
the message the CI install gates had:

```
Invalid version '1.2.0'. Expected an explicit semver tag such as v1.2.0.
```

Caught again by actually running the installer rather than reading the call.

**3. The rollback drill needs TWO releases.** A freshly installed target has
one, and the drill correctly refuses to pass:

```
FAIL a second release exists to roll back to
     only 1 release(s) present
```

So the release is installed twice — which is also a more faithful target, since
it now has a real upgrade history rather than being a fresh box. The installer
refuses to mutate a published release and deploys beside it, which is exactly
what the drill relies on. The script asserts the count rather than letting the
drill discover it as a confusing failure.

**4. cgroup v2 will not delegate `cpu` unless asked.** Once the low-RAM gate
ran inside a target, the next failure was specific and real:

```
/sys/fs/cgroup/xt-lowram/cpu.max: Permission denied
readback memory.max = 268435456
readback cpu.max    =
FAIL: cpu limit did not apply
```

`memory.max` succeeded in the same child while `cpu.max` was refused — the cgroup
v2 rule being that a child cannot use a controller its parent has not delegated
via `cgroup.subtree_control`. The gate now writes `+cpu +memory` into the
parent first, retrying from a detached shell because v2 forbids adding a
controller to a parent that still holds processes. It prints what the parent
delegated, and **still fails** rather than waiving the CPU cap.

## Verified from scratch

Not by inspecting the existing targets — on disposable container names built by
the script:

| check | result |
| --- | --- |
| both images built with `/sbin/init` | yes |
| both containers: systemd is PID 1 | yes |
| `/etc/systemd/system` writable | yes |
| each can create a child cgroup | yes |
| release installed, `/api/health` = 200 | yes |
| `test-rollback-drill` | **22 passed, 0 failed** |
| `test-target-runs-shipped-payload` | **5 passed, 0 failed** |
| low-RAM cgroup gate | **RESULT: PASS** — 1 vCPU / 256 MiB, peak **75 MiB**, 29% of cap |

## The low-RAM gate's placement

It cannot run on a GitHub runner — it creates a cgroup and needs root, so it
fails with `cannot create cgroup` even when every argument is correct. The
targets do satisfy both requirements, and that is probed rather than assumed.

In `run-all-tests.ts` the gate moved from `SUITES` into the existing
`ARGUMENT_TAKING` list — the mechanism this repository already uses for suites
that take real inputs and are invoked deliberately by the task that owns them
(`test-bench-sanitized`, `test-target-write-path`). It stays registered, so the
orphan check still sees it and its absence from the suite list cannot become a
silent disappearance.

For the record, the path: the gate was previously registered but invoked with
**no arguments**, so it died on its own usage line. Giving it real arguments
moved the failure from "wrong invocation" to "cannot create cgroup" — which is
the honest failure, and the one that points at the actual requirement.

## CI history this closes

| run | tally | cause of what remained |
| --- | --- | --- |
| `37149176641` | 66/76 | no archive, no arm64, `.env.local`, Windows path |
| `37157010431` | 68/76 | targets absent, `TMPDIR` assumed, arm64 absent |
| `37157837401` | 72/76 | targets absent, playwright Windows-only |
| `37160530198` | 73/76 | targets absent, cgroup gate |
| `37159792816`/`37162019048` | 75/76 | cgroup gate: `cannot create cgroup` |