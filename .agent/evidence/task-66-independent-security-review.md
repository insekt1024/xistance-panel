# TASK-66 — independent security review: findings, fixes, and refutations

> **Updated 2026-09-30.** A *second*, fuller report arrived after this file was
> written and carried a **CRITICAL** finding: SSH destination-token injection,
> i.e. RCE on the panel host. It was reproduced by execution and fixed in three
> layers. This file's "Zero critical" verdict below was true when written and
> is now wrong.
>
> Full record of the critical finding, including the reproduction and the
> mutants: [task-66-ssh-destination-injection.md](task-66-ssh-destination-injection.md).

## Verdict as of the first pass: one real high-severity finding, fixed and
## proven. One report claim refuted against source. Zero critical.

*(Superseded — see the note above. The critical finding arrived in the fuller
report; this section is the first pass only, kept for the record.)*

An independent read-only review was delegated and its findings **reproduced by
me before being acted on**. One was real and worse than reported. One was wrong.
Both are recorded.

---

## FINDING 1 (HIGH) — `destHost` in the port-forward API was an SSRF relay

**Reported as:** MEDIUM, `port-forwards/route.ts:23` — `destHost: z.string().min(1)`
accepts any string and it becomes a live `net.connect({ host })` or a
`gost -L` argv element with no `isBlockedTarget` check.

**Confirmed, and raised to HIGH**, because of what I found while verifying it:

| step | evidence |
|---|---|
| schema accepts anything | `apps/web/app/api/port-forwards/route.ts:23` — `destHost: z.string().min(1)` (no max, no format) |
| it becomes a real dial | `packages/tunnel-core/src/forwarder.ts:63` — `net.connect({ host: rule.destHost, ... })` |
| on the **node**, not the panel | `engine.ts:1329-1342` writes the rules file and launches `forwarder-runner` **on the node** over the SSH context |
| or a remote argv element | `engine.ts:1355` — `gost -L ${protocol}://:${sourcePort}/${rule.destHost}:${rule.destPort}` |
| no target check anywhere on that path | `isBlockedTarget` appears in exactly one route, `app/api/tools/route.ts:73` — never in the port-forward path |
| **any authenticated user** | `POST` requires `requireSession` but **not** ADMIN; a `USER` role creates the rule (`route.ts:173-186`) |
| nodes are **global** | the `Node` model has **no `userId`** — any user may pin **any** node via `nodeId`, which is validated for existence only (`route.ts:116-122`) |

**Impact.** An authenticated low-privilege user creates a forward whose
`destHost` is `169.254.169.254` (cloud instance metadata), `127.0.0.1`, or a
peer on the node's private network. The connection is made **from the node**,
and the bytes are returned through a listener the user chose the port for. That
is a working read primitive against the node's metadata service and internal
network, from a role that is not supposed to reach them.

This is the same class the **tools API already blocks** with
`isBlockedTarget` (`tools/route.ts:73`, `:92`, `:113`). The forward API simply
never got the guard — a gap between two features solving the same problem, not
a deliberate design decision.

### Fix

New `apps/web/src/lib/forward-host.ts` exposing `rejectForwardHost(host)`:
`looksLikeFlag` first (a host beginning with `-` is argv injection into the
`gost` command line, not a hostname), then `isBlockedTarget` (which resolves a
hostname before judging it, and covers loopback, RFC1918, link-local incl.
`169.254.169.254`, CGNAT, the RFC 5737 documentation ranges, multicast, and the
`.internal`/`.local` suffixes).

Applied on **both** write paths:

- `POST /api/port-forwards` — before `prisma.portForward.create`.
- `PUT /api/port-forwards/[id]` — when `destHost` is present in the body.

The edit path matters and is easy to miss: a create-only guard is bypassed by
creating a harmless rule and then editing `destHost` into an SSRF relay, which
is the cheaper attack because it needs no second privilege escalation.

### Test: `scripts/test-ssrf-guard.ts`, 101 → 116 assertions

Nine blocked targets (`127.0.0.1`, `169.254.169.254`, `10.0.0.5`, `192.168.1.1`,
`[::1]`, `[::ffff:127.0.0.1]`, `metadata.google.internal`, `foo.internal`,
`-f127.0.0.1`) plus **two allowed** routable targets — a guard that blocks
everything is not a fix, it is an outage, so the boundary is asserted too. Then
three structural assertions: POST calls the guard, PUT calls it on change, and
the guard's index is **before** `prisma.portForward.create` in the file (a guard
placed after the insert would be theatre).

**Non-vacuity:**

