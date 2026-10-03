# TASK-42 — SSRF and private-network probe protection

- **Status:** PASSED.
- **Scope:** the SSRF guard library, the three outbound-probe routes (`/api/tools`, `/api/nodes/[id]/test`, `/api/xui/test`), and the boundary between them.
- **Not claimed:** this is not a penetration test. It does not exercise the live routes end-to-end over HTTP with a running server; the library is imported and called directly, and the route wiring is asserted against source. There is no test for DNS rebinding, because the guard does not defend against it (see below).

## Suite

`scripts/test-ssrf-guard.ts` — **101 assertions, exit 0.**

Baseline before the fix: **50 passed, 41 failed.**

## What was actually broken

Every defect below was reproduced against the guard as it stood, not inferred.

### 1. `isPrivateIp` returned `false` for **every** IPv4-mapped IPv6 address

```text
false  ::ffff:127.0.0.1
false  ::ffff:10.0.0.1
false  ::ffff:169.254.169.254
false  0:0:0:0:0:ffff:7f00:1
```

The old implementation compared IPv6 strings against a literal list (`::1`, `::`, prefixes `fe80:`, `fc`, `fd`). `::ffff:127.0.0.1` matches none of them. Since a socket treats that address as a connection to 127.0.0.1, this was a complete bypass of the guard using the most commonly published SSRF payload class.

Fixed by expanding any legal IPv6 spelling to 16 bytes and, when the address merely *wraps* a v4 address, classifying it by that v4 address. Covers v4-mapped, deprecated v4-compatible, 6to4 (`2002::/16`) and NAT64 (`64:ff9b::/96`).

### 2. A bracketed IPv6 literal skipped the literal branch entirely

`new URL("http://[::ffff:127.0.0.1]/").hostname` returns the string `[::ffff:7f00:1]` **with brackets**, and `net.isIP()` returns `0` for that. The old `if (net.isIP(host)) return isPrivateIp(host)` therefore never fired, and the host fell through to a DNS lookup of a nonsense name. Fixed by stripping brackets before the literal test — and the strip runs before the bare-label check too, so the value is classified as an *address*, not a name.

### 3. Twelve reserved IPv4 ranges were dialable

All returned `false`: `100.100.100.200` (Alibaba Cloud instance metadata), `100.64.0.1`/`100.127.255.254` (CGNAT), `192.0.0.1` (IETF protocol assignments), `198.18.0.1`/`198.19.255.254` (benchmarking), `198.51.100.1` and `203.0.113.1` (TEST-NET), `224.0.0.1`/`239.255.255.250` (multicast/SSDP), `240.0.0.1`, `255.255.255.255`, `255.255.255.254`.

### 4. A host starting with `-` reached `ping` as a **flag**

```ts
const args = ["ping", "-c", "4", "-W", "3", data.host];
```

A `latency` probe with host `-f127.0.0.1` passed `isBlockedTarget` — it is not an IP, and it is not a known name — and then became the **flood-ping option** aimed at loopback. `isBlockedTarget` only classifies addresses and names; it was never the right place to catch this.

Fixed with `rejectProbeOperand()` in the tools route, called on both host-accepting branches, backed by `looksLikeFlag()` in the library. The library guard also refuses a flag-shaped target directly, so the check does not depend on the route remembering to call it.

### 5. The node-test route returned raw `ssh` stderr to the browser

```ts
return json({ ok: false, message: res.stderr.trim() || "Unreachable" });
```

`ssh` stderr is not a status line. It routinely contains the resolved target, key fingerprints, the identity file path that was tried, and occasionally more. This was flagged during TASK-52 and left in place; TASK-42 closes it.

Fixed with `sshFailureMessage()`, which maps the failure to a known reason. The raw stderr now goes to `console.warn` on the server and the browser gets the sanitised sentence.

### 6. A bare label with no dot was passed to the resolver

`isBlockedTarget("intranet-host")` reached `dns.lookup`. It happened to fail closed in this environment, but that is a property of the resolver, not of the guard. Now refused by `isUnresolvableName()` without consulting DNS at all.

## A bug I introduced and caught

The first fix for the dotted-quad tail used the **decimal** form of a computed hextet:

```ts
`${(parts[0] << 8) | parts[1]}`   // 10.0 -> 2560
```

`parseInt("2560", 16)` is `0x2560`, not `0x0a00` — so `::ffff:10.0.0.1` was being parsed as a *different address*, and the guard silently mis-classified it. The suite caught it (`blocks ::ffff:10.0.0.1 — isPrivateIp returned false`). Fixed with `.toString(16)`. Worth recording: an address classifier that corrupts the address it is classifying is worse than one that does not try.

