# TASK-41 — Origin and CSRF negative coverage

- **Status:** PASSED.
- **Scope:** `apps/web/src/lib/auth.ts` (`originAllowed`, `allowedOrigins`,
  `assertCsrf`, `requestHost`, `requestScheme`), `apps/web/src/lib/api.ts`
  (`csrfGuard` ordering), and the login route's gate.
- **Harnesses:**
  - `scripts/test-origin-csrf.ts` — 66 assertions
  - `scripts/mutate-origin-csrf.ts` — 9 mutants, all killed, 0 invalid

## Defects found and fixed

Every item below was reproduced against the guard as it stood, not inferred.

### 1. The CSRF cookie match had no left boundary (high)

`assertCsrf` extracted the token with:

```ts
const match = new RegExp(`${CSRF_COOKIE}=([^;]+)`).exec(cookieHeader);
```

There is nothing before `xt_csrf` in that pattern, so a cookie named
`xxt_csrf` or `evilxt_csrf` satisfied the double-submit check. An attacker who
can set a cookie on the victim's origin (a subdomain, or a plain XSS) could
mint a known `xt_csrf` value under a look-alike name and forge state-changing
requests.

**Fix:** the cookie is now read by exact name with a left boundary
(`readCookie`), splitting on `;` and comparing the segment *before* `=`. A
header over 8 KiB is refused outright rather than scanned. Mutant M1 restores
the regex form; it is killed by `rejects the look-alike cookie xxt_csrf=`.

### 2. The scheme was never compared (high)

`originAllowed` compared `o.host` to the request host. A request with
`Origin: https://panel.example` arriving at an `http://panel.example` panel
was accepted. The allowlist had the same shape.

**Fix:** `ORIGIN_SCHEMES` rejects any non-`http:`/`https:` origin (this alone
covers the `null` a sandboxed iframe sends and `javascript:`), and the scheme
must equal `requestScheme(request)` — which honours `X-Forwarded-Proto` only
when `XT_TRUST_PROXY=true`, mirroring `requestHost`. Mutant M3 is killed by
`rejects an https Origin on an http host`.

### 3. An empty `Origin` was treated as an absent one (medium)

```ts
if (!origin) return true;
```

`origin` is `null` when absent and `""` when the header is present but empty.
`!origin` conflated them, so `Origin:` with an empty value was waved through.
**Fix:** `origin === null` is the absent case; a present-but-empty value is
rejected. Mutant M2 is killed by `rejects an empty origin`.

### 4. `XT_ALLOWED_ORIGINS` was unbounded and unvalidated (medium)

The value was comma-split and trimmed with no cap and no shape check, so
`javascript:alert(1)`, `null`, `*`, `file:///etc/passwd`, an entry with a path
or fragment, and a 4 KiB entry were all stored verbatim. A 5000-entry paste
became a 5000-element `Set` rebuilt and compared on **every** state-changing
request.

**Fix:** entries are validated as a bare `host[:port]` or a full
`http(s)://host[:port]` origin, length-capped at 200 chars, count-capped at 16,
and anything else is dropped with a warning. The parser is exported as
`allowedOriginsForTest(raw)` so the *store* is directly assertable.

The `null` token needed its own rule: it is all letters, so the bare-host shape
accepted it, and `null` is precisely the Origin a sandboxed iframe sends.

Mutants M4 (cap removed) and M5 (shape validation removed) are killed by
`the 17th allowlisted origin is dropped by the cap` and
`a javascript: entry never enters the allowlist store`.

### 5. Login had no origin gate at all (high)

`apps/web/app/api/auth/login/route.ts` called neither `originAllowed` nor
`csrfGuard`. The missing CSRF token is *correct* — there is no session yet, so
there is nothing to double-submit. The missing **origin** check is not: without
it the endpoint accepted a cross-site form POST, the classic login-CSRF that
forces a victim's browser to authenticate as an attacker's account.

**Fix:** `originAllowed` is called before the body is parsed, so a cross-origin
request is rejected without being consumed. Mutant M7 is killed by
`login still enforces the Origin check with a real call` and
`login rejects a cross-origin request before parsing the body`.

