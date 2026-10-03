# Cross-origin rejection behind a TLS-terminating proxy

Date: 2026-09-28
Scope: `apps/web/src/lib/auth.ts` — `originAllowed()` scheme comparison.

## Symptom

The user reported "Cross origin error for everything" after installing the panel on a
VPS: every browser action was rejected. `scripts/test-optimizations.ts` reported
`74 passed, 3 failed of 77` (baseline was 77/0).

## Root cause

`originAllowed()` refused any Origin whose scheme differed from `requestScheme()`:

```ts
if (o.protocol !== requestScheme(request)) return false;
```

`requestScheme()` falls back to `new URL(request.url).protocol`. The Next standalone
server REBUILDS `request.url` from its own bind address (`install.sh` sets
`HOSTNAME=0.0.0.0`), so it always reports the **internal hop** — `http:`, even when
the browser connected over https. A browser on `https://panel.example` therefore sent
`Origin: https://panel.example` against a panel that saw itself as `http:`, and every
request was refused. It passed only for non-browser clients, which send no `Origin`
and short-circuit above the comparison.

The same root cause produced both remaining failures: a proxy that rewrites
`X-Forwarded-Host` but omits `X-Forwarded-Proto` leaves the scheme equally unknown.

## Fix

The scheme check now applies only when the scheme is actually known —
`XT_TRUST_PROXY=true` **and** a valid `X-Forwarded-Proto` is present
(`forwardedProtoIsPresent`). Otherwise the host comparison alone decides.

This does not weaken the boundary: forging `X-Forwarded-Proto` requires
`XT_TRUST_PROXY`, and without that flag `requestHost()` ignores `X-Forwarded-Host`
too, so the host being compared is the one the client genuinely addressed.

Two helpers were separated because callers needed different signals:
`safeRequestProtocol()` returns `null` when unparseable (a "do we know?" question),
while `requestScheme()` still returns `"http:"` (a fail-closed security answer).

## Verified behaviour

| Case | Result |
|---|---|
| `host=panel.example`, `Origin=https://panel.example` | accept |
| `host=panel.example:8443`, `Origin=https://panel.example:8443` | accept |
| trusted proxy, `X-Forwarded-Host` set, no `X-Forwarded-Proto` | accept |
| trusted proxy, `X-Forwarded-Proto: http`, `Origin=https://…` | **reject** (downgrade) |
| trusted proxy, `X-Forwarded-Proto: https`, foreign Origin | **reject** |
| no trust, spoofed `X-Forwarded-Host: evil.example` | **reject** |
| `Origin=https://panel.example.evil.example` (suffix) | **reject** |
| `Origin=https://evilpanel.example` (prefix) | **reject** |
| `Origin=https://panel.example@evil.example` (userinfo) | **reject** |

## Corrected test

`scripts/test-origin-csrf.ts` asserted an https Origin on an http host must be
REJECTED — the opposite of `test-optimizations.ts`'s "accepts domain and https
origins", with an identical host/origin pair. It failed on committed code too
(verified by stashing `auth.ts`), so it was a stale expectation, not a regression.

The test now asserts the invariant that actually matters: cross-SITE Origins are
refused whatever their scheme, and a scheme mismatch is refused when a trusted proxy
actually states the scheme.

`scripts/test-optimizations.ts` had a second wrong expectation: it required
`203.0.113.5` (RFC 5737 TEST-NET-3, documentation space) to be treated as PUBLIC.
The SSRF guard correctly blocks it; satisfying that assertion would have made a
documentation range dialable. The test now requires all three RFC 5737 ranges to be
blocked.

## Results

| Suite | Before | After |
|---|---|---|
| `test-optimizations.ts` | 74/77 | **77/77** |
| `test-origin-csrf.ts` | 65/66 | **69/69** |
| `test-auth-security.ts` | 30/30 | **30/30** |

`npx eslint` 0 findings on all three files; `npm run typecheck` 0 errors.

## Security note

No real secret values, tokens, cookies, or env-file contents appear in this file, in
the fixtures used above, or in any test output.
