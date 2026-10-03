# TASK-51 — Login, session and dashboard smoke

**Status:** passed
**Date:** 2026-09-27

TASK-51 is the gate for the browser chain (`TASK-52 → 53 → 54 → 48`). It is the
first suite in this repo that walks a full user journey end to end — disposable
database → anonymous redirect → failed login → successful login → dashboard
load → every static asset → logout → server-side revocation — against a real
production build in real Chromium.

## Suite

- `scripts/test-smoke-auth.ts` — 35 assertions
- `scripts/mutate-smoke-auth.ts` — mutation harness (discards invalid mutants)

Run: `TURBO_DISABLE=true npm run build && npx tsx scripts/test-smoke-auth.ts`

## Four real defects

### 1. Logout never revoked the session (the shipped bug)

`apps/web/src/components/navbar.tsx` called a raw `fetch` for
`POST /api/auth/logout`:

```tsx
await fetch("/api/auth/logout", { method: "POST" });
router.replace("/login");
```

`/api/auth/logout` runs `csrfGuard` (`apps/web/app/api/auth/logout/route.ts:4`),
which rejects any non-GET without a matching `X-CSRF-Token`. A raw `fetch` sends
no such header, so the server answered **403** and `destroySession()` was never
reached. The user was redirected to `/login` while still holding a live session
— the UI looked like it worked.

It is the only mutation in the app's client code that bypassed `apiFetch`; the
other seven raw `fetch` call sites are GETs or already pass the header.

Fixed to use `apiFetch`, and the client now **reports** the failure instead of
navigating anyway:

```tsx
const res = await apiFetch<{ ok?: boolean }>("/api/auth/logout", { method: "POST" });
if (!res.ok) { toast.error(t("logoutFailed")); return; }
router.replace("/login");
router.refresh();
```

Proven directly, not inferred:

```
ok  a raw logout with no CSRF header is refused with 403 (so the shipped bug was real)
ok  the browser sends a CSRF header with the logout request (server answered 200)
ok  the server revoked the session (GET /api/nodes -> 401 :: {"error":"Unauthorized"})
```

### 2. React #418 hydration mismatch on the dashboard

