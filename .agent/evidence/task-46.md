# TASK-46 evidence — accessibility baseline for shared UI controls

**Status:** passed
**WCAG target:** 2.2 AA
**Suites:** `scripts/test-a11y-baseline.ts` (41 static) · `scripts/test-a11y-browser.ts`
(real Chromium, both locales)

> The task notes say: *do not infer conformance from the presence of an
> `aria-label` alone.* This file therefore separates what is **measured** from
> what is **inspected**, and §6 lists what is deliberately **not** claimed.

---

## 1. What was actually wrong

The shared layer had visible focus styles and real Radix primitives, so it
looked finished. It was not. Fifteen static assertions failed on the first run.
The substantive ones:

### 1.1 Validation errors were not associated with their control — 1.3.1, 3.3.1

`FormField` rendered the error as a **sibling `<p>`**:

```tsx
<Label htmlFor={htmlFor}>{label}</Label>
{children}
{error && <p className="...">{error}</p>}
```

No `id`, no `aria-describedby`, no `aria-invalid`, no `role="alert"`. A
screen-reader user tabbing through the node form would hear a label, reach the
input, and have **no way to know the field had failed** — the message existed on
the page, associated with nothing.

**Fixed.** `FormField` now generates ids and publishes them through context;
`FormInput`/`FormSelect` read them via a new `useFieldIds()` hook and apply
`aria-describedby` + `aria-invalid` to the real element. The error node gets
`role="alert"` so it is announced when it appears. A `hint` prop was added on
the same association.

### 1.2 Status was conveyed by colour alone — 1.4.1

- `ConnectionStatus` signalled health with a green/red dot. The text existed
  **only in `title` and a hover tooltip** — not exposed to assistive tech, and
  unavailable on touch or keyboard at all.
- `StatusBadge`'s dot spans had no `aria-hidden`, so they were announced as two
  empty spans.
- `FormInput`'s green border and `CheckCircle2` check mark had no text
  equivalent.

**Fixed.** `ConnectionStatus` gained an `sr-only` `role="status"` region; both
dot indicators are `aria-hidden`; `FormInput`/`FormSelect` accept a `validLabel`
and render it as an `sr-only` span wired into `aria-describedby`.

### 1.3 English validation messages on a Persian page — 3.1.2

`useFieldValidation` returned literal English:

```ts
if (options.required && !value.trim()) return "Required";
return `At least ${options.minLength} characters`;
```

`nodes-view.tsx` added two more literals of its own (`"Invalid hostname or
IP"`, `"SSH key is required"`). On `/fa`, where the document `lang` is `fa`, a
user could type a short name and be told `At least 2 characters` in English.

**Fixed.** The hook now takes a `messages` object; `nodes-view` supplies a
memoised one from a new `validation` catalog block in both locales.

### 1.4 Other fixes

| Where | Issue | Criterion | Fix |
|---|---|---|---|
| `badge.tsx` | `focus:outline-none` with no replacement — the focus ring was **removed outright** | 2.4.7 | `focus-visible:ring-2` |
| `table.tsx` | `<th>` with no `scope` — a data cell announced without its column | 1.3.1 | `scope` defaults to `"col"`, overridable |
| `skeleton.tsx` | shimmer divs announced as empty regions | 4.1.3 | `aria-hidden` |
| `dashboard-skeleton.tsx` | the loading state was completely silent | 4.1.3 | `aria-busy` + `aria-live="polite"` + translated `aria-label` |
| `dialog.tsx` | close button labelled the literal string `"Close"` | 1.4.1, 3.1.2 | `useTranslations("common")` → `t("close")` |
| `dialog.tsx` | close button used `focus:ring`, not `focus-visible` | 2.4.7 | switched |
| `form-field.tsx` | required asterisk announced as `*` alongside the real `required` | — | asterisk `aria-hidden`; `required` stays on the control |

---

## 2. What was already correct

Recorded so a later change does not "fix" it back:

- **Icon-only buttons all have accessible names.** The suite found exactly one
  (`log-viewer.tsx` close) and it already had `aria-label`. Zero raw `<button>`
  icon-only elements exist in app code.
- **`switch`, `tabs`, `dialog`, `select`, `dropdown-menu`, `tooltip`** are built
  on Radix primitives, which supply `role=switch`/`tab`/`tablist`/`dialog` and
  the keyboard model themselves. The wrappers pass props through rather than
  replacing the semantics.
