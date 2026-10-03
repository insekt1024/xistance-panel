# TASK-44 evidence — secret redaction across output surfaces

**Status:** passed
**Suite:** `scripts/test-secret-redaction.ts` — 52 assertions, no network, no `.env.local`.

## What the PRD requires

> Never expose encrypted secrets, bearer tokens, passwords, connection
> strings, or private keys in API responses, logs, audit records, metrics,
> **backups presented in UI**, screenshots, or release notes.

The backup clause is the one that had been missed.

## The finding: `GET /api/settings/backup` exported every tunnel credential

A tunnel's `config` is a JSON blob stored in **plaintext**, because the engine
has to hand the token to a process at start time. Node credentials are the
opposite — ciphertext under `XTENC_KEY` — so the route's own comment was
half right:

> Secrets stay encrypted at rest (same XTENC_KEY required to restore), so this
> JSON is safe to move between panel installs that share the encryption key

True for `sshKeyEncrypted`. **False for the tunnel config.** The export
returned `config` verbatim, handing out every BACKHAUL/FRP token, FRP
`secretKey`, SSH `key`/`password`, and XUI `password`/`apiToken` in the install —
to whoever receives the file, into any ticket it is pasted into, and into any
repo it is committed to.

### Fix

`redactTunnelConfig()` in `apps/web/src/lib/tunnels.ts`, applied to every
exported tunnel in the GET.

Field matching is by **name at any depth** rather than an exhaustive per-method
list, because the alternative rots: a new method with a new secret field would
be silently exported until someone remembered to update a switch.

### The trade-off, stated plainly

A redacted config is still restorable in shape — secret fields keep their keys
with a `***` value, so a restore knows a credential was set. But restoring onto
a fresh install will **not** carry the credential across; it has to be
re-entered for the tunnels that need it.

That is deliberate. A backup that silently carries live credentials is a
liability the moment it is emailed, attached to a ticket, or committed. A backup
that cannot is worth more. This is now documented in both READMEs.

## What was already correct, and now has a test

| Surface | Finding |
|---|---|
| `GET /api/nodes` | selects the encrypted columns, then `redactNode` — **correct**: the redactor needs to read them to compute `hasKey`/`hasPassword`/`hasApiToken`. It destructures the ciphertext out and returns booleans. |
| user routes | `passwordHash` is read to verify, never returned; `safeUserSelect` excludes it. |
| SSH password | attached as `SSHPASS` in the process **environment** in `engine.ts`/`runner.ts`, never in argv. |
| FRP/BACKHAUL tokens | written to a config file at `0o600`, not argv. |
| diagnostics | `sanitizeForDiagnostics` is the only sanctioned path into a diagnostic; the store holds already-sanitised values. |
| audit records | no route writes a password or key into an audit entry. |
| evidence files | no real secret material in any of the 30+ committed evidence files. |
| installer | no `set -x`, so a secret can never be echoed by shell tracing. |

## Test design notes

Five of the first seven failures were **my detectors being wrong**, not the
product:

- SSHPASS was asserted in `config/ssh.ts`; the argv is built there but the env
  is attached in `engine.ts`. Both had to be checked.
- The diagnostics endpoint was required to name a sanitiser; sanitisation
  happens at **write** time. Asserting the route named it would test the wrong
  layer.
- A PEM marker in prose (`tested against ... a -----BEGIN OPENSSH PRIVATE
  KEY----- block`) was flagged as a shipped key. It is a description of a test
  input. Now requires a real BEGIN/base64-body/END block over 120 chars.
- The `findMany` regex stopped at the first `}`, truncating inside the cursor
  spread, so `select:` was never seen.
- `auditLog(..., "user.password-change", ...)` was flagged as a password
  leak — it is an action **name**. Now only an argument that is a credential
  *value* counts.

The control that matters: a redactor that blanks everything would pass a test
that only checks secrets disappeared. `test-secret-redaction` asserts an XRAY
config (no credential) comes back **byte-identical**, and that FRP proxy *names
and ports* survive masking.

## Mutation testing: 4/4

| Mutant | Change | Result |
|---|---|---|
| M1 | redactor becomes identity (`if (false)`) | **killed** — 9 failures |
| M2 | no array walk (top level only) | **killed** — 1 failure |
| M3 | route returns `t.config` unredacted | **killed** — 1 failure |
| M4 | `password` dropped from the field set | **killed** — 5 failures |

### M2 survived the first pass, and that was the useful finding

The FRP check asserted the proxy *names* survived — which they do even when the
redactor stops walking arrays, because the original objects come back intact
with their secrets. The assertion now checks the mask reached **inside** each
proxy: `proxies.every(pr => pr.secretKey === "***")`.

It then **crashed** rather than failed, because the redactor returns a plain
object where an array is expected. A crash is a weaker kill than a failed
assertion — it takes the rest of the suite with it — so the shape is now
asserted before traversal.

### M3's first "survivor" was a broken harness, not a real one

The mutation script emitted a Python `SyntaxWarning` about `\s`, so the
replacement never applied and the mutant was never installed. The run was
meaningless. Redone with the substitution performed outside the shell: the
mutant was confirmed present (`grep -c` → 0) before running, and died.

A mutation that reports "survived" because it was never applied is worse than no
mutation testing at all — it manufactures a false gap in the evidence.

## Verification

```
test-secret-redaction   52 passed, 0 failed
test-auth-security      30 passed, 0 failed
test-rate-limit         30 passed, 0 failed
test-optimizations      77 passed, 0 failed
test-line-endings       54 passed, 0 failed
typecheck               clean
lint                    0 errors, 16 warnings
```

## Not covered

- No real credential ever appears in a test. All 9 sentinels are marked
  `SENTINEL`; the suite asserts it never opens `.env.local`, which the task
  notes forbid.
- The XUI panel is a third-party service; this task covers what *we* store and
  return, not what 3X-UI itself logs.