`ActivityPanel` is a client component that formatted "x minutes ago" from
`Date.now()` during render. The server stamped the string at render time and the
client recomputed it moments later, so any entry near a unit boundary produced
two different text nodes (minified React error #418, "text content did not
match").

A lazy `useState` initialiser is **not** a fix — React runs it on the server
during SSR and again on the client during hydration, so both sides still call
`Date.now()`. The first render must be a pure function of props. The server now
passes its own clock as `nowMs`; the effect re-reads the real clock afterwards,
where re-rendering is legal.

### 3. The health tooltip ignored the writing direction

`apps/web/src/components/connection-status.tsx:41` mixed a logical offset
(`me-2`) with a physical anchor (`right-full`). `right-full` pins the tooltip to
the physical right in both directions, so in Persian it was pushed out through
the wrong edge of the navbar. Fixed to the logical `end-full`.

The assertion is the **pair** of measurements, not either one alone:

```
ok  the health tooltip flips with the writing direction (en: left, fa: right)
```

A physical anchor passes in English — which is how this shipped.

### 4. The account menu had no accessible name

The navbar's only sign-out control is a single avatar initial, which a screen
reader announces as one meaningless character. Added `nav.accountMenu`
("Account menu" / «منوی حساب کاربری») and marked the avatar `aria-hidden`. A
stable `data-testid` was added so a naming regression fails the *naming
assertion* rather than breaking the click.

## Test defects found and fixed while building this

Every one of these produced a green tick that proved nothing, or a red one that
blamed the product for a harness bug.

| Defect | Consequence |
|---|---|
| `page.evaluate` cannot see Node-scope variables | `ReferenceError` before any assertion ran |
| Module-scope `await` under this repo's `tsx`/CJS | transform error, not a runtime one |
| Hardcoded `/^(Log out)$/` | the menu read "Sign out"; reported "no logout control exists" while one was on screen |
| Probed `/en/dashboard` | no such route — the `(app)` group root *is* the dashboard; reported 404 as a product failure |
| Asserted the CSRF cookie on the anonymous login page | it is minted by `createSession`, i.e. by the *login response* |
| Asserted the CSRF cookie was `httpOnly` | it is `httpOnly: false` **on purpose** — the double-submit pattern requires JS to read it |
| `serverSeesSession` used `POST /api/auth/refresh` | returns 401 both for a revoked session and a missing CSRF header, so a broken logout looked identical to a working one — this is why M1 survived the first sweep |
| Probed login fields while authenticated | zero controls found; the vacuity guard caught it |
| `.tabular-nums` sampled the "0/0" node counters | the relative-time check read `0 \| 0 \| 0/0` |
| `.animate-fade-in-up, [class*=card], .rounded-lg` + `Array.find` | `find` returns the outermost match; the panel was never located |
| `closest("div")` from the sr-only status span | measured an 8px-wide inner wrapper |
| `span.whitespace-nowrap.pointer-events-none` | also matches `ui/button.tsx`; measured a button |
| Filtered stamps by `^(now\|min\|hour\|day)` before checking for decay | a frozen clock produced an **empty** list, so the decay check passed vacuously |
| A backtick inside a comment inside a `readJson` template literal | `Expected ")" but found "closest"` — terminated the literal |

## Mutation results

```
=== baseline (unmutated) ===
baseline: 35 passed, 0 failed (exit 0)
  M1-logout-raw-fetch:          killed (31 passed, 4 failed)
  M2-avatar-unnamed:            killed (34 passed, 1 failed)
  M3-hydration-nowms:           killed (34 passed, 1 failed)
  M4-connection-anchor-physical: killed (34 passed, 1 failed)
  M5-server-clock-frozen:       killed (34 passed, 1 failed)
=== 5/5 mutants killed (0 discarded as invalid) ===
```

### Two survivors that had to be explained before they could be accepted

**M1 "survived" while not being the bug.** The first version of the mutant
called `apiFetch` with `headers: {}` — but `apiFetch` *injects* `X-CSRF-Token`
itself for any non-GET method (`apps/web/src/lib/client.ts:25`), so the mutant
was not the shipped bug at all. A survivor has to be explained, not recorded.

**M5 survived honestly and revealed a second defect.** Pinning the clock to the
epoch on the server is invisible: the effect re-reads the real clock a moment
after hydration and overwrote the label. Pinning the clock in the *formatter*
did show up — but as `now | now | now` rather than `56 years ago`, because one
constant is subtracted from every entry at once. The check now requires the
stamps to be **distinct**, which is what a real per-entry clock produces:

```
ok  relative timestamps come from a real, per-entry clock (now | 2s ago | 3s ago)
```

### Discarded rather than counted

Mutants that fail typecheck (`TS6133` unused import, `TS2322` bad literal) are
reported as `discarded (invalid)` and are **not** survivors — counting them as
survivors would inflate the apparent strength of the suite. The harness also
verifies each mutation is actually on disk before blaming the test, and restores
byte-exact copies afterwards.

## Assertions and their evidence

```
--- protected routes redirect an anonymous visitor ---
  ok  anonymous /en redirects to login /en/nodes /en/tunnels /en/settings
--- the login page itself ---
  ok  both fields have visible labels — Email / Password
  ok  a failed login is announced in a role=alert region
  ok  a failed login grants no server-side session
  ok  a full page reload keeps the session — /en
--- after login ---
  ok  after login the CSRF cookie is present and JS-readable (cookies: xt_csrf)
  ok  a mutation without X-CSRF-Token is refused with 403
  ok  a raw logout with no CSRF header is refused with 403
--- the dashboard renders ---
  ok  the dashboard has a heading — Welcome back 👋
  ok  540 chars, 7 card(s)
  ok  a recent activity row renders a relative time (now | 2s ago | 3s ago)
  ok  relative timestamps come from a real, per-entry clock
  ok  the health tooltip flips with the writing direction (en: left, fa: right)
--- every static asset actually loads ---
  ok  158 asset(s), all 2xx with the right content-type
--- no uncaught page or console errors ---
  ok  no uncaught exceptions
  ok  no console errors — 2 suppressed hint(s)
--- logout revokes the session for real ---
  ok  the account trigger has an accessible name — "Account menu"
  ok  a logout control exists — Sign out
  ok  the browser sends a CSRF header with the logout request (server answered 200)
  ok  logout returns the user to the login page — /en/login
  ok  the server revoked the session (GET /api/nodes -> 401)
  ok  all 2 signed-out login fields have an accessible name
```

## Regression gates

```
test-smoke-auth 35 · typecheck 0 errors · lint 0 errors (24 pre-existing
warnings) · build 0 · line-endings 54/54 · locale parity 15/15
```

Neighbouring suites re-run green: `test-state-a11y 50`, `test-a11y-baseline 58`,
`test-rtl-browser 33`, `test-dialog-keyboard 34`, `test-a11y-browser 13`,
`test-locale-parity 15`, `test-line-endings 54`, `test-optimizations 77`,
`test-supply-chain 49`, `test-secret-redaction 52`, `test-auth-security 30`,
`test-rate-limit 30`, `test-method-matrix 50`.

Locale catalogs: **524 / 524**, exact parity.

### One note on the React purity lint

`react-hooks/purity` rejects a bare `Date.now()` inside a component body. The
fix was to move the read into a plain module-scope helper, `servedAtMs()`, and
pass the resulting **value** to the client — not to disable the rule and not to
disguise the expression as a derived `new Date(Date.now() + 0)`. The rule is
right: reading the clock during render is precisely the defect this task fixed.

## Not claimed

- No screen reader was run. Accessible names are verified through the
  accessibility tree's own naming rules, not through NVDA/JAWS/VoiceOver.
- No 2FA, password reset, or session-expiry journey exists.
- No concurrent-session or token-rotation stress test.
- Login is still CSRF-exempt by design (a cross-site POST cannot read the
  response); the suite asserts the token is issued, readable, **and** enforced.
- `resetPassword` exists in the UI with no backend route; that gap belongs to
  whatever task owns password policy, and is not claimed here.
