# TASK-40 evidence — authentication and session security

**Status:** passed

## The finding: a user-enumeration timing oracle in the login route

`apps/web/app/api/auth/login/route.ts` computed a real dummy hash at module load
specifically to close this, and documented the intent:

```ts
// Real-format dummy hash (computed once) so unknown-email attempts run the
// full scrypt verification — closes the user-enumeration timing oracle.
const DUMMY_HASH = hashPassword("xistance-never-matches-any-login");
```

Then the branch that should use it skipped it:

```ts
const hashToCheck = user?.passwordHash ?? DUMMY_HASH;
const passwordOk = user?.active ? verifyPassword(body.data.password, hashToCheck) : false;
```

`user?.active ? … : false` **short-circuits**. For an unknown email `user` is
`undefined`, and for a known-but-deactivated account `user.active` is `false` —
in both cases `verifyPassword` is never called, so the scrypt work the dummy hash
exists to perform never happens.

Measured on the unit path: a wrong password against a real account took
**32.6ms**; an unknown email took **0.0007ms**. A ~33,000× difference is far
above network jitter. The response body and status were identical, so this was
not a content leak — **timing was the channel**, and account existence *and
account deactivation* were both remotely enumerable.

Fixed by verifying unconditionally and applying `active` as a separate condition:

```ts
const hashToCheck = user?.passwordHash ?? DUMMY_HASH;
const passwordOk = verifyPassword(body.data.password, hashToCheck);
if (!user || !user.active || !passwordOk) { … }
```

The verification now runs on every path; `active` is only ever an additional
rejection, never a precondition for verifying.

## Live HTTP proof, not just the unit path

The unit measurement proves the code path. `scripts/test-auth-security.ts` also
boots the **production build**, migrates a throwaway database, provisions a
**disposable** admin (generated per run — never a real credential), and measures
real requests through Prisma, the rate limiter, and the audit write:

```
ok  over HTTP, a wrong password and an unknown email cost the same
    — wrong 145ms vs unknown 149ms (0.98x)
```

**0.98×**, against 33,000× before. Skipped loudly (not silently passed) when no
build is present.

## Also changed

`"Invalid email or password"` → `"Invalid credentials"`. The old wording named
one field and glossed the other. It leaked nothing — both failure branches
returned it verbatim — but the asymmetry is exactly what invites a later
`user ? "…" : "…"` branch. The route now returns a single literal. The catalog
string `auth.invalidCredentials` is a client-side message and is unaffected.

## Preserved

- `XT_TRUST_PROXY` remains opt-in. `requestIsHttps`, `getClientIp` and
  `requestHost` all gate forwarded-header trust on it.
- Login remains CSRF-exempt (it is the session-establishing call); refresh and
  logout still require the double-submit token, and both client call sites send
  it.
- Refresh rotation, its 30s grace window, and the access/refresh TTLs are
  unchanged.
- scrypt parameters, the self-describing `scrypt:N:r:p:salt:hash` format, and
  SHA-256 refresh-token storage are unchanged.

## Mutation testing: 4/4

| Mutant | Caught by |
| --- | --- |
| M1 — the original short-circuiting ternary | `verifyPassword is not called inside a short-circuiting ternary` |
| M2 — drop the `?? DUMMY_HASH` fallback | `an unknown email falls back to the dummy hash` |
| M3 — branch the 401 on `user` | `every login failure returns one 401 message literal` |
| M4 — log the password in the audit row | `the login audit log does not record the password` |

## Three errors in my own test, all of which masked a real signal

**Inverted assertion.** `if (fixed(..., "wrong")) ok(...)` — `false` is the
correct result, so a working fix reported as failing.

**A nonsense expression.** The "unknown email" timing was computed as
`timeVerify("", DUMMY_HASH, 1) * 0 + measure(...)`, which is always `0`, so the
ratio was measured against zero. All three samples now go through the same
`measure()`.

**Regexes matching my own comment.** The route now carries a long comment
explaining the defect. Assertions that grep the source matched the prose —
reporting a fix as still broken. Added `stripComments()`; source-shape
assertions now read code only. A fourth assertion was also inverted
(`namesEmail === namesPassword`); naming *neither* is correct.

The suite previously tested a **local copy** of the login branch, which cannot
detect a regression in the real file — it would have kept passing while the route
reverted. It now reads the production route and asserts its shape, alongside
measuring the real route over HTTP.

## Coverage: 30 assertions

Password hashing (salting, format, correct/wrong/empty/malformed/foreign-algorithm
rejection, no plaintext in the hash); the timing oracle on three paths; the
production route's shape; secret hygiene in responses, audit rows and console
calls; token hashing and CSRF length-guarding; live HTTP timing.

## Not claimed

- No HTTPS/TLS behaviour: the `Secure` cookie flag path is asserted by reading
  `requestIsHttps`, not by a TLS-terminating proxy test.
- No distributed rate-limit behaviour; buckets are per-process and in-memory, so
  a multi-instance deployment is not covered here.
- No session-store inspection: logout and rotation are verified through the
  cookie and HTTP surface, not by reading Prisma rows.
- Password-hash cost parameters were not re-tuned or benchmarked.
