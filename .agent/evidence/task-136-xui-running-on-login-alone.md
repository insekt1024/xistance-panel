# TASK-136 — XUI reported `running` on the strength of a login alone

## The defect

`packages/tunnel-core/src/xui-sync.ts` — the module whose header states its whole
purpose:

> Before this module, `planXui` wrote a pointer file and reported `running` —
> meaning a tunnel was "running" when the panel URL was a typo and the credentials
> were wrong, as long as a deploy had been issued.
>
> The rule here: `running` means a real inbound was fetched from the panel and
> that inbound is up.

The code contradicted that rule. When no `inboundId` was configured, the function
returned a fabricated inbound marked **up**:

```ts
// 2. Fetch the inbound. Without one, a successful login is all we can
//    prove -- and that is genuinely less than "running".
if (cfg.inboundId == null) {
  return { ok: true, kind: "ok", loginPath, inbound: { id: 0, up: true } };
}
```

`classifyXuiSync` maps `up: true` → `"running"`. So a tunnel with **no inbound
verified at all** was reported to the operator as RUNNING — the exact failure the
module exists to prevent, arriving through a different door. Verified directly:

```
login succeeded: true | inbound reported: {"id":0,"up":true}
classify       : running
=> the UI says a tunnel is RUNNING on the strength of a login alone
```

This is the method the PRD covers by configuration, lifecycle and UI rather than
binary traffic, so its status semantics *are* its correctness surface — there is no
tunnel process whose liveness would catch it.

## The fix

`up: false` on a login-only sync, which maps to `degraded`. A login proves the
**panel** is reachable; it says nothing about a tunnel being up.

All three states verified after the change:

| situation | classified |
| --- | --- |
| login succeeds, no `inboundId` configured | `degraded` |
| inbound fetched, `enable: true` | `running` |
| inbound fetched, `enable: false` (stopped) | `degraded` |

The two positive controls matter as much as the fix: without them, "never report
running" would be satisfiable by downgrading every healthy XUI tunnel.

## Gates added (`scripts/test-xui.ts`)

Four assertions: a correct-credentials login still returns an `ok` sync; it is
**not** classified `running`; a verified enabled inbound **is** still `running`; a
verified disabled inbound stays `degraded`.

**Mutation:** restoring `up: true` → **54 passed, 1 failed**, exactly the
classification assertion. The positive controls stayed green, which is correct —
they test the other two paths.

Note the suite already asserted *"an unverified XUI tunnel is not reported
running"* — but only for the **unreachable-panel** case. The login-succeeds case,
which looks healthy and is the one that matters, had no coverage. That is why a
test suite can be green and the defect still real.

Two import/assertion errors of my own surfaced on first run (`syncXui is not
defined`, since the name appeared only in comments) and were fixed before the
suite could report.

## Results

| check | result |
| --- | --- |
| `scripts/test-xui.ts` | **55 passed, 0 failed** (was 51) |
| mutation (`up: true` restored) | 1 failed — gate catches it |
| typecheck / lint | 0 errors |

## Follow-up: where the status is ACTUALLY decided

After fixing `syncXui`, the engine looked like a second half of the same bug —
`planXui` branched on `result.ok` (true for a login that confirmed nothing) and
published `running`. I changed it, wrote an engine-level gate for it, and **the
mutation of that change did not fail the gate**. That is the interesting result,
and it is why the change was reverted.

`status()` does not read the XUI diagnostic. For a metadata-only runtime with
zero processes:

```ts
if (rt.processes.length === 0) {
  if (rt.method !== "XUI") return TunnelStatus.STOPPED;
  if (!rt.xuiVerification) return TunnelStatus.ERROR;
  return classifyXuiSync(rt.xuiVerification);      // <- the real decision point
}
```

So `classifyXuiSync(rt.xuiVerification)` — the function TASK-136 fixed — is the
single source of truth for what every consumer sees. The diagnostic is advisory:
it feeds `actualError` in `/api/tunnels` and the diagnostics panel, but not the
status. Mutating `planXui` therefore cannot change what the gate asserts, and the
gate passing under both the original and the "fixed" engine is **positive evidence
that it measures the right thing**.

