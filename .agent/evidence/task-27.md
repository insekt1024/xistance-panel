# TASK-27 evidence — FRP lifecycle coverage

**Status:** passed

## The two defects were invisible without a real TOML parser

I installed `smol-toml` and parsed the generated output. Both bugs surfaced
immediately and neither was visible by reading the code or grepping the string.

### 1. `allowPorts` was scoped inside `[webServer]`

```toml
bindPort = 7000
auth.token = "..."
[webServer]
addr = "127.0.0.1"
port = 17500
user = "admin"
password = "dashpass"
allowPorts = [80, 443]     # <- inside [webServer]
```

`allowPorts` was pushed *after* the `[webServer]` table header. TOML scoping
means everything after a table header belongs to that table, so frps received
`webServer.allowPorts` and **silently ignored the port allowlist**. The file
parsed cleanly, no error was raised, and the UI showed the allowlist as
configured. The restriction simply did nothing.

Parsed proof before the fix:
```
frps parses. top-level keys: [ 'bindPort', 'auth', 'webServer' ]
  allowPorts landed at: undefined
  webServer: {... "allowPorts":[80,443]}
```

`allowPorts` is now emitted before any table header.

### 2. `allowPorts` values were unquoted

The schema types them `z.array(z.string())`, but generation emitted
`allowPorts = [80, 443]`, which TOML parses as **integers** — not the
`[]string` frps expects. Now quoted: `allowPorts = ["80", "443"]`.

After the fix:
```
frps parses. top-level keys: [ 'bindPort', 'auth', 'allowPorts', 'webServer' ]
  allowPorts landed at: ["80","443"]
```

Both are silent-failure bugs: the config was accepted and the feature was
inert. Neither would have been caught by a schema test, a determinism test, or
a redaction test — only by parsing the output and asking where the keys landed.

## Coverage added

- **Schema** — bindPort bounds/non-integer, empty token, empty proxy list,
  `bindUdpPort` bounds, dashboard port bounds, unsupported proxy type.
- **Parseability** — every generated file parsed with `smol-toml`, and key
  placement asserted, not just absence of an exception.
- **Proxy shapes** — plain tcp, plugin, bandwidth limit, visitor, server-side;
  all parse and expose the expected keys. A visitor emits `serverName` and no
  `remotePort`.
- **Multiple proxies** — each gets its own `[[proxies]]` table with no
  cross-contamination.
- **Determinism** — two calls byte-identical.
- **Credentials** — token/proxy secretKey/dashboard password never survive
  `sanitizeForDiagnostics`, while the *key* survives so the redacted line stays
  diagnosable.
- **Injection** — newline/CR/NUL in the token refused (carried over from
  TASK-26 and re-verified here).
- **Dashboard** — disabled emits no table; missing port falls back to 17500;
  missing password is an explicit empty string rather than an omitted key.

## Non-vacuity

| Mutation | Result |
| --- | --- |
| Move `allowPorts` back after `[webServer]` | **FAIL** `allowPorts is a top-level frps key`, `allowPorts does not leak into [webServer]` |
| Unquote `allowPorts` values | **FAIL** `allowPorts values are strings` |
| Drop the control-character guard | **FAIL** newline, CR and NUL refusals (3) |
| Restored | 28/28 |

## Real-binary limitation (recorded, not claimed)

**No `frps`/`frpc` binary is available on this host, so no real FRP process was
started and no traffic flowed.** The task's note requires pinned-version
documentation and forbids claiming compatibility without the tested version,
so this is stated plainly:

- **Proven:** the generated TOML is syntactically valid, parses, and places
  every key where frp's schema expects it; credentials are redacted; invalid
  input is rejected before generation; the control-character guard prevents
  injection.
- **Not proven:** that a specific upstream frp version accepts this output, and
  that a live proxy forwards traffic. The config keys used (`bindPort`,
  `auth.token`, `webServer`, `allowPorts`, `[[proxies]]`,
  `[proxies.transport]`, `[proxies.plugin]`) are long-stable in frp, but that is
  a claim from documentation, not a test result.

This stays open for the VPS acceptance pass, alongside TASK-26's BACKHAUL
limitation.

## Process errors

- The test file's first version hand-wrote proxy fixtures. The schema supplies
  `transport` defaults, so a literal omitting it can never reach
  `buildFrpClientConfig` through the application — the file crashed testing an
  *impossible* state. Every fixture is now built through `FrpProxySchema.parse`,
  so a fixture is by construction a shape the app can actually produce.
- `smol-toml` was installed with `--no-save`; it is a test-only dependency and
  must not enter the release artifact's dependency set.

## Verified

- `test-frp.ts` — 28/28
- `test-backhaul.ts` — 39/39
- `test-forward-reconcile.ts` — 24/24
- `test-port-allocation.ts` — 27/27
- `test-bounded-caches.ts` — 29/29
- `test-diagnostics.ts` — 22/22
- `test-disposal-cleanup.ts` — 15/15
- `test-retry-bounds.ts` — 23/23
- `test-tunnel-lifecycle.ts` — 21/21
- `test-optimizations.ts` — 77/77
- `typecheck`, `lint` — pass

**28/73 tasks passed.**
