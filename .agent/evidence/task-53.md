# TASK-53 — Remaining authenticated routes, browser smoke

- **Status:** passed
- **Date:** 2026-09-27
- **Routes covered:** port forwarding, users, user activity, audit log, test tools,
  webhooks, settings — each in **both** `en` and `fa`, in real Chromium against a
  real production build on a disposable database.

## What the suite does

`scripts/test-smoke-routes.ts` reuses the shared harness
(`scripts/lib/browser-harness.ts`) and asserts, per route per locale:

1. the page renders **without** the route error boundary;
2. the `h1` equals the value read from the message catalog, so a translation
   change moves the test with it;
3. every interactive control resolves to a non-empty accessible name;
4. every visible form control has a programmatic label;
5. the route produces no console error and no uncaught exception.

Plus, across the set:

- no secret marker (`PRIVATE KEY`, `XT_SESSION_SECRET`, `password_hash`, …) in
  visible content **or in any API response body** — the DOM alone would only
  prove the visible text is clean;
- a deliberately failed `POST /api/settings/password` produces a visible message
  inside a live region;
- each reachable empty state explains itself and, where the route has a create
  action, offers one;
- each primary action is reachable by pressing `Tab`.

## Result

```
75 passed, 0 failed   (exit 0)

every route renders its localized heading, in both locales   60
no secret material in visible content or API responses       2
a failed request is reported to the user, not swallowed       1
empty states explain themselves and offer a real next step    8
the primary action is keyboard reachable                      3
no uncaught exceptions during normal use                      1
```

## Defects found and fixed

### 1. The entire webhooks feature was untranslated

`/webhooks` had **no** i18n at all — no `useTranslations` call, no catalog
namespace. Every heading, table header, dialog title, toast, placeholder and the
page's own subtitle were hardcoded English, and the page even rendered a
permission-denied message in English. A Persian user saw a fully English page.

Fixed: `webhooks-view.tsx` and `webhooks/page.tsx` now use `useTranslations`,
and a new 24-key `webhooks` namespace was added to **both** catalogs (en + fa).
`test-locale-parity` stays green at 15/15.

### 2. Four routes had labels not associated with any control

`tools-view.tsx` (host, port, url), `settings-view.tsx` (current password, new
password) and `users-view.tsx` (name, email, role, quota, password) each had a
`<Label>` immediately above an `<Input>` with **no `htmlFor` and no `id`**. The
visible text next to the box was not the control's accessible name; a screen
reader announced an unlabelled edit field. Fixed with explicit ids.

### 3. Two `<Label>`s had no control at all

`settings-view.tsx` used `<Label>` to head the API-documentation paragraph. A
label naming nothing is invalid markup and reads as a broken label; it is now
plain text in a `<p>`.

### 4. Four controls had no accessible name

- the per-row enable switch and the icon-only delete button on `/users`
  (announced only as "switch, button");
- the per-row enable switch on `/webhooks`;
- both were given `aria-label`s from new catalog keys (`activate`, `deactivate`,
  `deleteUser`, `toggleEnabled`), with `{name}` interpolation so the name is
  specific.

### 5. The webhooks empty state offered no next step

It was a hand-rolled `<Card>`, unlike every other list, so on first run the user
saw "No webhooks configured…" and nothing to click — the create button was in a
separate toolbar above. Replaced with the shared `StateBlock` (which also
announces via a live region) carrying the create action.

## Two test bugs caught before they became false evidence

**A missing catalog key silently disabled two checks.** The matrix named
namespace `activity`, but the real one is `userActivity`; and `webhooks` did not
exist at all. Both lookups returned `""`, and `tabUntil(page, "", 80)` returned
`true` on the first Tab — the keyboard check was passing on an **empty needle**.
The suite now throws on a missing catalog entry rather than degrading to a
vacuous assertion.

**My first "API error is not shown" test was fiction.** I intercepted
`/api/port-forwards` and expected an error `StateBlock`. But every list page is a
**server component** reading Prisma directly — there is no client fetch to fail,
so the injected 500 changed nothing. The test was asserting behaviour the
architecture cannot produce. Retargeted at the real client-fetch failure: a
500 from `POST /api/settings/password` must surface an announced message.

## Mutation evidence

`scripts/mutate-smoke-routes.ts` reinstalls one real defect at a time, rebuilds
(the defects are only observable in the production bundle), runs the suite, then
restores and rebuilds.

```
KILLED    M1-tools-labels-detached     FAIL en/tools labels every form control | FAIL fa/tools labels every form control
KILLED    M2-webhooks-untranslated     FAIL fa/webhooks shows its localized heading
KILLED    M3-users-switch-unnamed      FAIL en/users has no unnamed controls | FAIL fa/users has no unnamed controls
KILLED    M4-webhooks-empty-no-action  FAIL /webhooks empty state offers a real next step
KILLED    M5-settings-swallows-failure FAIL a failed request is reported to the user
=== 5/5 mutants killed ===   (0 invalid, 0 survivors)
```

**M2 survived the first sweep and the reason matters.** The mutant hardcodes
`<h1>Webhooks</h1>`, which *is* the English catalog value, so the `en` check
still passed. It survived entirely because `page.tsx` renders the heading in
**two** branches — the admin view and the permission-denied view — and a
single-occurrence `String.replace` patched only the first. The `fa` page took
the admin branch, which still translated. Two lessons: a `replace` that silently
matches once is not a mutation (the harness now reports the count and supports
replacing all), and an English-literal mutant only proves anything in a
non-English locale.

## Full gate

```
tsc --noEmit -p apps/web/tsconfig.json   0 errors
npm run lint                            0 errors
npm run build (TURBO_DISABLE=true)      exit 0
test-line-endings                       54/54
test-locale-parity                      15/15

test-smoke-routes                       75/75
test-smoke-nodes-tunnels                24/24
test-state-a11y                         50/50
test-a11y-baseline                      58/58
test-dialog-keyboard                    34/34
test-rtl-browser                        33/33
test-smoke-auth                         35/35
```

## Not claimed

This is a **representative smoke matrix**, as the task specifies. It is not
WCAG 2.2 AA conformance. Not covered: contrast ratios, reflow at 320px, target
size, screen-reader runs, and any route reached only behind a non-admin account
(the admin-only branch of `/webhooks`).