**Mutation on the actual decision point** — replacing
`classifyXuiSync(rt.xuiVerification)` with a hardcoded `TunnelStatus.RUNNING`:
**55 passed, 3 failed**, catching:

- `engine: a login that verified no inbound reports degraded`
- `engine: a verified but disabled inbound reports degraded`
- `an unverified XUI tunnel is not reported running` (the pre-existing assertion)

The `planXui` change is therefore reverted, with a comment recording that the
branch looks wrong but is not the decision point. Leaving "defensive" code in
place on a false premise is how the next reader wastes a day on it.

**Correction.** I originally concluded from that non-failing mutation that the
`planXui` branch was harmless, and reverted the change. **That was wrong**, and
the next step found why. The branch does not drive `status()` — true — but it does
drive the REASON:

```
/api/tunnels:
  const actualError = state is error|unknown|degraded
    ? engine.getDiagnostic(id)?.summary ?? null : null;
```

and the diagnostics panel renders the same summary. So publishing `running` left a
correctly-`degraded` tunnel with an **empty** reason. Measured, with
`xuiSync` returning a login that verified nothing:

```
status()            : degraded
diagnostic .summary : ""
operator sees errorMessage: <empty>
```

A warning badge with nothing telling the operator what to do. The change is now
kept, and asserted at the layer it actually drives — the summary — not at
`status()`.

**The lesson, properly stated:** a mutation that does not fail a gate means the
gate does not measure that code. It does **not** follow that the code is dead.
I read "not measured" as "not load-bearing", and those are different claims.

## UI coverage

`StatusBadge` maps `degraded` to a warning variant, and both catalogues carry it
(`Degraded` / `مشکل‌دار`), so the corrected state renders rather than falling back
to the raw token. Confirmed present in the running release's client chunks.

## Gates, final shape (`scripts/test-xui.ts`)

Three scenarios, each asserting BOTH the status and the reason, plus the original
TASK-136 assertions:

| scenario | `status()` | reason surfaced |
| --- | --- | --- |
| login verified no inbound | `degraded` | non-empty, names the missing inbound id |
| verified, **enabled** inbound | `running` | **no** error reason |
| verified, **disabled** inbound | `degraded` | non-empty, says it is not enabled |

The middle row is why the table exists: without it, "never report running" could be
satisfied by downgrading a healthy tunnel.

**Mutations, both run:**

| mutated code | result |
| --- | --- |
| `status()`'s `classifyXuiSync(rt.xuiVerification)` → hardcoded `RUNNING` | **3 failed** |
| `planXui`'s degraded-reason branch deleted | **2 failed** |

Each mutation fails the assertions written for that layer, and leaves the other
layer's assertions green — which is what two separate layers should look like.

### Mistakes made while building these gates

1. The reason assertions were inserted **outside** the scenario loop
   (`ReferenceError: expected is not defined`). Moving them with line-index
   arithmetic then deleted the loop's closing brace. Both caught by running the
   suite; the fix was to rewrite the block by locating its boundaries from the
   code, not from remembered offsets.
2. All three scenarios reused the tunnel id `xui-ok` on fresh engine instances. The
   diagnostic store is module-level, so summaries could leak between scenarios.
   Each scenario now uses its own id.
3. A restore-from-backup script dropped the `} else if (...)` line, which silently
   sent the *enabled* case into the degraded branch — caught by the
   "a running XUI tunnel carries no error reason" assertion, i.e. by the positive
   control doing exactly its job.

## Results

| check | result |
| --- | --- |
| `scripts/test-xui.ts` | **61 passed, 0 failed** (was 51) |
| mutation — `status()` decision point | 3 failed |
| mutation — `planXui` reason branch | 2 failed |
| `scripts/test-smoke-tunnel-diagnostics.ts` | 69/69 |
| typecheck / lint | 0 errors |
