# TASK-22 evidence — lifecycle state and recovery diagnostics

**Status:** passed

## The actual risk

The engine already knew why a tunnel failed, but that knowledge was trapped in
an exception message — and the engine's plan holds the **full argv** for every
process, including decrypted credentials. So the shortest path from "tunnel
failed" to "diagnostics" is a string join that puts a password in an API
response, a log line, an SSE stream, and a browser. The task's technical note
forbids exactly this, so the module was written to make the unsafe path
impossible rather than merely discouraged.

## Diagnostic model (step 2)

`packages/tunnel-core/src/diagnostics.ts`. Additive by design: a new endpoint
`/api/tunnels/[id]/diagnostics` rather than new required fields on an existing
payload, so **no existing response shape changes** and 1.2.0 stays
non-breaking.

```ts
interface TunnelDiagnostic {
  state: string;                    // mirrors TunnelStatus
  lastTransitionAt: number;
  errorCategory: DiagnosticErrorCategory | null;
  summary: string;                  // redacted, bounded to 200 chars
  retryCount: number;
  nextAction: RecoveryAction;       // closed set
  exhausted: boolean;
}
```

Two closed sets — 8 error categories, 6 recovery actions — so the UI can
localize exhaustively and never render an unknown key. `unknown` is a
deliberate catch-all: a new message must never produce an unrenderable
category.

## Sanitization

`sanitizeForDiagnostics()` is the only sanctioned path from arbitrary text into
a diagnostic. Order matters: the credential patterns run before the generic
`--flag value` sweep, so `password=hunter2` is not first rewritten into
`password=***` with the value left visible. It keeps the program name, host and
port, so the message stays actionable.

Tested against inputs built to look like real secrets: `-p hunter2`,
`--password hunter2`, `password=hunter2`, `token: abc123DEF`, a full
`-----BEGIN OPENSSH PRIVATE KEY-----` block with its base64 body, `ssh -i
/etc/xistance/id_ed25519`, and a 32+ char opaque token.

## Classification ordering was a real bug

`Permission denied (publickey)` is an **authentication** failure, not a
filesystem permission problem. The generic permission check ran first and
classified it as `permission`, which would tell an operator to `chmod` their
way out of a bad key. Authentication is now matched before permission, and a
mutation test pins that ordering.

An earlier version also had a broken condition —
`m.includes("timed out") === false && m.includes("network is unreachable")` —
which made `timeout` unreachable. Caught by a test asserting every declared
category is produced by a real message.

## Engine integration (step 3)

The store lives on the engine, not in a module global, so it shares the engine's
lifetime and cannot leak across a restart. Retention is a **count per tunnel**
(20), not a global count, so one crash-looping tunnel cannot evict every other
tunnel's history. Wired into:

- the deploy failure path (records the classified error, never the raw message);
- deploy success (clears the prior error, so a healthy tunnel stops being
  offered a recovery action);
- an intentional stop (a clean terminal state, not a failure).

## Localization (step 4)

A `diagnostics` block in both `en.json` and `fa.json`. A test asserts the
catalogs cover every closed-set key in **both directions** and have identical
key sets, plus that no Persian label is left as the English string — a
copy/paste miss. Removing one Persian key fails it.

## Non-vacuity

| Mutation | Result |
| --- | --- |
| Remove the `key=value` credential redaction | **FAIL** `sanitising "password=hunter2"`, `sanitising "token: abc123DEF"` |
| Unbounded retention | **FAIL** `retention is bounded`, `repeat reads do not grow the store` |
| Check permission before authentication | **FAIL** `classify "Permission denied (publickey)."` |
| Delete `fa.diagnostics.category.timeout` | **FAIL** `fa.json has a label for category timeout` |
| Restored | 22/22 |

## Process errors

- `clampRetryPolicy`-style field-initialiser ordering bit again in a different
  place, and `tsx` does not typecheck — the new `getDiagnostic`/`listDiagnostics`
  methods were invisible to typecheck until `@xistance/tunnel-core` was rebuilt,
  because the app resolves the package through `dist/index.d.ts`.
- Two locale files were rewritten via `json` round-trip with `ensure_ascii=False`
  so Persian text is not escaped.
- The first PEM test used the literal words `PRIVATE KEY-----BEGIN`, which no
  real redaction pattern would match; it now uses a real OpenSSH header and
  asserts on the base64 body.

## Verified

- `test-diagnostics.ts` — 22/22
- `test-disposal-cleanup.ts` — 15/15
- `test-retry-bounds.ts` — 22/22
- `test-tunnel-lifecycle.ts` — 21/21
- `typecheck`, `lint`, `version:check`, line endings 54/54 — pass

**23/73 tasks passed.**
