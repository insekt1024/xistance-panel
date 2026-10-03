# SSH destination-token injection on the node path — CRITICAL, fixed

## Verdict: confirmed by execution, fixed in three layers, all three proven
## non-vacuous. This was a real RCE on the panel host.

An independent security review reported this as CRITICAL. I reproduced both
premises myself before changing anything, and the second one — that `ssh`
actually executes a `ProxyCommand` smuggled through a leading-dash argv token —
is the difference between "a bad regex" and "arbitrary command execution".

---

## The vulnerability, step by step

### Premise 1 — the schema accepts the payload

`packages/types/src/index.ts`, before the fix:

```ts
export const NodeConfigSchema = z.object({
  name: z.string().min(1).max(80),
  type: NodeTypeSchema,
  host: z.string().min(1),                                  // no validation
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1).default("root"),              // no validation
  ...
```

Executed against the real schema:

```
NodeConfigSchema.safeParse({ ..., username: "-oProxyCommand=touch /tmp/pwn_marker" })
  accepted: true
  stored username: "-oProxyCommand=touch /tmp/pwn_marker"
```

### Premise 2 — `ssh` executes it

Both consumers splice the value into the argv token `${username}@${host}`:

| site | line | who can reach it |
|---|---|---|
| `apps/web/app/api/nodes/[id]/test/route.ts` | 77 | ADMIN (`requireSession(request, "ADMIN")`) |
| `packages/tunnel-core/src/runner.ts` → `RemoteRunner.baseArgs` | 210 | **any tunnel deploy referencing that node** — no route involved |

`ssh` parses any argv token beginning with `-` as an **option** before it looks
for a destination. Run against the local OpenSSH 10.2p1:

```
$ ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 \
      "-oProxyCommand=touch $M" echo ok
Connection closed by UNKNOWN port 65535
$ [ -f "$M" ] && echo "RCE CONFIRMED"
  >>> RCE CONFIRMED on this host
```

A first attempt using the report's exact `...@127.0.0.1` form did **not**
reproduce. The difference was the trailing `echo ok` command: the option parse
and the connection attempt both have to happen. Reporting that first attempt
honestly matters — had I stopped there I would have wrongly refuted a real
finding, exactly as I refuted the `169.254` claim earlier.

### Why `execFile` with no shell did not save us

The route uses `execFile`, so there is no shell and no metacharacter
interpretation. That is irrelevant: **`ssh` is the parser.** A value with no
shell metacharacters at all (`-oProxyCommand=touch /tmp/pwn`) still executes,
because `ssh` interprets the leading dash itself. "No `shell: true`" is a real
property of this codebase, but it protects against a different threat.

## Why this survived a previous fix

The SSH **tunnel** path was already hardened, and the codebase documents the
exact attack in `config/ssh.ts`:

> The destination reaches ssh as the argv token `${username}@${host}`. ssh
> parses ANY leading-dash argv token as an OPTION before it ever looks for a
> destination, so an unvalidated username of `-oProxyCommand=touch /tmp/pwned`
> produced the final token `-oProxyCommand=touch /tmp/pwned@10.0.0.5` —
> arbitrary command execution on the panel host.

`assertSafeSshDestination`, `SSH_USERNAME`, `SSH_HOST`, and the
`SshConfigSchema` / `ReverseConfigSchema` regexes all exist for this. The
**node** path was the one caller that bypassed them. The bug class is not a
missing regex — it is a fix that lives in a validator and therefore protects
only the callers that happen to use that validator.

## The fix — three layers

**1. Schema** (`NodeConfigSchema`) — `host` and `username` now carry the same
regexes as `SshConfigSchema`. Nothing hostile can be stored or returned by the
API from here on.

**2. Point of use** (`RemoteRunner.baseArgs`) — calls
`assertSafeSshDestination(this.conn.username, this.conn.host)` before building
the token. A node row stored *before* the schema fix is still in the database,
and any caller can construct an `SshConnection` without touching the schema.

**3. Point of use** (`nodes/[id]/test/route.ts`) — same call before
`args.push`, returning **400** rather than crashing, because the value is data,
not a programming error. This is also the shortest path to any pre-existing bad
row.

## Test: `scripts/test-ssh-destination-injection.ts` — 37 assertions

- **8 hostile payloads refused** by the schema: `-oProxyCommand=touch /tmp/pwn`,
  `-oV`, `root@evil`, `root -oProxyCommand=x`, `root;id`, a host starting with
  `-`, a host with a space, a host with a newline.
