# TASK-78 — Prisma engine allowlist named files Prisma never produces

**Status: FIXED and pinned.** Discovered while discharging the arm64 feasibility
gate (TASK-77). This is a defect in the *staging/inspection contract*, not in the
feasibility result.

## The defect

`PRISMA_LINUX_ENGINES` in `scripts/inspect-release-artifact.ts` is the allowlist
that decides (a) which engines staging keeps and (b) whether a staged tree has a
usable engine for the target architecture. Its `arm64` entry read:

```ts
arm64: Object.freeze([
  "libquery_engine-debian-openssl-3.0.x-arm64.so.node",   // never published
  "libquery_engine-linux-musl-openssl-3.0.x.so.node",     // an amd64 binary
]),
```

Both names are wrong.

1. `libquery_engine-debian-openssl-3.0.x-arm64.so.node` — Prisma publishes
   linux-arm64 engines under **prefixed** platform ids
   (`linux-arm64-openssl-3.0.x`), never as an `-arm64` suffix on a debian id.
   This is the same wrong guess that produced a false "arm64 is unavailable"
   reading during the feasibility probe.
2. `libquery_engine-linux-musl-openssl-3.0.x.so.node` is the **arch-free musl
   engine, an amd64 binary**. Accepting it for arm64 would let a staged arm64
   tree pass inspection while carrying an x86-64 engine.

Consequence: the arm64 release cell could never produce an inspectable
artifact — it would fail inspection on a correct build, and could pass
inspection on a wrong one.

## Ground truth

The name is built deterministically by the installed client
(`@prisma/client/runtime/binary.js`, function `so(t, e)`):

```
t.includes("windows") -> query_engine[-<id>].dll.node
t.includes("darwin")  -> libquery_engine[-<id>].dylib.node
otherwise             -> libquery_engine-<id>.so.node
```

where `<id>` is a platform id from `binaryTargets` in `@prisma/get-platform`.
So the invariant is exactly: every allowlist name is
`libquery_engine-<declared-target>.so.node`.

Published and verified against `binaries.prisma.sh` for engines commit
`c2990dca591cba766e3b7ef5d9e8a84796e47ab7` (Prisma 6.19.3):

| platform id | HTTP | verdict |
| --- | --- | --- |
| `debian-openssl-3.0.x` | 200 | x64 control — must be 200 or every 404 is uninterpretable |
| `debian-openssl-1.1.x` | 200 | x64 control |
| `linux-arm64-openssl-3.0.x` | 200 | arm64 GNU/Linux |
| `linux-arm64-openssl-1.1.x` | 200 | arm64 GNU/Linux |
| `linux-musl-arm64-openssl-3.0.x` | 200 | arm64 musl |
| `debian-openssl-3.0.x-arm64` | **404** | the name the code expected |
| `linux-static-arm64` | **404** | a declared *target* with no published query engine |

The amd64 list was already correct and is unchanged.

## The fix

```ts
arm64: Object.freeze([
  "libquery_engine-linux-arm64-openssl-3.0.x.so.node",
  "libquery_engine-linux-arm64-openssl-1.1.x.so.node",
  "libquery_engine-linux-musl-arm64-openssl-3.0.x.so.node",
]),
```

## Non-recurrence

`scripts/test-prisma-engine-targets.ts` (registered in the aggregate, now
54 suites) derives the expectation from the **installed** packages and asserts:

- every allowlist name is a well-formed `libquery_engine-<id>.so.node`;
- every `<id>` is in the declared `binaryTargets` table;
- neither list admits a cross-architecture id;
- arm64 uses the prefixed id and no `-arm64` suffix;
- arm64 musl is `linux-musl-arm64`, not the arch-free `linux-musl`;
- `linux-static-arm64` is not used as a query engine.

A Prisma rename fails this suite instead of breaking a release.

### Two ways this suite's first draft produced false results

Recorded because both would have silently weakened it:

1. **Checking against the client's pre-bundled name list.** That table only
   lists engines shipped inside the package. A valid
   `linux-musl-arm64-openssl-3.0.x` engine is *downloaded*, not bundled, so it
   looks absent and produced a false failure. The suite validates the naming
   **rule** plus the declared target set instead.
2. **A platform-id regex missing `.`.** Ids contain dots (`openssl-3.0.x`), so
   `[a-z0-9-]+` failed to match *every* name, including the proven-correct amd64
   ones. Caught because amd64 failing is implausible, not because the suite was
   known to be sound.

### Mutation testing

`killed: 5, survivors: 0, invalid: 0`, each killed by a **named assertion**
(not a crash), with the target file restored byte-identical:

| mutant | killed by |
| --- | --- |
| the original defect (guessed `-arm64` suffix + arch-free musl) | `every arm64 allowlist platform id is a declared Prisma binary target` |
| arm64 musl replaced by the arch-free amd64 musl engine | `the arm64 allowlist is free of cross-architecture names` |
| arm64 list emptied | `arm64 accepts the prefixed linux-arm64 id, not an -arm64 debian suffix` |
| arm64 claims an undeclared id (`openssl-9.9.x`) | `every arm64 allowlist platform id is a declared Prisma binary target` |
| arm64 given `rhel-arm64-openssl-3.0.x` | `every arm64 allowlist platform id is a declared Prisma binary target` |

## Still open

Discharging feasibility did **not** build the arm64 artifact. Unchanged from
TASK-77: no arm64 job has run, this host has no arm64 QEMU/binfmt, and Sharp's
arm64 native availability is unverified. This evidence covers the *allowlist*,
not the artifact.
