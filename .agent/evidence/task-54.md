# TASK-54 — Persian UI browser smoke

- **Status:** passed
- **Date:** 2026-09-27
- **Suite:** `scripts/test-smoke-fa.ts` — 105 assertions, real Chromium, real
  production build, disposable database, both locales.

## Already covered elsewhere

`test-rtl-browser.ts` (33/33) proves `<html lang>`/`<html dir>`, computed body
direction, `td` physical-edge geometry, and single-viewport overflow. This suite
fills the gaps the task names and that suite does not reach.

## What this suite adds

1. **Overflow at three widths** — 375 / 768 / 1280 — across 10 routes in both
   locales (60 assertions).
2. **Dialogs** — node and webhook dialogs open, do not overflow, label every
   field, and take focus, in both locales.
3. **The tunnel wizard** (`/tunnels/new`) and **table header alignment**.
4. **Untranslated English leakage** across all 10 Persian routes.
5. **Keyboard order parity** between `en` and `fa`.
6. **The batch-action toolbar**, measured with a row selected.

## Defects found and fixed

| # | Defect | Fix |
|---|--------|-----|
| 1 | Batch toolbar overflowed the viewport by **457px** at 768px, both locales | `flex-wrap` on both rows in `tunnel-table.tsx` |
| 2 | Navbar could not shrink; dragged the document **457px** past the viewport | `min-w-0 flex-1 overflow-x-auto` on the desktop nav, `min-w-0` on mobile, `shrink-0` on the control cluster in `navbar.tsx` |
| 3 | Tunnels page header overflowed by **15px** at 375px | `flex-wrap` + `min-w-0` in `tunnels/page.tsx` |

Defect 3 was verified against true `HEAD`, not against my own memory of it:
reverting the file to `git show HEAD:…` and rebuilding reproduced
`15px wider; worst: div.flex items-center gap-2`.

## Test bugs caught before they became false evidence

- **`/fa/dashboard` does not exist.** The dashboard is the locale root. Nothing
  links to a `/dashboard` route. The 404 check records the URL, which is the only
  reason this was diagnosable.
- **"New tunnel" is a link, not a dialog.** `/tunnels`'s primary action is an
  `<a href="/tunnels/new">`, so a `button` search found nothing on a working page.
- **A fixed 40-tab budget measured copy length.** `en` and `fa` reached 40 and 39
  stops with identical sequences; the comparison now uses the shared prefix.
- **The leak check flagged its own fixture.** The harness seeds the admin as
  "Super Admin" — record data, not UI copy.
- **The leak list did not contain the strings the mutant changed.** Mutating a
  subtitle to English passed because that exact string was not in the list. The
  list is now built from the real English catalog values.

## Seeding the real states

Two checks could not run until the suite created the state that renders them:

- the **batch toolbar** only exists when `selected.size > 0`;
- the **header row** only carries real width when there is a subtitle and two
  real buttons.

The suite now seeds two disposable nodes and a tunnel through the **real API**,
then clicks the real "Select all" button. Getting the fixtures right took three
corrections, each driven by the API's own validation error rather than guesswork:
`type` is the node ROLE (`IRAN`/`FOREIGN`), `clientNodeId`/`serverNodeId` are
required UUIDs, and `TunnelConfigSchema` is a Zod discriminated union needing
`method: "PORT_FORWARD"`. Selection is a labelled `button`, not
`input[type=checkbox]`.

## Mutation evidence

```
KILLED  M1-navbar-no-min-w-0              FAIL tablet/en/ has no horizontal overflow | FAIL tablet/en/tunnels ...
KILLED  M2-batch-toolbar-no-wrap          FAIL mobile/fa/tunnels batch toolbar stays inside the viewport
KILLED  M3-tunnels-header-unfixed         FAIL mobile/en/tunnels has no horizontal overflow | FAIL mobile/en/tunnels batch toolbar ...
KILLED  M4-english-leak-in-fa             FAIL fa/webhooks shows no untranslated English
KILLED  M5-drop-rtl-override              FAIL fa table headers align to the correct physical edge
=== 5/5 mutants killed ===   (0 invalid, 0 survivors)
```

**M3 survived four sweeps before the real cause was found, and the reason is
worth recording.** The fix is three redundant properties (`flex-wrap` on the
outer row, `min-w-0` on the title, `flex-wrap` on the action cluster), and
removing any ONE of them leaves the page non-overflowing. So three
single-property mutants were useless — a survivor from one of them is a fact
about redundancy, not about test strength.

The next layer was a bug in my own harness. M3 installed three edits **to the
same file**, and each edit was written from its own pre-mutation snapshot, so
every write restored the pristine text and only the last edit survived. The
mutant that "survived" was simply a much smaller diff than intended. The harness
now groups edits by file, applies them cumulatively to one buffer, and restores
from the pristine map.

M5 also survived initially for a legitimate reason: the existing RTL suite
measures `td` geometry, while the `rtl:text-right` override lives on the shared
`th`. The header-alignment check was added to close that gap.

## Not claimed

This is a Persian **smoke** suite, not a full RTL audit. No visual-regression
snapshots, no testing of mixed-direction content beyond the `direction: ltr`
leak check, and no screen-reader run. `TASK-48` owns contrast, target size and
reflow.