- **`DialogTitle`/`DialogDescription` exist**, so a dialog can be named.
- **The responsive table keeps real `<table>` semantics** — the header
  association survives the mobile layout.
- **`FormField` always renders a `<Label>`**; a placeholder is never the only
  label.

---

## 3. Representative route inventory

Both locales, real Chromium, real production build, disposable admin, throwaway
migrated database. Placeholder-only secrets.

| Route | Locale | Checked | Result |
|---|---|---|---|
| `/en/login` and `/fa/login` | en, fa | document `dir`; every focusable control has an accessible name; Tab order; visible focus indicator | **pass** |
| `/en` and `/fa` (dashboard) | en, fa | as above | **pass** |
| `/en/nodes` and `/fa/nodes` | en, fa | as above, plus form-control labelling and `aria-describedby` resolution | **pass** |

Recorded in `test-a11y-browser.ts` against the built app, not a mock.

**The Persian pass is not optional.** In RTL the start edge is the right edge;
an English-only check passes a UI that is broken for Persian users. Both
locales are asserted, per the same lesson that TASK-49 established.

---

## 4. The keyboard check is behavioural, not declarative

The static suite can prove `focus-visible:ring-2` exists. It cannot prove a
keyboard user reaches the control, that focus is visible when it lands, or that
the computed accessible name is what a screen reader would derive.

`test-a11y-browser.ts` therefore:

1. blurs the document and presses **Tab** 25 times, recording the focused
   element and reading its **computed** `box-shadow` / `outline` — the actual
   rendered indicator, not the class name;
2. recomputes accessible names the way a screen reader would: `aria-label`,
   `aria-labelledby`, `label[for]`, a wrapping `<label>`, or text content;
3. resolves every `aria-describedby` token and fails if it points at an id that
   does not exist — a dangling reference looks correct in source and is silent
   in practice;
4. requires that a raised `role="alert"` is referenced by some control's
   `aria-describedby`, i.e. announced **and** associated, not just present.

Exit code **77** means the browser could not run. That is reported as
`UNVERIFIED`, never as a pass.

---

## 5. Mutation testing: 7/7

| Mutant | Change | Result |
|---|---|---|
| M1 | control no longer receives `aria-describedby` | **killed** (3 assertions) |
| M2 | `role="alert"` removed from the error | **killed** |
| M3 | valid-state text equivalent gated off (`showValid` → `false`) | **killed** (2 assertions) |
| M4 | hardcoded English `"Required"` restored | **killed** |
| M5 | `badge` focus ring removed again | **killed** |
| M6 | `scope={scope}` removed from `<th>` | **killed** |
| M7 | status dot no longer `aria-hidden` | **killed** |

### Three of these survived the first pass — the same lesson again

M1, M3 and M6 all passed against deliberately broken markup, because the
assertions checked **presence** rather than **wiring**:

- M1: `aria-describedby` still appears in the file (in the hook, and on the
  `<select>`), so grepping for the attribute passed while the `<input>` no longer
  received it.
- M3: the `sr-only` span still existed, gated by `false` instead of
  `showValid && validLabel`. The markup was present; the behaviour was gone.
- M6: `scope = "col"` remained in the destructuring while the attribute was
  removed from the `<th>`, so `/scope=/` matched.

This is the **fourth** time this class has appeared (TASK-44 ×2, TASK-45, now
here). The rule is now fixed: assert the *condition* and the *wiring*, not the
token.

### The browser finding that was NOT a defect

The footer logo link reported no focus indicator in `en` only. Eight diagnostic
rounds later the cause is unambiguous and **the markup was correct all along**:

```
[walk 15] a"Xistance Panel v1.1.2" ring=true  fv=true
[walk 16] li"Welcome back"          ring=true  fv=true    <- Sonner toast steals focus
[walk 17] a"Xistance Panel v1.1.2" ring=false fv=false   <- heuristic says "mouse"
[walk 18] a"Xistance Panel v1.1.2" ring=true  fv=true
```

A third-party toast mounted on login, took focus, and flipped Chromium's
`:focus-visible` heuristic for the **next** Tab — so the control immediately
after it measured as unfocused. Focus that same element programmatically and it
matches `:focus-visible` with `outline: solid 2px` and a full ring.

