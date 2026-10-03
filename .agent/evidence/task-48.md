# TASK-48 — Contrast, target size, and reflow

- **Status:** PASSED.
- **Scope:** 8 authenticated routes (`/`, `/tunnels`, `/nodes`, `/users`, `/audit`, `/settings`, `/webhooks`, `/tools`) × 2 locales × 2 themes, measured in real Chromium against the production build on a disposable database.
- **Not claimed:** this is *not* WCAG 2.2 AA certification. It is automated measurement of three success criteria on the routes listed. No screen-reader run, no 200% browser-zoom run (reflow is measured at 320 CSS px, the WCAG 1.4.10 equivalent), and no human audit.

## Suite

`scripts/test-a11y-contrast.ts` — 72 assertions, exit 0.

| Criterion | What is measured |
| --- | --- |
| **1.4.3** text contrast (AA) | Resolved sRGB of every element that directly renders text, composited over the *painted* backdrop found by `elementFromPoint` at the element's centre, walking ancestor backgrounds until opaque. Threshold 4.5:1, or 3:1 for text ≥24px or ≥18.66px bold. |
| **1.4.11** non-text contrast (AA) | Every visible `input`/`select`/`textarea` border against the body surface. Threshold 3:1. |
| **2.5.8** target size (AA) | Every visible `button`, `a[href]`, input, select, textarea and `role=switch/checkbox/tab`. Threshold 24×24 CSS px, with the documented inline-link-in-a-sentence exception. |
| **1.4.10** reflow (AA) | `documentElement.scrollWidth - clientWidth` at a 320 CSS px viewport, per route per locale, with a report of the widest offender. |

Three measurement decisions worth recording:

- **oklch is resolved through a canvas.** `getComputedStyle` returns the authored `oklch()`, and the browser will not convert it. The probe paints the colour into a 1×1 canvas and reads the pixel back, so the comparison runs in real sRGB.
- **Visually-hidden text is excluded.** `sr-only` text is clipped to 1px and has no painted backdrop; the hit-test returns whatever it overlaps, which is an artifact, not a defect. WCAG 1.4.3 applies to what is *seen*. The first baseline failed `connection-status` for exactly this reason and the probe was corrected, not the component.
- **Every browser snippet is parse-checked before any work starts.** A syntax error inside `page.evaluate` only surfaces when that snippet runs, and the non-text block runs *last* — after the whole contrast matrix. That cost a 12-minute build-and-browser cycle to learn a one-character regex escape. `assertPageScriptsParse()` now compiles all four snippets first and prints the offending line.

## Defects found and fixed

Baseline was **28 passed, 44 failed**. Final is **72 passed, 0 failed**.

### 1. `* { border-color: var(--border) }` silently defeated every `border-*` class

`apps/web/app/globals.css` declared the default border colour with a bare universal selector. In Tailwind v4 utilities are not in a higher cascade layer than unlayered CSS, so the universal rule competes at specificity `(0,0,0)` and — being later in source order — **wins**. The built CSS showed it at byte 50325 against `.border-input` at 21744.

Consequence: `border-input`, `border-destructive`, `border-primary`, `border-success/60` — every border colour utility in the app — was inert. The settings password field rendered `lab(90.952 …)`, its inherited default, and measured **1.26:1**.

This was not a token problem. Darkening `--input` changed nothing, because the token was never consulted. The fix is `@layer base { * { … } }`, which puts the default *beneath* the utilities so it applies until a component names a colour of its own.

### 2. `FormInput` and `FormSelect` specified no border colour

Both used `border` with no colour class, so they inherited the universal default and never consulted `--input` even before defect 1 existed. Given `border-input`.

### 3. Success and warning badges were unreadable as text

`bg-success/15 text-success` put `oklch(0.627 …)` on a 15% tint: **2.72:1**. Added `--success-foreground` / `--warning-foreground`, darkened for light mode and lightened for dark, and pointed the badge variants at them. 4.63:1 measured.

### 4. `--input` was far too light to see

Even with the class finally applied, `oklch(0.716)` measured **2.52:1** against a white card. Dropped to `oklch(0.55)`; light mode now passes, dark mode 3.5:1. Both values were chosen by measurement, not by estimating the OKLCH lightness ramp — the first estimate was wrong by a wide margin.

### 5. `--muted-foreground` sat at 4.35:1

`oklch(0.556)` on `--muted` is just under the 4.5 AA floor. Darkened to `0.528`; the affected "Unknown" state and tab labels now measure 4.51:1.

### 6. Four controls were under the 24×24 minimum target

- The shared `Switch` was 36×20. Now `h-6 min-h-6 w-9 min-w-9` — the visual track is unchanged; the extra pixels are transparent hit area.
- The tunnel table's select-all and per-row select buttons wrapped a 16×16 box in a `<button>` with no padding, so the *button* was also 16×16. Given `-m-1.5 min-h-6 min-w-6 p-1.5`.
- The `Xistance Panel v1.1.2` footer link in both `layout.tsx` and `login/page.tsx` was 111×16. It is a standalone footer link, **not** an inline link in a sentence, so the 2.5.8 exception does not apply.

### 7. The traffic chart broke reflow in both locales

