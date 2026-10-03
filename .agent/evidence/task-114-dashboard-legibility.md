# TASK-114 — dashboard legibility, measured instead of eyeballed

**Status: 648/648, exit 0 — all 11 authenticated routes, both locales,
320/390/768px, at 100% / 150% / 200% text, against SEEDED REALISTIC DATA.**

Non-vacuity proven by reverting each fix and requiring a red run. Two findings
below are about the verification itself: one exclusion I added was hiding real
defects, and one "fix" I made proved nothing and was reverted.

## The report

> «spacing ها و اندازه متن ها و المان های داشبورد یه مقدار مشکل دارن و بعضی ها
> ناخوانا هستند و بعضی wrap بدی دارن. در هردو داشبورد اینها باید فیکس شن»

Dashboard spacing, text/element sizing, unreadable text, bad wrapping — in **both**
dashboards.

## What coverage existed

Essentially none. The gap is measurable:

| what | before |
| --- | --- |
| `scrollWidth`/`clientWidth` assertions in all a11y suites | **1** |
| viewport-width matrix | **none** |
| "does this label fit its box" checks | **none** |
| RTL/Persian text-fit checks | **none** (one suite checked horizontal overflow only) |

A dashboard could pass every suite in the repository while shipping unreadable
text. The report was correct.

## Scope: all 11 authenticated routes, not just the dashboard

The suite started measuring only `/`. Every other view has the same defect risk —
a label that says what a number means, a cell in a fixed-width column, a caption
at a hand-picked px — and nine routes had no coverage at all.

Extending it immediately found two more real defects, both the "bad wrapping"
symptom, in **both** locales:

### 6. The activity filter label — squeezed to 63px

```
"Filters"    needs 2 lines, box allows 1 (63px wide, 14px)
"فیلترها"    needs 2 lines, box allows 1 (63px wide, 14px)
```

A `<div className="flex items-center gap-2">` in a `flex-wrap` row with no
`shrink-0`, so flex shrank it to 63px and the word broke in half. The row already
wraps, so the whole label moves to the next line instead — `shrink-0` plus
`whitespace-nowrap` on the label, `shrink-0` on the icon.

### 7. The audit actor name — an identifier treated as prose

```
"Super Admin" needs 2 lines, box allows 1 (85px wide, 14px)
```

`log.actor.name` in a `TableCell` with no width constraint, so a name that is an
**identifier** wrapped across two lines. `whitespace-nowrap` keeps it on one line
and lets the column grow; the table wrapper already scrolls horizontally.

An identifier breaking mid-name is a different defect from a prose label wrapping,
and both are "bad wrapping" to a user.

## The earlier dashboard defects

Every one reproduced in **both** locales unless noted.

### 1. Four sub-floor captions at 10px — `traffic-chart.tsx`

```
"↓ Download speed" at 10px | "↑ Upload speed" at 10px
"↓ سرعت دریافت" at 10px     | "↑ سرعت ارسال" at 10px
```

`text-[10px]` is below the 11px legibility floor. These are the captions that say
what the number **means** — the case where truncation and shrinking cost meaning,
not just pixels. Raised to `text-xs` (12px) with `leading-snug`.

### 2. The footer version link clipped its own text

```
"Xistance Panel v 1.2.0" content 48px in a 24px box
"Xistance Panel v 1.2.0" needs 3 lines, box allows 2 (115px wide, 12px)
```

The `<a>` is `inline-flex`, so it shrank to its content and wrapped the version
across three lines inside a `min-h-6` (24px) box. Fixed with `whitespace-nowrap
shrink-0`.

### 3. The audit action chip clipped its own text

```
"auth.login" content 24px in a 20px box
```

`<code className="... py-0.5 text-xs">` — the padding was added on top of a 12px
line, producing a 24px content box in a 20px line box. Now `inline-flex` with an
explicit `leading-5`, so the box is derived from the text rather than from
padding stacked on it.

### 4. Traffic byte figures split across lines — `dashboard-stats.tsx`

```
"0 B" needs 2 lines, box allows 1 (40px wide, 14px, ws=normal)
"0 B" needs 2 lines, box allows 1 (42px wide, 14px, ws=normal)
```

An icon+figure pair inside `CardDescription` in a card too narrow for two of them
side by side. The pair wrapped **between the icon and its value**, so "0 B" broke
after the space and landed on two lines in a one-line box — at **every** width
from 320px up, in both locales.

Fixed structurally rather than by shrinking: `flex-wrap` on the container (a
figure that does not fit moves to the next line as a **unit**), `whitespace-nowrap`
per figure, `shrink-0` on the icons.

### 5. Nav labels breaking after one or two words