The suite now dismisses toasts before walking, and reports third-party elements
separately rather than folding them into a failure or a pass.

Two real defects *were* found on the way, both now fixed and guarded statically:
`badge.tsx` had `focus:outline-none` with no replacement at all, and the footer
link declared `focus-visible:outline-none` while its ring's `--tw-ring-*`
variables resolved to `0 0 #0000` — so it had **no** indicator.

### The rule the static suite now encodes

`globals.css` declares a global `:focus-visible { outline: 2px solid }`, so
every focusable element has an indicator **by default**. That makes
`focus-visible:outline-none` a *removal*, not a neutraliser — safe only when a
ring in the same `className` replaces it. The suite asserts both halves.

### Detector defects worth recording

- `/<th[\s\S]{0,300}?\/>/` matched **`<thead>`** 40 characters earlier in the
  file, so the window never reached `TableHead`. Fixed with `(?![a-z])`.
- The same window also ended before the attribute, because a JSX comment sits
  between `<th` and `/>`. Widened to 600 chars.
- `sed` treats `&` as special in the replacement, so `s|scope={scope} ||` was a
  silent no-op and M6 "survived" for the wrong reason. Redone in Python with an
  assert that the file actually changed.

### Others

- I asserted a live region in `AutoRefresh` and `SessionKeepalive`. Both
  `return null` — behaviour, not UI. Demanding markup nobody can perceive would
  have been theatre. Retargeted to `DashboardSkeleton`.
- A "no hardcoded English" regex matched a **comment** explaining the English
  had been removed.
- Typecheck earned its place immediately: an `sr-only` span landed outside
  `FormSelect`'s scope, and four `TS2304: Cannot find name 'showValid'` errors
  caught a half-applied patch the source review had missed.

---

## 6. What is NOT claimed

Stated plainly, because an accessibility claim that overreaches is worse than
no claim:

| Criterion | Status | Why |
|---|---|---|
| **1.4.3 Contrast (Minimum)** | **not verified** | Needs rendered pixels and a colour sample per element. No assertion here. |
| **1.4.11 Non-text Contrast** | **not verified** | Same — needs computed foreground/background pairs for borders and icons. |
| **1.4.6 Contrast (Enhanced)** | out of scope | AAA. |
| **2.5.8 Target Size (Minimum)** | **not verified** | Needs rendered geometry per control. The icon buttons are `size="icon"`; their measured size has not been asserted. |
| **2.4.11 Focus Not Obscured** | partially | The shared dialog declares its overlay and stacking, but no measurement of whether a sticky header covers a focused element. |
| **4.1.2 Name, Role, Value** for **state** | partially | Roles and names are checked. Whether a Radix toggle exposes its pressed/checked state correctly is covered by TASK-47, not here. |
| Screen-reader output | **not verified** | No NVDA/JAWS/VoiceOver run. Every claim here is about the accessibility *tree* and keyboard behaviour, which is a proxy, not a substitute. |
| Full route coverage | **not verified** | Three representative routes. The tunnel editor, settings, users, and audit-log views are not in the browser inventory. |

`1.4.3`, `1.4.11` and `2.5.8` are the three most commonly failed AA criteria in
a dashboard UI built on a dark/light token set, and they are precisely the ones
this task does **not** prove. A later pass should measure them with rendered
geometry rather than source inspection.

---

## 7. Verification

```
test-a11y-baseline   49 assertions, static
test-a11y-browser    13 assertions, real Chromium, en + fa
test-locale-parity   506/506 keys, exact parity
test-rtl-browser     27/27 (unchanged)
test-line-endings    54/54
test-optimizations   77/77
typecheck            clean
lint                 0 errors
```

The browser walk reports **22 of 22** focusable controls visited in each locale
before focus left the document, and fails if the walk ends before covering every
focusable control — otherwise "every control has an indicator" would be vacuous
for anything past the cap.

Locale catalogs went from 501 to **506** keys in both `en.json` and `fa.json`
(`validation.required`, `.minLength`, `.maxLength`, `.invalidFormat`, `.valid`,
`.invalidHost`, `.sshKeyRequired`, plus `common.loading`), with exact parity and
no missing or extra keys on either side.

## 8. Remaining work

TASK-47 (keyboard focus and dialog accessibility) is the natural follow-on: it
owns focus trapping, focus restoration on close, and the escape-key contract
that this baseline deliberately does not duplicate.
