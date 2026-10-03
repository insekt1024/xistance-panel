# TASK-34 evidence — XUI method coverage and the controlled exception

**Status:** passed

## The finding: XUI reported `running` without ever contacting anything

`planXui` had a comment claiming it persisted a pointer "so status and the
/api/xui endpoints can report the last-verified inbound". It did no such thing.
It wrote a JSON file, returned zero processes, and `computeStatus` reported
`RUNNING` for any XUI tunnel with no processes.

So a tunnel was "running" when:

- the panel URL was a typo,
- the password was wrong,
- the panel had been uninstalled,
- the inbound id did not exist.

Nothing was verified, and the UI said everything was fine. The comment described
an intent the code never implemented — the most dangerous kind of gap, because
it reads as though someone is handling it.

Fixed with `packages/tunnel-core/src/xui-sync.ts`: real login across the three
known paths, real inbound fetch, real classification, bounded abortable
retries. `running` now means a specific thing: a panel answered, the
credentials worked, and the inbound is up.

| Outcome | Status |
|---|---|
| Inbound fetched and up | `running` |
| Inbound fetched but stopped (`enable: false`) | `degraded` |
| Rate limited (panel alive, throttling us) | `degraded` |
| Auth rejected, panel unreachable, malformed response, missing inbound | `error` |
| Never verified | `error` — not `running` |

The last row is the one that matters. With no verification there is nothing
standing behind a `running` claim, so the engine refuses to make one.

## The private-network exception: verified, and pinned

The exception is intentional — 3X-UI panels usually live on the operator's own
VPS, often on a tailnet address — and it was already documented at the one
site that uses it. It stays narrow because:

1. `panelUrl` is restricted to `http`/`https`. `file:`, `gopher:`, `data:` and
   `javascript:` were all accepted by a bare `z.string().url()`, and any of
   them turns a panel URL into a local-file read or an injected scheme.
2. Credentials in the URL are refused, and `normalizePanelUrl` strips them
   defensively for callers that bypass the schema — a secret must not reach a
   request line, a log line, or the UI.
3. Tests assert the exception has **not** leaked: `/api/tools` must keep all
   three `isBlockedTarget` guards, and the XUI route must keep its session
   requirement, its rate limit, and its rationale comment. If a future edit
   applies the exception to the tools endpoint, the panel becomes an open proxy
   into the operator's private network — and mutant F proves the test catches it.

The SSRF guard itself was sound. `169.254.169.254` (cloud metadata) is blocked,
DNS errors fail closed, and the `172.16/12` boundary is exact at all four
edges.

## Also fixed

- `xuiInboundPath(NaN)` produced `/panel/api/inbounds/get/NaN` — a request the
  panel cannot answer, with an error explaining nothing. Now refused.
- `classifyXuiSync` originally ignored `inbound.up` and reported a deliberately
  stopped inbound as `running`. The rule now lives in one function so it cannot
  drift per caller.
- `XUI_RETRY_POLICY` is exported rather than hard-coded, so "retries are
  bounded" is assertable instead of assumed.

## Tests: `scripts/test-xui.ts` — 49/49, runs in 0.85s

8 invalid panel URLs, credential-free payloads, path-constant safety, 11 private
and 4 public IP literals, the 172.16/12 edges, blocked names, fail-closed DNS,
exception-boundary assertions on both routes, 7 sync outcomes, retry policy
and cancellation, the engine path, and the union path.

### Mutation testing — 9 mutants, all killed

| Mutant | Change | Result |
|---|---|---|
| A | engine reports XUI running with no verification | 1 fail |
| B | `planXui` stops verifying | 1 fail |
| C | schema drops http(s)-only | 5 fail |
| D | schema drops the no-credentials rule | 1 fail |
| E | `normalizePanelUrl` stops stripping credentials | 3 fail |
| F | tools route loses its SSRF guard | 1 fail |
| G | XUI route loses its session check | 1 fail |
| H | retries raised to 1000 attempts | 2 fail |
| I | a stopped inbound is called running | 1 fail |

## Errors I made, and what they cost

**D and E survived the first run.** The credential assertion was written as
`if (!r.success) … else if (!normalised.includes(…))` — so a schema regression
satisfied the first branch and the normaliser was never exercised. Each layer's
property is now asserted separately, and the `else if` is gone.

**My 172.16 boundary assertion was wrong.** I wrote `a && b && c` where `a`
was a negation, so a correct implementation read as broken. Verified the real
behaviour mechanically (172.15 → public, 172.16 → private, 172.31 → private,
172.32 → public), then rewrote it as four independent cases.

**My engine test was doing live network I/O.** `planXui` calls the real
`syncXui`, so deploying an XUI tunnel in a test performed real DNS against
`panel.example.com` and nine real HTTP attempts. That was the source of a
multi-minute suite hang under mutant H, and I initially misread it as the retry
loop misbehaving. Fixed with an `xuiSync` engine option — the same test-seam
pattern `createProcessHandle` and `clock` already use. It is a real production
improvement, not a test workaround: without it, a bounds regression turns the
suite into a timeout instead of a failure.

**A stale mutant.** H was regenerated after the abort fix; the pre-fix version
tested code that no longer existed.

## Gate

```
test-xui                  49/49      test-port-allocation   27/27
test-xray                 45/45      test-bounded-caches     29/29
test-reverse              36/36      test-diagnostics        22/22
test-direct               49/49      test-disposal-cleanup   15/15
test-port-forward         29/29      test-retry-bounds       23/23
test-forward-reconcile    26/26      test-tunnel-lifecycle   21/21
test-backhaul             39/39      optimization harness    77/77
test-frp                  28/28      line endings            54/54
test-gost                 37/37      version:check          7/7 match 1.1.2
test-ssh                  50/50
typecheck clean     lint 0 errors     builds clean
```

## Not claimed

- **No live 3X-UI panel was involved.** Login paths, inbound fetch, and
  classification are tested against injected responses. Which of the three
  login paths a given 3X-UI build actually serves, and whether a real inbound
  reports `enable` as this code expects, remain unproven against a real panel.
- `syncXui` is called during `deploy`. A panel that is slow to answer now adds
  its retry time (≤3 attempts, 5s cap) to a deploy. Bounded and documented, but
  a behaviour change worth knowing about.
- The DNS-rebinding TOCTOU window the SSRF module already documents is
  unchanged and still bounded by rate limiting rather than eliminated.