## Two things the new code deliberately does not do

- **A bare-host allowlist entry is scheme-agnostic on purpose.** `panel.example`
  means "trust this host on whatever scheme it is addressed with" and
  short-circuits ahead of the same-origin scheme check. An operator who wants a
  scheme writes the full origin. The suite pins this boundary explicitly, and
  separately pins that a bare entry does not extend to a *different* host and
  that a full-origin entry does not permit the other scheme. An earlier
  assertion of mine contradicted the intended design; the test was wrong, not
  the code.
- **`normaliseHost` exists because WHATWG `URL` drops the default port**
  (`http://x:80` → host `x`) while the `Host` header keeps it. Comparing the
  two verbatim rejects the panel's own documented `http://host:80` deployment.
  Both sides are normalised through the same rules.

## Policy pinned by the suite (must NOT tighten)

A missing `Origin` stays allowed — a non-browser client (curl, the installer,
CLI) sends none, and over-blocking breaks them. A forged `X-Forwarded-Host` is
ignored unless the operator opted in with `XT_TRUST_PROXY=true`. The login and
refresh routes stay CSRF-exempt for the same reason login is.

## Test-harness defects found while building this

Recorded because each produced a *false result* that looked real:

- The first run of this suite asserted on a hand-rolled regex of its own; that
  regex was itself invalid (`Unexpected token 'var'` class failure), so the
  suite crashed before testing anything. The anchor check now reads the literal
  source line.
- "A header value containing CRLF is rejected" and "a header with a trailing
  newline is rejected" **cannot be constructed through the `Headers` API** —
  it throws or strips. These were reported as passing/failing for the wrong
  reason. They now assert the platform behaviour explicitly and the impossible
  cases were removed rather than left looking green.
- A bare `tsc` invocation cannot resolve `@xistance/db` or `@/lib/*`, so the
  mutation harness read *every* mutant as non-compiling and discarded all nine.
  It now typechecks with `apps/web/tsconfig.json`.
- Four mutants removed a call and left the declaration unused; `noUnusedLocals`
  rejected them as non-compiling. Each now carries an explicit `void X;` so
  the mutation stays behavioural.

## Verification

```
scripts/test-origin-csrf.ts    66 passed, 0 failed        exit 0
scripts/mutate-origin-csrf.ts   9/9 killed, 0 invalid    exit 0
  M1  CSRF cookie matched by regex, no left boundary     -> look-alike cookie ACCEPTED
  M2  `if (!origin)` for absent AND empty                -> empty origin ACCEPTED
  M3  scheme comparison removed                          -> https origin on http host ACCEPTED
  M4  entry cap removed                                  -> 17th origin ACCEPTED
  M5  shape validation removed                           -> javascript: entry stored verbatim
  M6  X-Forwarded-Host gate removed                      -> gate not found in source
  M7  login origin gate removed                          -> no `if (!originAllowed(request))`
  M8  csrfGuard checks token before origin               -> order changed
  M9  host-only allowlist comparison restored            -> allowlisted bare host:port rejected
```

Each mutant is killed by a **distinct** assertion. An earlier run reported
9/9 while several mutants were all tripping one newly added check; the suite was
extended until every mutant had its own observable, and the earlier run is not
accepted as evidence.

```
npm run typecheck                                  exit 0
npm run lint                                      exit 0
bash scripts/test-line-endings.sh                 54 passed, 0 failed
scripts/test-smoke-auth.ts                        35 passed, 0 failed
```

Restoration after the sweep was verified directly: 0 occurrences of the
`void` markers the mutants added, `allowedOriginsForTest` present twice
(declaration + call), `originAllowed` present twice in the login route
(import + call).

## Not claimed

- No penetration test and no external security review.
- `XT_TRUST_PROXY` is a trust decision, not a control: if the operator enables
  it without a sanitising proxy in front, the forwarded headers are
  attacker-controlled. That is why the gate is opt-in and asserted.
- A missing `Origin` remains allowed. This is a deliberate trade for non-browser
  clients, not a residual defect.
