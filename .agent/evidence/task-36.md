# TASK-36 — Tunnel diagnostic and recovery user flow

Status: **PASSED.** Baseline `69 passed, 0 failed`. The mutation sweep recorded
below returned **8/8 killed, 0 invalid**.

## Acceptance criteria, each with the assertion that carries it

| AC | How it is proven |
| --- | --- |
| Open diagnostic details without exposing secrets | `the panel is labelled for assistive tech`, `the panel exposes no credential material` (scans the rendered text for `BEGIN OPENSSH PRIVATE KEY`, `sshKeyEncrypted`, `sshPasswordEnc`, `password=`, `token=`), `the diagnostic summary carries no credential material` |
| Distinguish stopped / degraded / running / unknown / probe-failure with text labels | `the state is labelled with text, not colour alone` (asserts non-empty badge text, not a CSS class), plus `the panel shows state / retryCount / errorCategory / nextAction` |
| Retry/restart idempotent, bounded, disabled while pending, reports success/failure | `a double-click fires at most one action` (counts POSTs to `/actions` while the control is disabled), `the control is disabled while the request is in flight`, `the action reports success or failure`, `the announced text matches the outcome attribute`, `the controls are re-enabled after a refusal, so a retry is possible` |
| After recovery, state and logs refresh without a full page reload | `the panel refreshed in place, without a full page reload` (the outcome line survives the refresh, which a full navigation would clear), `the panel shows the server state, not a locally invented one` |
| English and Persian labels/actions | `fa: the diagnostics entry is labelled in Persian`, `fa: no untranslated English in the panel`, `fa: the panel is laid out RTL`, `fa: the recovery controls render` |

### The technical note: no optimistic state transitions

`technicalNotes: "Do not add optimistic state transitions; the UI must wait for the server/process result."`

This is asserted **during** the pending window, not after it:

- `the displayed state does not change before the server answers` — samples
  `data-state` synchronously after the click, before the response lands.
- `no outcome is announced before the server answers` — samples the outcome line
  in the same window.
- `the panel shows the server state, not a locally invented one` — after settling,
  the panel must equal `engine.status()` for that tunnel, and the value read is
  printed in the pass detail so a vacuous read is visible.

An earlier version of this suite asserted "the panel never shows `running` after a
failed restart". **That assertion was wrong, not the server**: a `PORT_FORWARD`
start genuinely does succeed at the process level even while the forwarder is
degraded. It was replaced with a comparison against what the server actually
reported.

## Two production defects found and fixed

### 1. `deploy()` erased a recorded XUI failure

`packages/tunnel-core/src/engine.ts` — for a metadata-only XUI tunnel, `planXui`
records a classified diagnostic when the panel sync fails, during `buildPlan`.
`deploy` then published an unconditional `publishDiagnostic(id, { status:
"running" })` immediately afterwards, overwriting that record. The panel showed
a healthy tunnel whose panel sync had in fact failed, and the classified reason
was destroyed. The success transition is now guarded by
`spec.config.method !== "XUI"`.

### 2. The create route hardcoded the actual-state column

`apps/web/app/api/tunnels/route.ts` wrote `state: "running"` after a deploy
regardless of what the engine reported. The route now reads `engine.status(id)`
and persists that, with `unknown` when the probe itself fails rather than
inventing a clean success. Observed effect on an XUI tunnel whose panel is
unreachable: `state=error status=stopped` instead of a false green.

Both are covered by mutants **M7** and **M8**.

## The stale-package false failure

After the sweep passed, the suite began reporting a failure that was not a bug
in the code:

```
FAIL a failed XUI sync records a summary at create time
     state=running summary=""
```

The engine's diagnostic history showed what was actually happening — two entries
2ms apart:

```
{"state":"error", "errorCategory":"unknown", "summary":"unreachable: fetch failed", "nextAction":"retry"}
{"state":"running", "errorCategory":null,      "summary":"",                 "nextAction":"none"}
```

The first entry is correct: the panel URL `192.0.2.1:2053` is unreachable, and
the engine recorded exactly that. The second is a blank `running` that appeared
immediately after.

`packages/tunnel-core/src/engine.ts` had the right guard the whole time:

```ts
if (spec.config.method !== "XUI") {
  this.publishDiagnostic(spec.id, { status: "running" });
}
```

The cause: the app resolves `@xistance/tunnel-core` through its `exports` map to
`packages/tunnel-core/dist/`, and **`next build` does not recompile that
package**. `dist/engine.js` was 105 seconds older than its source. The suite was
running code that was not in the repository, and the failure pointed squarely at
correct code — a trap for whoever investigated it next.

After `tsc -p packages/tunnel-core/tsconfig.build.json` plus a web rebuild: the
history holds one entry, `69 passed, 0 failed`, reproduced across runs.

**Guard added.** `assertPackageBuildIsFresh()` now runs at the top of the suite
and throws with the offending filenames when any `packages/tunnel-core/src/*.ts`
is newer than `dist/engine.js`. Verified in both directions:

- fresh build → `69 passed, 0 failed`
- `touch packages/tunnel-core/src/engine.ts` → `Error: packages/tunnel-core/dist
  is STALE -- 1 source file(s) are newer than the compiled output` naming
  `src/engine.ts`

