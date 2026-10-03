# TASK-43 evidence — rate-limit and abuse controls

**Status:** passed

## The finding: 9 state-changing routes had no ceiling at all

17 of 31 API routes carried an explicit `rateLimit(...)` policy. The 14 without
one included **nine state-changing routes** — the wrong side of that line. A
cheap GET is cheap; an unbounded POST is not.

The clearest gap is `POST /api/users`. It is guarded by
`requireSession(request, "ADMIN")`, so an authenticated ADMIN — a compromised
or merely careless one — could create accounts with no ceiling, and **each
request runs `hashPassword`, an scrypt at ~100ms**. Ten concurrent requests
saturate a 1 vCPU core, which is precisely the VPS profile this release
targets. The other eight let a single session create nodes (each spawning an
SSH connection attempt), port forwards, webhooks, and tunnels unbounded.

The existing limits were also on the *right* routes: `tunnels/[id]/actions`,
`nodes/[id]/test`, `settings/backup`, `settings/password` were all covered. The
gap was the CRUD writes, which had been treated as cheap because they are
usually few.

### Routes now bounded

| Route | Bucket | Limit |
| --- | --- | --- |
| `POST /api/users` | `users-create` | 10/min |
| `PUT /api/users/[id]` | `users-update` | 20/min |
| `POST /api/nodes` | `nodes-create` | 20/min |
| `PUT /api/nodes/[id]` | `nodes-update` | 30/min |
| `POST /api/port-forwards` | `pf-create` | 20/min |
| `PUT /api/port-forwards/[id]` | `pf-update` | 30/min |
| `DELETE /api/tunnels/[id]` | `tunnel-delete` | 30/min |
| `POST /api/tunnels/[id]/logs` | `tunnel-logs` | 20/min |
| `POST /api/webhooks` | `webhooks-create` | 20/min |
| `PUT /api/webhooks/[id]` | `webhooks-update` | 30/min |

Every bucket is keyed on `auth.user.id` — the **authenticated** identity, and
always *after* `requireSession`, so an unauthenticated caller can never consume
another user's bucket. The limits are deliberately looser than the scrypt-heavy
`settings/password` (5/min) and the batch/backup routes (10/min).

## Live proof, not just source inspection

Grepping for `rateLimit(` proves presence, not behaviour. The suite boots the
**production build**, migrates a throwaway database, provisions a **disposable**
admin, signs in, and hammers `POST /api/users` against its 10/min bucket:

```
ok  the newly limited route still serves requests below the cap
ok  a live request past the cap is refused with 429 — statuses seen: 201,429
ok  the 429 body does not echo the bucket key or the account email
    — {"error":"Too many requests, slow down"}
```

`201` proves the route still works; `429` proves the cap is real; the body check
proves the refusal says nothing about the bucket.

## Rate limiting did not replace anything

The task notes that rate limiting is not a substitute for auth, CSRF, or SSRF, so
the suite asserts those were **not** weakened to compensate: login still calls
`verifyPassword`; the CSRF guard still calls both `originAllowed` and
`assertCsrf`; `requireSession` is still the route guard; the tools route keeps
its SSRF guard alongside its limit.

## Trust boundary preserved

- `getClientIp` still returns `null` unless `XT_TRUST_PROXY` is exactly
  `"true"`. The suite asserts the guard's literal text, so a loosened default
  fails rather than passing quietly.
- The login **IP** bucket is applied only when a trusted client IP exists, and is
  keyed from a single source.
- The login **email** bucket stays unconditional, so rotating a header cannot
  buy unlimited attempts.

## The limiter itself

Verified rather than assumed: first request allowed with `limit-1` remaining;
`remaining` decrements; the request past the cap is rejected with `remaining: 0`
and **never goes negative** under sustained abuse (a caller rendering it must
not show `-1`); the window resets and allows again; `MAX_BUCKETS` is declared;
eviction triggers at the cap; eviction is **O(1)** rather than the full scan it
replaced; and a refreshed key is deleted-then-set so a reused key is not evicted
as stale.

## No key or secret leaks

No 429 response interpolates a bucket key — the key is `users-create:<uuid>`, and
echoing it would put a user id (or, on login, an email and a client IP) into the
response and every proxy log in between. No bucket key interpolates secret
material.

Two of my own detectors were wrong here and had to be corrected: the 429 scan
used a 220-character window that swallowed the *next* `rateLimit` call's
template literal and reported three false leaks, and the secret detector flagged
`password:${auth.user.id}` — a bucket **label** plus an id, not secret material.
The detector now only flags a sensitive word *inside* a `${...}`.

## Mutation testing: 4/4, after two methodology corrections

The first run reported 1/4 killed. That was **my methodology, not the suite**:
mutants B, C and D change runtime behaviour, so they only take effect after a
rebuild — and I had been editing source while the live checks ran against
`apps/web/.next` from before. Three mutants "survived" because nothing had
changed in the code that was actually executing.

Fixed by rebuilding for each mutant, and by adding a **staleness guard** to the
suite so this cannot happen silently again: it walks the whole compiled build
for the current bucket string and fails if the source has it but no chunk does.
(Next splits a handler across shared chunks — the string is in
`chunks/_1_ap_zg._.js`, not in `route.js` — so the first version of the guard,
which only read `route.js`, reported a false "stale".)

With a real rebuild each time, all four die:

| Mutant | Caught by |
| --- | --- |
| A — delete the limit | `all 20 state-changing routes carry a rate limit` |
| B — raise the limit to 100000 | `a live request past the cap is refused with 429` |
| C — echo the bucket key in the 429 | `the 429 body does not echo the bucket key or the account email` |
| D — key the bucket on `x-forwarded-for` | `every rate-limit key derives from the session or the trusted-IP helper` |

**D is the one that mattered.** It survived even with a rebuild, because nothing
in the suite constrained *where a bucket key may come from*. Keying a limiter on
a caller-controlled header makes it decorative: rotate the header, get a fresh
bucket, and the cap never applies. The suite now asserts that **every** key in
the app derives from `.user.id`/`.user.email` or the trusted-IP helper.

That assertion immediately produced a false positive on `tunnel-logs:
${authz.auth.user.id}` — the same identity as `auth.user.id`, reached through
the logs route's `authorizeTunnel()` wrapper. The matcher now reads the trailing
property, so any wrapper is accepted while a header still is not.

## A structural note

Building this suite took several wrong turns on brace nesting after I wrapped
the live section in an async IIFE: `main()` closed early, a duplicate
`void main().then(` was left behind, and the errors read as
`Expected ")" but found "void"`. Four rounds of guess-and-patch made it worse
before a structural analysis located it. The lesson worth keeping: when a parser
says a delimiter is missing, bisect the file and re-parse prefixes rather than
adding or removing braces by hand.

## Coverage: 28 assertions

Limiter behaviour (6); route coverage across 20 sensitive routes plus 3
deliberate public exemptions; the trust boundary (4); independence from
auth/CSRF/SSRF (4); no key or secret leakage (2); live HTTP behaviour (3).

## Not claimed

- **Not a distributed limiter.** The bucket map is per-process and in-memory, as
  its own header comment says. A multi-instance deployment gets per-instance
  limits. That is a known, documented limitation, not a defect fixed here.
- The GC interval (10 min) is asserted by source shape, not by waiting for it.
- The in-memory cap is asserted by source shape; driving 10,000 real buckets
  through the live server was not done.
- No load test establishing which limits are correct for production traffic —
  these are bounded ceilings chosen to stop scripted loops, not tuned SLOs.