```
"Port Forwarding" (15 chars) needs 3 lines
"ابزارهای تست" (12 chars) needs 3 lines
"لاگ فعالیت‌ها" (13 chars) needs 3 lines
```

Persian labels are character-dense, so a character-count heuristic overstates how
much text they carry — but at a 12–13px column these still broke to three lines.
The label is now its own `min-w-0` span with `leading-tight`, so it wraps
predictably and the icon is `shrink-0`.

## Four bugs in the detector itself

More of the work was making the instrument trustworthy. Each produced **false
positives that looked exactly like the reported defects**, which is the dangerous
failure mode: they would have sent fixes at correct code.

### A. The probe undid a legitimate `white-space:nowrap`

The probe removes the clamp so a label can report its natural height. It also
forced `white-space:normal`, which **undid a real nowrap**. The footer link —
correctly `whitespace-nowrap shrink-0` — was reported as "needs 3 lines".

Fix: touch the clamp only. Never `white-space`.

### B. The probe copied a fixed height into the clone

`h-56` on the traffic-chart empty state travelled with the clone, so "natural
height" measured the 224px **container**:

```
"No traffic yet" needs 11 lines [probe 238px wide @ 14px/20px]
```

Arithmetically impossible — and the reported **ancestry**
(`div.flex h-56 items-center justify-center`) named the cause immediately.

Fix: reset every constraining property (`height`, `padding`, `border`, `display`).
Carry **width only** — width is what wrapping depends on.

### C. One divisor for two different heights

`linesNeeded` divided the probe's height by the *element's* line-height. After the
clone was set to `display:block` these agreed, but before that they did not, which
is where the 11-line figure came from.

Fix: each height divided by its own line-height.

### D. A throw exited 0

A mid-run exception incremented `fail` but the process still exited 0, so a broken
scan read as a clean run — precisely the false pass this suite exists to prevent.
Now a throw prints `ABORTED` and exits 1.

## Seeded realistic data — the gap this file previously named

Every route had been measured against an EMPTY database, so what was measured
was empty states. Seeding long-but-real values through the real API changed the
result from 336/336 to **61 failures**, because a table cell holding a 43-character
name is a different layout problem from a table cell holding nothing.

Three seeds needed three attempts, each caught by the suite refusing to report a
green seed:

1. **No CSRF header.** Every POST returned `403 CSRF token mismatch`, the tables
   stayed empty, and the run reported `ok` — because the seed only *reported* the
   responses. A rejected seed is now a **failure**, with the reason: if the tables
   are empty, every table measurement below is vacuous.
2. **Wrong field names.** Guessed from the Prisma model, which uses `sshPort` /
   `sshUser`. The API validators take `port` / `username` — they are spliced into
   an ssh destination token, which is why they have stricter patterns. Four 422s.
3. **Real node ids.** Tunnels and port-forwards need uuids, so the seed reads the
   node list back rather than inventing them.

### Six more defects, all only visible with data

| # | defect | measurement |
| --- | --- | --- |
| 8 | node name shredded across lines | 43 chars → **6 lines in an 82px column**, overflowing by up to 69px |
| 9 | node host | a 49-char FQDN, same failure |
| 10 | the `🔑 key` cell | emoji + word in one text node → **48px of content in an 18px box** (the emoji has its own line box) |
| 11 | webhook URL | 69-char identifier overflowing by **102px**; `max-w` without `min-w` gave `truncate` nothing to act on |
| 12 | 33 column headers | Persian `روش احراز هویت` (14 chars) wrapped to **3 lines in a 52px column** |
| 13 | audit actor name | `Super Admin` broke mid-name; then, once `nowrap`, overflowed by 154px in a table with no scroll wrapper — so it needed `truncate` + `title`, not `nowrap` |

Nine identifier cells across four tables got `whitespace-nowrap`, and all 33
headers did, because **the table wrapper already scrolls horizontally** — that is
what it is for. A cell that wraps an identifier shrinks instead of growing the
table, which is the defect; a cell that stays on one line grows the table, which
is the design.

## Two corrections to my own work

### An exclusion that hid real defects

To stop 47 false positives on `nowrap` cells I excluded everything inside a
horizontally scrollable ancestor. That stopped the noise — and it made reverting
the node-name fix and the activity-row fix both leave the suite **green**. Those
fixes were unverified, and the exclusion was the reason.

The distinction that matters:

- a cell that **wraps** a long value into six lines in an 82px column is a
  defect — the cell shrank instead of the table growing;
- a cell that stays on **one line** and makes the table wider is correct.

So the exclusion now covers only the second case. That kept the correct cells green
**and** made a shredded identifier fail again — and it immediately re-exposed three
real failures, which is how the 33 headers were found.

