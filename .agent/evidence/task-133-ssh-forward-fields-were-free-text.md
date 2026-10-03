# TASK-133 — SSH: five fields spliced into the forward argument were free text

## The defect

`SshConfigSchema` held `host` and `username` to strict regexes, with the reason
written down beside them:

> A leading "-" would be parsed by ssh as an OPTION, not a destination, and a
> metacharacter would survive into the destination token. Both are refused here;
> buildSshCommand re-checks so a caller that bypasses this schema is still safe.

The **same reasoning applies to the five fields that get spliced into a single
`-L`/`-R`/`-D` token** — they were bare `z.string().default(...)`:

```ts
localBindAddr:    z.string().default("127.0.0.1"),
remoteHost:       z.string().default("127.0.0.1"),
remoteBindAddr:   z.string().default("0.0.0.0"),
dynamicBindAddr:  z.string().default("127.0.0.1"),
```

Measured through `buildSshCommand` before the fix:

| `remoteHost` | schema | built `-L` argument |
| --- | --- | --- |
| `198.51.100.7` | ACCEPTED | `127.0.0.1:8080:198.51.100.7:80` (correct) |
| `198.51.100.7:22@evil.example` | **ACCEPTED** | `127.0.0.1:8080:198.51.100.7:22@evil.example:80` |
| `-oProxyCommand=id` | **ACCEPTED** | `127.0.0.1:8080:-oProxyCommand=id:80` |
| `""` (empty) | **ACCEPTED** | `127.0.0.1:8080::80` |

REVERSE already rejected these — it uses `hostLikeAddress` — so this was an
inconsistency between two methods that build the same kind of argument.

## What this is NOT

It is **not command injection**, and the distinction matters. argv is passed to
ssh as an array, so `-oProxyCommand=id` arrives inside the `-L` argument as opaque
data and is never parsed as an option. Verified: the built argv length is
unchanged and no extra option appears after the token.

It is the **same failure shape as the GOST half-address (TASK-131)**: each value
produces a corrupt forward that binds a port and carries nothing — the tunnel
reports itself running and transports no traffic. That is the class the evidence
ledger exists to catch, not a security hole.

## The fix, in two layers

**1. Schema** — all five fields now use `hostLikeAddress`, the same bare-address
rule DIRECT, REVERSE and (since TASK-131) GOST use.

**2. Builder** — new `assertSafeForwardField(value, field)` in
`packages/tunnel-core/src/config/ssh.ts`, called for all four address fields
before any of them is spliced. It mirrors DIRECT's `assertSafeDirectAddress`,
including reporting a pasted scheme as a scheme rather than as a delimiter
problem, and it holds when a caller bypasses the schema.

REVERSE is covered too, because `reverseToSshConfig()` produces an `SshConfig`
that goes through the same builder.

## Gates added (`scripts/test-ssh.ts`)

Eight hostile values × two layers (schema rejects it, builder refuses it even when
the schema is bypassed), plus a positive control that a legitimate config still
builds `127.0.0.1:8080:198.51.100.7:80` unchanged.

**Mutation:** deleting the four `assertSafeForwardField(...)` calls from
`buildSshCommand` → **59 passed, 8 failed** — exactly the eight builder-layer
assertions, with the schema-layer ones correctly still passing (they do not depend
on the builder). Restored afterwards; no residue.

## Results

| check | result |
| --- | --- |
| `scripts/test-ssh.ts` | **67 passed, 0 failed** |
| mutation (builder guard removed) | 8 failed — gate catches it |
| `scripts/test-gost.ts` | 37/37 |
| `scripts/test-xray.ts` | 53/53 |
| typecheck / lint | 0 errors |