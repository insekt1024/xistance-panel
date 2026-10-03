# TASK-31 evidence — DIRECT method coverage

**Status:** passed

## Summary

Two defects, one of them a false alarm I had to discard.

| Finding | Real? | Verdict |
|---|---|---|
| `bindAddr`/`targetHost` unvalidated, interpolated into a gost URL | yes | fixed at schema + builder |
| IPv6 literals emitted unbracketed (`tcp://::1:8080`) | yes | fixed |
| A dead DIRECT tunnel reports `running` forever | **no** | my test fixture was wrong |
| A process cache memoises `true`, so a death can go unnoticed | yes | fixed (found while chasing the above) |

---

## 1. Unvalidated address fields

`DirectConfigSchema` declared both fields as bare `z.string()`, and
`buildDirectCommand` interpolated them straight into a URL:

```ts
const bind = cfg.bindAddr && cfg.bindAddr !== "0.0.0.0" ? cfg.bindAddr : "";
return ["gost", "-L", `${cfg.protocol}://${bind}:${cfg.listenPort}/${cfg.targetHost}:${cfg.targetPort}`];
```

A `/`, `?`, `#` or `@` in either field silently corrupts the URL gost is
handed. Fixed at **both** boundaries, because the builder is reachable
internally and the schema is the only thing the API enforces:

- `packages/types/src/index.ts` — `directAddress` schema: hostname / IPv4 /
  IPv6 literal, plus explicit refusals for whitespace, control characters, URL
  delimiters, a scheme, and a leading `-` (which a URL authority would read as
  a port separator).
- `packages/tunnel-core/src/config/direct.ts` — `assertSafeDirectAddress()`,
  called from `buildDirectCommand` before any string is concatenated.

### Argv injection is not possible here, and that was checked

`process.spawn` is called with an argv **array** and no `shell: true`, so a
space or newline in a field cannot start a second command. I confirmed this
with a probe before writing the tests rather than asserting it. The defect is
URL corruption, not RCE — recorded here so the severity is not overstated.

## 2. IPv6 literals

`bindAddr: "::1"` produced `tcp://::1:8080`, which is ambiguous: the authority
terminator is missing, and `tcp://:8080/::1:80` does not parse as a URL at
all. `authorityHost()` now brackets any IPv6 literal and leaves a `::`
wildcard empty (the IPv6 equivalent of `0.0.0.0`, which already dropped out).

`isIpv6Literal` and the schema's discriminator both key on "contains a colon"
and must agree on ordering — the hostname pattern would otherwise reject every
IPv6 address, which is exactly the bug the first version of the fix had.

## 3. The false alarm: "a dead tunnel reports running"

An early version of the suite killed `handles[0]` after a re-deploy and saw
`running`. The conclusion I drew was **wrong**: `deploy()` creates a *new*
handle and disposes the old one, so I was killing a handle the engine had
already dropped while the tracked process was still alive. Instrumenting
`isRunning()` showed `handles created: 2`.

The corrected test kills the latest handle and passes without the product
change. Recorded because the "fix" I wrote for it (negative-only memoisation)
turned out to be independently correct — but it was found for the right reason
only after the fixture was fixed.

## 4. Memoising a positive process answer (real, found while chasing #3)

`computeStatus` cached **both** answers from `isRunning()`. A cached `true` is
a claim that a process was alive; processes die. Worse, the recompute
re-seeded the same stale `true`, so no TTL could ever clear it — a dead tunnel
would report `running` on every poll, indefinitely.

`STATUS_CACHE_TTL` (1.5s) and `PROCESS_RUNNING_CACHE_TTL` (3s) are close enough
that this is a real window, not a theoretical one.

Fix: only **negative** answers are memoised. A `true` is re-probed every
`computeStatus`. The invariant is that no long-lived cached `true` exists for a
recompute to re-read, so correctness no longer depends on the relative TTLs.

This required an injectable clock (`EngineOptions.clock`, wired to all three
`BoundedCache` instances) — otherwise proving expiry means sleeping seconds per
assertion, and the easy alternative is to assert only the cached path, which is
precisely the path that can lie.

## 5. Error-message ordering

`targetHost: "tcp://1.2.3.4"` contains `/`, so the delimiter check fired first
and told the operator a `/` was invalid. True, and useless — they had pasted a
URL where a bare address belongs. The scheme check now runs first in **both**
the builder and the schema, so the actionable message wins.

The suite asserts the exact message per layer. `builderMsg()` deliberately does
not go through the schema-parsing helper: an earlier version mixed the two and
failed for the wrong reason.

---

## Tests: `scripts/test-direct.ts` — 49/49

Covers schema and builder validation independently, IPv6 and wildcard
bracketing, URL delimiter/scheme/whitespace/dash/malformed-hostname refusals,
message ordering per layer, the real `TunnelConfigSchema` discriminated-union
path (including that the parsed output is what the builder consumes, with
defaults applied), and a real engine lifecycle:

- deploy → `running`
- `stop()` → `stopped`, and exactly one stop issued
- repeated `status` stays `stopped`
- re-deploy → `running` again, with a distinct handle
- a process that dies is not reported `running` after the memo expires
- `remove()` → `stopped`

### Mutation testing — 8 mutants, all killed

| Mutant | Change | Result |
|---|---|---|
| A | drop IPv6 bracketing | 8 fail |
| B | drop builder delimiter check | 4 fail |
| C | drop builder validation calls | 10 fail |
| D | schema drops delimiter refine | 1 fail |
| E | schema drops scheme refine | 2 fail |
| F | schema drops leading-dash refine | 1 fail |
| G | builder drops leading-dash check | 1 fail |
| H | engine memoises positive answers | 2 fail |

Two rounds of false results came from **stale mutants** — generated from an
earlier copy of the source. All were regenerated from the current file, and the
generator now asserts each mutant actually differs from its source, which
caught one no-op.

Mutants D and F initially survived because the suite called
`DirectConfigSchema` directly, but production only ever reaches it through
`TunnelConfigSchema`. Adding the union-path section killed both.

## Dependency correctness

`test-frp.ts` imports `smol-toml`, which had been installed with
`--no-save` and existed only in this machine's `node_modules`. A clean CI
checkout would have failed on it. Now declared as a `devDependency` with a
`package-lock.json` entry, verified by running `npm ci` against the two
manifests alone in an empty directory — `smol-toml` resolved.

That lock refresh also corrected pre-existing drift: the lock said `1.1.1`
while the source is `1.1.2`.

## Gate

```
test-direct            49/49      test-bounded-caches     29/29
test-port-forward      29/29      test-diagnostics        22/22
test-forward-reconcile 26/26      test-disposal-cleanup   15/15
test-backhaul          39/39      test-retry-bounds       23/23
test-frp               28/28      test-tunnel-lifecycle   21/21
test-gost              37/37      optimization harness    77/77
test-ssh               50/50      line endings            54/54
test-port-allocation   27/27
typecheck  clean        lint  0 errors, 14 warnings (none in TASK-31 files)
tunnel-core build      clean        version:check  7/7 match 1.1.2
```

## Not claimed

- No real gost process forwarded traffic for this method. The engine tests use
  an injected `ProcessHandle` and a fixture `gost` on disk; no packets crossed a
  DIRECT tunnel.
- The 1.5s window in which a just-died process still reads `running` is
  unchanged and is a deliberate cache trade-off, asserted as documented
  behaviour rather than papered over.