`ResponsiveContainer` measures its parent, and the dashboard `Card` is a CSS grid item, which defaults to `min-width: auto` and refuses to shrink below its content. The chart's SVG pushed the card **105px** past a 320px viewport. `min-w-0` on the `Card` root fixes it for every card in the app, and a `min-w-0 w-full overflow-hidden` wrapper around the chart gives the measurement a shrinkable box.

Separately, the chart's controls row and both segmented clusters could not wrap, and the Persian labels are longer than the English ones — so `/fa` overflowed even after the card was fixed. All three now wrap, and the segmented buttons are `min-h-6`.

## Files changed

| File | Change |
| --- | --- |
| `apps/web/app/globals.css` | `@layer base` for the universal border default; `--input` → `oklch(0.55)` light / `38%` white dark; `--muted-foreground` → `0.528`; new `--success-foreground`, `--warning-foreground` and their `@theme inline` registrations |
| `apps/web/src/components/ui/card.tsx` | `min-w-0` on the root |
| `apps/web/src/components/ui/switch.tsx` | 24×24 hit area |
| `apps/web/src/components/ui/badge.tsx` | success/warning use the foreground tokens |
| `apps/web/src/components/ui/form-field.tsx` | `FormInput` and `FormSelect` name `border-input` |
| `apps/web/src/components/traffic-chart.tsx` | shrinkable chart wrapper; wrapping controls row and segmented clusters |
| `apps/web/app/[locale]/(app)/tunnels/tunnel-table.tsx` | 24×24 hit area on both select buttons |
| `apps/web/app/[locale]/(app)/layout.tsx`, `apps/web/app/[locale]/login/page.tsx` | 24×24 hit area on the footer version link |
| `scripts/test-a11y-contrast.ts` | new — 72-assertion suite |
| `scripts/mutate-a11y-contrast.ts` | new — 8-mutant harness |

## Mutation evidence

`scripts/mutate-a11y-contrast.ts` — **8/8 killed, 0 invalid, exit 0.**

| Mutant | Killed by |
| --- | --- |
| M1 — universal `*` border rule moved back out of `@layer base` | 1.4.11 non-text, light **and** dark |
| M2 — `--input` back to `oklch(0.922)` | 1.4.11 non-text, light |
| M3 — success badge back to `text-success` | 1.4.3 text contrast, `light/en/` and `light/en/tunnels` |
| M4 — `--muted-foreground` back to `oklch(0.556)` | 1.4.3 text contrast, `light/en/` and `light/en/nodes` |
| M5 — `Switch` back to `h-5` (20px) | 2.5.8 target size, `/users` in both locales |
| M6 — `min-w-0` removed from `Card` | 1.4.10 reflow, `/` in both locales |
| M7 — `flex-wrap` removed from the chart controls row | suite failure (reflow, `/fa`) |
| M8 — 24×24 hit area removed from both select buttons | 2.5.8 target size, `/tunnels` in both locales |

M1 is the load-bearing one: it proves the `@layer base` change is what makes every `border-*` class functional, rather than the fix being incidental.

## Final gate

All run against a rebuilt production bundle on a disposable database.

| Check | Result |
| --- | --- |
| `test-a11y-contrast` | **72 passed, 0 failed** |
| `mutate-a11y-contrast` | **8/8 killed, 0 invalid** |
| `test-a11y-baseline` | 58 passed, 0 failed |
| `test-state-a11y` | 50 passed, 0 failed |
| `test-rtl-browser` | 33 passed, 0 failed |
| `test-smoke-nodes-tunnels` | 24 passed, 0 failed |
| `test-smoke-routes` | 75 passed, 0 failed |
| `test-smoke-fa` | 105 passed, 0 failed |
| `typecheck` (`tsc -p apps/web`) | 0 errors |
| `lint` (`eslint .`) | 0 errors, 29 pre-existing warnings |
| `test-line-endings` | 54 passed, 0 failed |
| `build` (`TURBO_DISABLE=true npm run build`) | exit 0 |

Nine accessibility/UI/browser suites re-run green after the token and layout changes, which is the check that the shared `Card`, `Switch`, `Input` and chart edits did not regress TASK-46, 47, 49, 50, 51, 52, 53 or 54.

Source restoration after the mutation sweep was verified pattern-by-pattern across all nine touched files.

## Known limitations

- **Not WCAG 2.2 AA conformance.** Three success criteria, measured automatically, on the eight authenticated routes listed. 1.4.11 is measured on form-control borders only, not on every non-text affordance (icons, chart strokes, focus rings).
- **No focus-indicator contrast check.** `2.4.11`/`2.4.13` need a focus-visible ring measured against its adjacent background; that is not in this suite.
- **Reflow is measured at 320 CSS px**, the WCAG 1.4.10 equivalent viewport, not by driving the browser's own 400% zoom. Both are valid readings of the criterion; only one is automated here.
- **No screen reader, no 200% text-size run, no Windows High Contrast Mode.**
- The 1.4.3 probe returns an error rather than a verdict when a text element sits on a gradient it cannot resolve; no such element was found on these routes, so the path is untested.
- Logged in as an **admin**, so admin-only surfaces are covered and non-admin variants are not.

