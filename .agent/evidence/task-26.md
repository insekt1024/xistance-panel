# TASK-26 evidence — BACKHAUL lifecycle coverage

**Status:** passed

## Two security defects, both found by reading rather than by a failing test

### 1. TOML config injection via the token

`tomlQuote()` escaped backslash and double-quote, but let a **raw newline
through untouched**. A token containing one therefore terminated the line and
the following text was parsed as TOML:

```toml
token = "evil
injected = "yes"
```

The token is user-supplied, so this is a config-injection primitive reachable
from a field a normal operator types into. `frp.ts` had a **byte-identical**
`tomlQuote`, and `frps.toml`/`frpc.toml` embed an auth token — the same hole in
the same class of file. Fixed in both.

Control characters are now **refused outright** rather than escaped. No
legitimate token, host, or port contains one, and silently rewriting a value
would be worse than refusing it.

### 2. Token-bearing configs were world-readable

`Runner.writeFile(path, content, mode?)` accepted a mode. **No method ever
passed one.** Every generated config was written 0644 — including BACKHAUL's
`config.toml` (which embeds `token = "..."`) and FRP's `frps.toml`/`frpc.toml`
(`.auth.token`).

On a shared VPS, any local user could read the token and connect to the tunnel.
All four files now pass `mode: 0o600`.

`RemoteRunner` already honoured the mode (`chmod` in the same shell
invocation); `LocalRunner` already forwarded it to `fs.writeFile`. The gap was
purely that nothing asked.

## Non-vacuity

| Mutation | Result |
| --- | --- |
| Restore the injection in `backhaul.ts` | **FAIL** newline, carriage-return and NUL refusals (3) |
| Drop all four `mode: 0o600` | **FAIL** `every token-bearing config is written 0600` |
| Restore the injection in `frp.ts` | initially **passed** — see below |
| Restored | 39/39 |

The FRP mutant passing is what exposed a gap in my own work: I had fixed FRP
but not tested it, which would have meant shipping an unverified security
change. Section 12 of the test now covers FRP explicitly, and the same mutant
fails three assertions.

## Coverage

- **Schema** — invalid transports, out-of-range ports/heartbeat/channel/
  concurrency, empty token, out-of-range `portMap` entries.
- **Determinism** — two calls byte-identical for both roles; trailing newline.
- **Role separation** — server emits `[server]`/`bind_addr`/port map, client
  emits `[client]`/`remote_addr` only.
- **Transport mapping** — all six tcp/ws/quic × mux combinations, including the
  documented degradation of `quic` → `tcp` (v0.7.x has no quic transport, and
  emitting a token it would reject would fail at startup).
- **Redaction** — the token is required in the config, must not survive
  `sanitizeForDiagnostics`, and the **key** must survive so the redacted line
  stays diagnosable.
- **Injection** — quote escaping, backslash escaping, newline/CR/NUL refusal.
- **Structure** — every generated line is a well-formed TOML assignment; an
  empty port map omits the key instead of emitting `ports = []`.
- **Plan** — asserted against the real `planBackhaul`, not a stub, so a
  regression in the planner is caught rather than a test-local constant.

## Real-binary limitation (recorded, not worked around)

**No real BACKHAUL tunnel traffic was exercised.** There is no `backhaul`
binary on this host, and the task's note says real traffic requires the
approved VPS fixture. What is therefore *not* proven: that a real
`backhaul -c config.toml` accepts the generated TOML, and that a real tunnel
establishes and forwards traffic. The missing-binary path *is* covered — the
preflight emits an actionable error naming the binary, the absolute path, and
`scripts/install.sh` — but that is the error branch, not a live tunnel.

This remains open for the VPS acceptance pass.

## Process errors

- My first on-disk permission assertion read `0o666` on Windows and "failed".
  NTFS has no POSIX mode bits, so the on-disk check now runs only where it is
  meaningful, and the test says so explicitly rather than silently passing.
- A namespace spy on `fs.writeFile` returned `undefined` rather than the mode:
  `runner.ts` captured its `fs` binding at import time, so patching the
  namespace afterwards cannot intercept it. Removed, with a comment explaining
  why, because it produced a false signal.
- I asserted the redacted dump must contain `"token"` with a space; redaction
  collapses `token = "x"` to `token=***`, so the assertion failed against
  correct behaviour. The key *is* preserved; my matcher was wrong.
- The FRP fixture used invented field names (`serverPort`, `authToken`) instead
  of the real `bindPort`/`token`, and I only found it by reading
  `buildFrpPair`'s signature after the crash.

## Verified

- `test-backhaul.ts` — 39/39
- `test-forward-reconcile.ts` — 24/24
- `test-port-allocation.ts` — 27/27
- `test-bounded-caches.ts` — 29/29
- `test-diagnostics.ts` — 22/22
- `test-disposal-cleanup.ts` — 15/15
- `test-retry-bounds.ts` — 23/23
- `test-tunnel-lifecycle.ts` — 21/21
- `test-optimizations.ts` — 77/77
- `typecheck`, `lint`, line endings 54/54 — pass

**27/73 tasks passed.**