| mutant | result |
|---|---|
| remove the PUT guard | 115 passed, **1 failed** — the PUT assertion |
| neuter `isBlockedTarget` inside the guard (`if (false)`) | 107 passed, **8 failed** — 7 targets + the allowed-boundary pair |

Both reverted and `diff -q` byte-identical.

### A pitfall worth recording

`forward-host.ts` initially imported `@/lib/ssrf`. That is correct inside
`apps/web` (Next resolves it) but **wrong for the test runner**: `scripts/` sits
outside `apps/web`, so the alias does not resolve under `tsx` and the suite died
with `Cannot find module '@/lib/ssrf'`. A relative import is required for a
module that both a Next route and a `scripts/` test import. The failure was
loud, not silent — worth stating because the alternative, a mocked guard, would
have tested nothing.

## FINDING 2 (reported HIGH) — link-local not blocked: **REFUTED**

The report claimed `169.254.0.0/16` was reachable while a "cloud metadata
feature" still allowed it, and recommended "at minimum, block `169.254.0.0/16`
unconditionally."

**Refuted against source.** `apps/web/src/lib/ssrf.ts:126`:

```ts
if (a === 169 && b === 254) return true; // link-local: cloud metadata lives here
```

It is blocked, unconditionally, with the reason in the comment. The IPv6
equivalent is blocked too (`ssrf.ts:145`, `fe80::/10`). The guard is in fact
thorough — 15 distinct IPv4 rules (`0/8`, `127/8`, three RFC1918 ranges,
link-local, CGNAT, TEST-NET-1/2/3, benchmarking, `>=224`) and 12 IPv6 rules
including IPv4-mapped unwrapping, `2001::/23`, `2001:db8::/32`, and ORCHID.

No change made. **This is the second time in this task that a delegated
security finding did not survive reproduction** — the first, a "TAUTOLOGICAL"
installer assertion, turned out to be a real but differently-shaped defect (the
suite's *named* assertion was vacuous, but the suite did go red, via a
`bash -n` syntax check). Recording the refutation is the point: an unverified
review finding that gets "fixed" produces a change with no defect behind it.

## Areas the review checked and found clean

- **Auth/authz on API routes:** `requireSession` precedes every side effect and
  every data return; `USER` is scoped to `own userId` on list, update, and
  delete; write routes carry per-user rate limits.
- **Script injection:** no `shell: true`, no `exec`/`execSync`, no
  `$queryRawUnsafe`/`$executeRawUnsafe` anywhere in `apps/` or `packages/`. The
  only raw SQL is a tagged-template `prisma.$queryRaw\`SELECT 1\`` in
  `health/route.ts:16`. All process launches use `execFile`/`spawn` with an argv
  **array**, so a value containing shell metacharacters is not interpreted.
- **Secret handling:** node credentials are AES-256-GCM encrypted at rest
  (`sshKeyEncrypted`, `sshPasswordEnc`, `apiTokenEncrypted` in the schema); the
  node-test route sanitises `ssh` stderr before it can reach a client or a log
  (its own comment: "ssh stderr is not a status line: it can contain the
  resolved target host"); the in-app export masks tunnel credentials.
- **CSRF/origin:** `originAllowed` rejects absent-but-empty, malformed, non-http(s)
  and sandboxed-`null` origins, and compares scheme only when honestly known;
  `XT_ALLOWED_ORIGINS` is length- and count-capped.
- **CI/release:** actions SHA-pinned, permissions scoped, the audit step is now
  blocking (`npm audit --audit-level=high`).

## Dependency status

`npm audit --omit=dev` → **0 vulnerabilities**. Full `npm audit` → **0
vulnerabilities**, after pinning `deepmerge-ts 8.0.2`, `nanoid 3.3.19`, and
`js-yaml 4.3.2` via `overrides`. Both audits re-run after a *successful*
`npm install` — the earlier empty audit output that followed a failed
`EOVERRIDE` install was discarded, not counted.

## What remains unverified

This is a source review. It is not a penetration test, and it does not cover
the live deployment: the systemd unit, the reverse-proxy configuration, the
permissions on `/opt/xistance` and `/var/lib/xistance`, and the behaviour under
real concurrent load. Those need the Ubuntu target host, which is not available.
The `USER`-role node-pinning observation above — nodes carry no `userId`, so any
user may target any node — is a **design** question I have not changed. It is
consistent with the current product (a panel whose nodes are shared by design),
but it is the reason Finding 1 was HIGH rather than MEDIUM, and it deserves an
explicit product decision rather than an implicit one.
