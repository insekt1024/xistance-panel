# TASK-49 evidence — English/Persian direction and catalog parity

**Status:** passed

## What was already correct

Catalog key parity held exactly: **501 keys in each**, zero missing, zero extra,
no empty values, no Persian text leaking into `en`. The root layout already
resolved `lang` from the route segment and `dir` from `localeInfo`, and rejected
an unknown locale rather than rendering it. Twelve Latin-script `fa` values are
protocol and algorithm names (TCP, UDP, BBR, CUBIC, WebSocket); translating them
would make them unrecognisable, so they are asserted as an explicit allowlist
rather than left as an unexplained exception.

## The real defect: `text-right` on every actions column

`ui/table.tsx` — the shared `Table` primitive — had the correct treatment:
`text-left rtl:text-right`. **The eight views that render their own cells never
got it.** They used a bare `text-right` on the actions head and cell, in 16
places across the tunnel table, nodes, users, port-forwards, webhooks, the
dashboard stats, its skeleton, and `responsive-table`.

In Persian every other cell in a row is right-aligned, so those 16 cells pinned
the action buttons to the *opposite* edge from the data they act on. The
asymmetry is the finding: one shared primitive was converted and its consumers
were not.

Also fixed, from the same evidence:

- 31 physical spacing utilities (`ml-`, `mr-`, `pl-`, `pr-`) converted to
  logical (`ms-`, `me-`, `ps-`, `pe-`), which mirror in RTL.
- 6 absolutely-positioned icons converted from `left-*`/`right-*` to
  `start-*`/`end-*`. A hard `right-2` puts a field icon on the *left* of the
  text in Persian, where it overlaps the value being read.
- One bug I introduced and caught: the scripted conversion rewrote the value
  *inside* an `rtl:` override, turning navbar's `ml-auto … rtl:mr-auto` into
  `ms-auto … rtl:ms-0`. A logical property under `rtl:` is a no-op, and the
  nav group stopped being pushed to the far edge. Replaced with a pure logical
  pair, and the test now fails on any `rtl:ms-*`/`rtl:me-*` so it cannot recur.

## Browser verification: 27/27 against a real build

`scripts/test-rtl-browser.ts` boots the production build over HTTP, drives a
real Chromium, migrates a throwaway database, creates a **disposable** admin
(generated per run, never a real credential), signs in through the real login
form, and seeds a node through the real API.

```
ok  en: <html lang> is "en"            ok  fa: <html lang> is "fa"
ok  en: <html dir> is "ltr"            ok  fa: <html dir> is "rtl"
ok  fa/login renders Persian text
ok  fa/login shows no untranslated English form labels
ok  fa: no element containing Persian forces direction: ltr
ok  en|fa body direction:  ltr / rtl
ok  10 routes across en+fa: no horizontal overflow
ok  the disposable admin can sign in — landed on /en
ok  a node was seeded through the real API — status 201
ok  en/nodes: an authenticated data table rendered (1 rows)
ok  en/nodes: the actions column aligns to the left (start) edge
ok  fa/nodes: the actions column aligns to the right (start) edge
```

`playwright-core` 1.63 is used from the host's existing npx cache and pointed at
the Chromium already downloaded, so no project dependency and no ~150MB
download. `spawn npx` returned ENOENT, so the test spawns Next's Node entry point
directly. The CSRF guard refused the first seeding attempt with
`403 CSRF token mismatch` — correctly; the test now reads `xt_csrf` and echoes
`x-csrf-token` exactly as `apps/web/src/lib/client.ts` does, so it exercises the
guarded path rather than bypassing it.

Exit code **77** is reserved for "cannot run here" (no browser, no build, no
boot), which is distinct from both pass and fail, so a skipped browser run can
never be mistaken for a green one.

## Mutation: reverting the fix fails

Reverting `nodes-view.tsx` to a bare `text-right`, rebuilding, and re-running
gave `26 passed, 1 failed`.

**The failure was on the `en` assertion, not the `fa` one.** In an RTL context
`right` *is* the start edge, so the Persian check passes with the defect
present — the bug was only ever visible in English, which is precisely how it
shipped: the primary UI is English and the Persian one merely looked wrong.
Asserting only `fa` would have passed with the bug in. Both locales are now
asserted, and the reason is recorded in the test.

## Test coverage

- `scripts/test-locale-parity.ts` — 15/15. Source-level: key parity, empty
  values, untranslated strings, `lang`/`dir`, `localeInfo` directions, and four
  direction rules (no hard right-alignment, logical margins, no absolute
  `left`/`right`, no logical utility under `rtl:`).
- `scripts/test-rtl-browser.ts` — 27/27. Rendered: `lang`/`dir`, translation,
  computed alignment on a real authenticated table, overflow across 10 routes,
  LTR field leakage, inherited body direction.

## Not claimed

- Screenshots or visual review; these are computed-style and geometry
  assertions, not a human eye on the result.
- Persian typographic quality — line height, letter spacing, and Vazirmatn
  rendering at density are a design review, not a computed property.
- Every route: five representative routes per locale, not all of them.
- Any accessibility verdict. That is TASK-46/47/48/71.