A stale build now stops the run with an explanation instead of producing a
verdict about the wrong code.

## Suite

`scripts/test-smoke-tunnel-diagnostics.ts` — real production build, real
Chromium, disposable SQLite database, real authenticated admin session, real
tunnels created through the real API from the real Zod schemas. No doubles for
the behaviour under test.

**61 passed, 0 failed.**

## Mutation sweep

`scripts/mutate-tunnel-diagnostics.ts` — each mutant is applied to production
source, the app is **rebuilt**, the full suite is run, and the source is
restored atomically (temp file + `renameSync`, so an interrupt cannot truncate).
A pristine SHA-256 fingerprint of every target is taken before the sweep and
re-checked after, because a hard-killed run can leave a valid-looking mutation
in place and a structural check alone cannot detect that.

Preconditions the harness enforces, each learned from a false survivor:

- **Rebuild the package a package-source mutant touches.** Next resolves
  `@xistance/*` through its `exports` map to a compiled `dist/` that `next build`
  never recompiles, so M7 and M8 ran against unmutated compiled output and
  "survived". The harness now runs `tsc -p packages/tunnel-core/tsconfig.build.json`
  before each mutant of a package source.
- **A missing next-intl key does not throw in a server render** — it renders the
  unresolved key path. The original M4 assertion was "the output contains the raw
  token", which passes under production *and* under the mutant, because the
  fallback string `status.probe_failed` contains the token. The assertion now
  checks the rendered LABEL plus the `[data-unmapped-status]` marker, verified in
  both directions: production `69/0` with `keyPath=false unknownLabel=true`, the
  mutant `68/1` with `keyPath=true unknownLabel=false`.
- **A malformed or absent result summary is INVALID, not a verdict.** A browser
  that never finishes signing in once retries; anything still malformed is
  discarded rather than reported.

Mutants and the assertion that killed each:

| Mutant | Killed by |
| --- | --- |
| M1 optimistic state painted before the server answers | `no optimistic state is painted on a degraded tunnel` |
| M2 pending does not disable the control | `the control is disabled while the request is in flight` |
| M3 no outcome reported | `a refused action is announced as a failure` |
| M4 badge throws on an unknown state | `an out-of-catalog state renders as readable text` |
| M5 status tracks the click, not the result | `the action state comes from the supervisor, not from the click` |
| M6 raw summary rendered as markup | `markup in a summary stays inert text, and its handler never runs` |
| M7 create route hardcodes `state: "running"` | `a tunnel whose panel sync cannot succeed is created` |
| M8 deploy overwrites the XUI sync failure | `a failed XUI sync records a summary at create time` |

**Result: `8/8 mutants killed, 0 invalid`** (run log `m13`).

After the sweep all five targets were verified restored: zero NUL bytes, no
mutation marker surviving in production source, and no `*.mutate-tmp` residue.

## Corrections made to the suite itself

The first two sweeps reported **0/6 killed** against a 48/48 baseline. That was
the suite, not the code. Four independent defects made assertions
unobservable, and each is now a rule in
`tunnel-method-verification-contract`:

1. Every assertion ran after the action settled, so mid-flight defects were
   invisible. Now sampled during the pending window.
2. `data-state` was read off an element that does not carry it, so the
   comparison was `""` to `""` — vacuously true. Now read from the correct
   element, and the value is printed in the pass detail.
3. The non-empty-summary block was nested inside the *healthy* fixture's `else`
   branch, so it could only run when its own trigger was absent.
4. `{ latest, history }` was read as a flat object, so the summary was always
   `undefined` and the block silently skipped.
5. The rate-limit exhaustion used a fixed attempt count against a fixed 60s
   window that earlier blocks had partly consumed.

A sixth item: **M2 was an invalid mutant**. Removing `disabled` is a no-op
because `if (pending) return` still blocks the second call; the mutant had to
remove both layers to be behavioural. **M4 was invalid** because removing the
only use of `KNOWN_STATUSES` left the declaration unused and `noUnusedLocals`
rejected it as non-compiling.

## Platform limits recorded, not passed over

- **Unroutable remote node fixture.** `ctxFor` classifies a non-loopback node as
  remote, and the remote runner writes to the POSIX `/etc/xistance`, which is
  `\etc\xistance` on Windows. The deploy cannot succeed on this host. Recorded
  as a platform limit in the run output; the equivalent failure case is covered
  by the loopback fixture's refused-action and failed-sync assertions.
- **The local-fallback path was deliberately not added to production.** An
  earlier attempt made the engine's remote config directory platform-relative.
  That was reverted: it is the path deployed config lives at on the real VPS,
  and making it platform-dependent would silently move production config off
  the deployed path to fix a Windows test.

## Security

No real secret values in this file, in the task records, or in the test. The
XUI fixture uses `PLACEHOLDER_XUI_USER` / `PLACEHOLDER_XUI_PASS` against
`http://192.0.2.1:2053` (RFC 5737 TEST-NET-1, guaranteed unroutable). The
SSH-key-auth node fixtures use an obviously fake `[REDACTED PRIVATE KEY]` token
and never reach a real host.