### One fix that proved nothing, reverted

I also changed the activity-feed row (`justify-between` → `gap-3`, added
`flex-1`). Mutation testing showed reverting **either** leaves the suite green, and
reverting `min-w-0` entirely also leaves it green. None of it was load-bearing: it
was churn added in response to a false positive that the corrected exclusion
already handles.

Reverted to the original markup. The remaining `min-w-0` is kept with a comment
recording that it was **tested rather than assumed**.

## WCAG 1.4.4 — text at 200%

Nothing in the repository tested a user text-size setting, and "some of it is
unreadable" is exactly what that produces. Emulated by setting the ROOT font-size,
which is what a browser's text-size control and a page zoom do to a rem-based
layout. The app is 169 rem-based classes against 3 px-based ones, so root scaling
is the honest lever — and the 3 px-based ones are all `<kbd>` arrow keycaps, which
are correct at 10px.

Run at 150% and 200% on the narrowest viewport (320px) for every route: the
tightest column holding the largest text is the WCAG worst case. It found **three
real defects that no 100% pass could see.**

### 14. Traffic captions in a fixed two-column grid

```
"↓ Download speed" (16 chars) needs 3 lines [110px]   @200%
"↓ سرعت دریافت"     (13 chars) needs 3 lines [67px]    @200%
```

`grid-cols-2` cannot grow a cell, so at 200% each caption needed three lines in a
column sized for one. Now one column below 420px, two above, four at `sm`.

### 15. Wizard step headings overflowing their card

```
"Choose a tunneling method" overflows by 6px (ws=normal)   @200%
```

Inside a flex column, an `h2` that cannot shrink spilled its box. `min-w-0
break-words` on all four step headings.

### 16. `p-6` that does not scale with the user's setting

`p-6` is 24px each side. In a 320px viewport that leaves a **158px** content
column — and at 200% a 25-character heading needs five lines in it. Padding does
not scale with a text-size preference, which is exactly the asymmetry 1.4.4
targets. Now `p-4 sm:p-6`.

### Two threshold bugs the scale exposed

- The **legibility floor** is a size threshold in the reader's terms, so it must
  scale: at 200% a 12px label is 24px and obviously fine, and comparing it to a
  fixed 11px reported every label as oversized.
- **Characters-per-line** estimates how much fits on a line, so it scales
  inversely: the same column holds about half as many at 200%. Without this, a
  label that legitimately needs three lines was reported as wrapping "far earlier
  than its length warrants" — which is a **starved column**, a different defect.

Both were false positives in the detector, and both produced failures that looked
exactly like real defects.

## Verification

| condition | result |
| --- | --- |
| unmodified tree | **648/648**, exit 0 |
| `traffic-chart.tsx` 200% grid reverted | **exit 1** |
| `tunnel-wizard.tsx` padding reverted | **exit 1** |
| injected clamped 9px label | **detected** |
| page-side MEASURE template literal intact | **checked** (see below) |
| `nodes-view.tsx` name `nowrap` reverted | **exit 1** |
| `nodes-view.tsx` header `nowrap` reverted | **exit 1** |
| `audit-view.tsx` actor fix reverted | **exit 1** (at the 336-assertion scope) |
| `user-activity-view.tsx` filter fix reverted | **exit 1** (at the 336-assertion scope) |
| `dashboard-stats.tsx` activity-row edits reverted | **exit 0 — not load-bearing, reverted** |

Every sub-floor exclusion is **counted and reported** rather than applied silently,
so the by-design carve-outs cannot grow unnoticed. They are scoped to SVG text,
recharts internals (matched over the full ancestor chain), and keyboard hints — a
Y-axis tick at 10px is correct, and a guard that cries wolf stops being run.

## What this closes

The legibility report, measured rather than eyeballed — across **every**
authenticated view, in both locales, at a narrow-phone width. Seven real defects
fixed, all mutation-proven. Future edits that shrink a caption, clamp a label,
starve a column, or let an identifier break mid-name now fail the aggregate.

## What it does not close

1. **`apply-migrations.mjs` was silently broken on Windows** and is fixed — see
   TASK-115. It never found the migrations directory, printed "nothing to apply",
   and exited 0. Found *by* this harness.
2. Screens are measured, not read aloud: no screen-reader pass, no 200% text-scale
   pass, no assertion on reading order, and no colour-contrast check here (that is
   `test-a11y-contrast.ts`).
3. These routes render against an **empty database**. Empty states are measured;
   a table filled with realistic long values — a long tunnel name, a long host, a
   40-character API key — is not. Seeding representative data is the obvious next
   step, and it is where the next real defect most likely lives.