## The XUI exception stays scoped

`/api/xui/test` deliberately does **not** apply the private-address block, because 3X-UI panels typically live on the operator's own VPS or tailnet. That exception is now pinned by tests rather than by a comment:

- the route does not import or call `isBlockedTarget`;
- the tools route *does* import it explicitly, so the exception cannot be inherited;
- `ssrf.ts` exports no `allowPrivate` / `ALLOW_PRIVATE` opt-out that another route could adopt;
- the route keeps `redirect: "manual"` and rejects URL credentials, so the exception is about the *destination* and does not become a redirect or credential-laundering hole;
- the explanatory NOTE is asserted to still be present.

## Boundary of the defence — stated honestly

The guard validates the **address**, then lets the runtime resolve and connect. A hostile resolver can return a public address for the check and a private one for the connect (DNS rebinding / TOCTOU). Closing that needs a pinned resolution plus a connect-time re-check via a custom `lookup`, which is the correct fix but changes how every probe dials and is not in scope here. The residual risk is bounded by admin-only access, per-user rate limits (20/min tools, 10/min node test, 10/min xui) and short timeouts — bounded, not removed. This is documented in the module header.

The guard also inspects the destination only. A public host that itself proxies inward is out of scope; `redirect: "manual"` covers the redirect half.

## Mutation evidence

`scripts/mutate-ssrf-guard.ts` — **9/9 killed, 0 invalid, exit 0.**

| Mutant | Killed by |
| --- | --- |
| M1 — `::ffff:` unwrapping removed | `blocks ::ffff:127.0.0.1` |
| M2 — CGNAT / metadata check removed | `blocks 100.100.100.200` |
| M3 — `a >= 224` removed | `blocks 224.0.0.1` |
| M4 — bracket strip removed | `unbracket strips the brackets` |
| M5 — the operand-guard **call** removed from both tools branches | `tools route calls the operand guard on both host-accepting branches` |
| M6 — bare-label and un-stripped-bracket rules removed | `isUnresolvableName rejects a bare label and an empty target` |
| M7 — raw `ssh` stderr returned again | `node test route does not return raw stderr` |
| M8 — xui route imports the blocklist | `xui route does not call the blocklist` |
| M9 — http tool set to `redirect: "follow"` | `http tool does not follow redirects` |

Three of these were **survivors on the first sweep**, and fixing them produced real test improvements rather than weakened assertions:

- **M4 and M6** survived because the bracket strip and the bare-label rule overlap — a bracketed v6 literal has no dot, so the label rule caught it even with the strip removed. Both rules are worth keeping; to make each observable, `unbracket` and `isUnresolvableName` are exported and asserted directly, so neither can be deleted silently.
- **M5** survived because the test grepped for the helper's *name*, and deleting the *call* leaves the definition in place. The assertion now counts the call sites and checks `looksLikeFlag`'s own behaviour, so a grep for a symbol is no longer mistaken for evidence of wiring.

## Final gate

| Check | Result |
| --- | --- |
| `test-ssrf-guard` | **101 passed, 0 failed** |
| `mutate-ssrf-guard` | **9/9 killed, 0 invalid** |
| `test-secret-redaction` | 52 passed, 0 failed |
| `test-supply-chain` | 49 passed, 0 failed |
| `test-locale-parity` | 15 passed, 0 failed |
| `typecheck` (`tsc -p apps/web`) | 0 errors |
| `lint` (`eslint .`) | 0 errors |
| `test-line-endings` | 54 passed, 0 failed |
| `build` (`TURBO_DISABLE=true npm run build`) | exit 0 |

## Files changed

| File | Change |
| --- | --- |
| `apps/web/src/lib/ssrf.ts` | rewritten: byte-level IPv6 expansion, v4-unwrap for mapped/compatible/6to4/NAT64, the missing reserved ranges, bracket strip, `looksLikeFlag`, `isUnresolvableName`, `describeAddress`, and a documented statement of the defence's boundary |
| `apps/web/app/api/tools/route.ts` | `rejectProbeOperand()` on the `tcp` and `latency` branches |
| `apps/web/app/api/nodes/[id]/test/route.ts` | `sshFailureMessage()` replaces the verbatim `res.stderr`; raw detail goes to the server log |
| `scripts/test-ssrf-guard.ts` | new — 101-assertion suite |
| `scripts/mutate-ssrf-guard.ts` | new — 9-mutant harness |