- A **counted** summary assertion, not a bare `ok()` — `anyAccepted === 0` over
  all eight, so the group cannot pass while individual cases silently flip.
- **3 real destinations still accepted** (`root@10.0.0.1`,
  `deploy@panel.example.com`, `ops.user@2001:db8::1`). A validator that rejects
  everything is an outage, not a fix.
- **Schema and runtime must agree** on 5 cases, cross-checked against
  `assertSafeSshDestination`. A divergence between the two layers is a real bug
  that no single-layer test would catch.
- **`SshConfigSchema` did not regress** while `NodeConfigSchema` changed.
- **Both argv sites** are asserted to call the guard, *and* asserted to call it
  **before** the token is pushed (index comparison) — a guard placed after the
  push is theatre.

### Non-vacuity: one mutant per layer

| layer reverted | result |
|---|---|
| `NodeConfigSchema` → `z.string().min(1)` | 24 passed, **13 failed** — 8 payload cases + the counted summary + both real-destination acceptances + the agreement checks |
| node test route guard removed | 35 passed, **2 failed** |
| `RemoteRunner.baseArgs` guard removed | 35 passed, **2 failed** |

All three reverted and `diff -q` byte-identical. Clean: **37 passed, 0 failed**.

Each mutant is written by a harness that asserts the exact text it is replacing
**before** writing, and scopes schema edits to the `NodeConfigSchema` block —
an unscoped replace hit `count == 2` because `SshConfigSchema` carries the
identical guard, and a mutation that does not apply reports the *clean*
suite's result. Three earlier mutation attempts silently no-op'd for exactly
this reason before the harness was made content-anchored.

## Two of my own bugs, caught by the tests I wrote

Worth recording because both produced a **green-looking** pass:

1. **A second IPv6 parser.** The X-UI policy helper expanded IPv6 with
   `split(":")`, which turns `::1` into two bytes that match nothing — so
   `[::1]` and `[fe80::1]` were reported as *allowed*. The suite caught it
   (2 failures). Fixed by exporting the existing, correct `ipv6Bytes` from
   `ssrf.ts` and reusing it. A subtly different second implementation of a
   security primitive is how a guard silently stops guarding.
2. **An unused import** (`isPrivateIp`) — caught by `typecheck`, not the suite.

## Also fixed from the same review

- **X-UI probe policy (MEDIUM).** `/api/xui/test` deliberately reaches
  private/tailnet addresses — a 3X-UI panel usually lives there. New
  `rejectPanelProbeHost` keeps that working while unconditionally refusing
  loopback (`127.0.0.0/8`, `::1`, IPv4-mapped loopback), link-local
  (`169.254.0.0/16` — cloud metadata, and `fe80::/10`), and unspecified. The
  route is USER-role, so it must not reach the panel's own admin port.
  *Residual, stated honestly:* a hostname is not resolved, so the
  DNS-rebinding window stays open on this route — the same bounded, documented
  residual the tools route carries. Closing it means pinning the resolved
  address and connecting to it, which is not a change to absorb untested on a
  target host.
- **Backup export (LOW).** The node select included `sshKeyEncrypted`,
  `sshPasswordEnc`, and `apiTokenEncrypted`. These are AES-256-GCM ciphertext
  and unreadable without `XTENC_KEY`, but a backup file that travels by email
  should not be one master-key recovery from every node credential. The three
  columns are dropped; the filesystem `tar` remains the complete backup and
  still keeps them.
- **Raw `ssh` stderr in the log (LOW).** The *browser* response was already
  correctly sanitised by `sshFailureMessage`; the log line was not. It now runs
  through `sanitizeForDiagnostics`, which already handles PEM blocks,
  `key=`/`password=` pairs, `-pVALUE`, and long blobs.

### Two test assertions I had to correct, not the code

`test-ssrf-guard.ts` and `test-xui.ts` each asserted that the X-UI exception
comment matched the literal string `intentionally no SSRF`. Replacing that
blanket exemption with the narrower policy made both fail **while the security
behaviour improved**. The tests were matching a comment's wording, not its
intent. Both now match on intent and additionally assert the narrower policy is
actually applied — so they are stronger than before, not merely looser.

## What this does not prove

This is a source-level fix verified by unit tests and by one direct execution of
the local `ssh` binary. It does not establish that no *other* argv construction
site has the same shape; the review covered the 32 API routes and the tunnel
builders, and I re-checked the two sites it named, but a mechanical proof would
be a separate pass. It also says nothing about the live deployment. The target
host gates (TASK-62…65) remain open.
