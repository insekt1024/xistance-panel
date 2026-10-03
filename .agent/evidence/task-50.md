# TASK-50 — Accessible loading, empty and error states

**Status:** passed
**Date:** 2026-09-27

The acceptance criteria ask for five states (loading, empty, error, plus
localization and no-color signalling) across eight routes, perceivable
"without relying on color or transient spinners alone". Two of those are
*runtime transitions*, so the contract is proved in a real Chromium against a
real production build, in English and Persian.

---

## 1. Suites

| Suite | Count | What it proves |
|---|---|---|
| `scripts/test-state-a11y.ts` | **50** | The rendered contract, per route, per locale |
| `scripts/test-a11y-baseline.ts` | **58** | Static guards (6 new), including the ones below |

Per empty state, per locale, the browser suite asserts:

1. it is **localized** (Persian must not fall back to English, and vice versa);
2. it is **announced politely** — `role="status"` **and** `aria-live="polite"`, not
   merely *some* role;
3. it **explains what is missing**, in words;
4. it **offers a next action** as a real, named, focusable control;
5. it **leaks no internals** (paths, SQL, stack frames, Prisma error names).

Plus, per locale: the loading state is `role=status` + `aria-live=polite` +
`aria-busy=true` with localized text, and an error response body carries no
internals.

---

## 2. Six real defects

Every list route had grown its own empty markup: a dashed border with a single
sentence in it. No `role`, no live region, no action. Measured, in a browser:

```
FAIL en: nodes empty state is announced to assistive tech
     the empty state has neither role=status nor aria-live; it is text in a box
FAIL en: nodes empty state offers a next action
     no button or link in the empty state
```

A sentence telling you there are no nodes is not a way to add one. Fixed with
`apps/web/src/components/state-block.tsx`, a single component that owns the
contract, and wired into all six list views:

| Route | Empty-state action offered |
|---|---|
| `nodes` | "Add node" — opens the create dialog |
| `tunnels` | "New tunnel" — links to the wizard |
| `port-forward` | "Add rule" — opens the create dialog |
| `users/activity` | "Clear filters" — the only meaningful action when a filter emptied the list |
| `audit` | "Previous page" |
| `users` | (not reachable empty — see §4) |

### 2.1 The loading state was unreachable in the two client-fetched lists

`audit-view` and `user-activity-view` are the only lists that fetch on the
client, so they are the only ones that have a loading branch. The fix put it in
the wrong place:

```tsx
{logs.length === 0 && !loading ? (
  <StateBlock kind="empty" ... />
) : (
  <div>
    {loading ? <StateBlock kind="loading" ... /> : null}   {/* buried */}
```

A loading block **inside** the empty-or-table ternary cannot render exactly when
it matters — the moment a fetch is in flight *and* the result is empty, the
empty branch owns the region. This was introduced while fixing the first defect
and was invisible to every check until the loading state was actually observed
in a browser. Both blocks are now hoisted above the ternary, and there is a
static guard that fails if one is ever buried again.

### 2.2 The audit list's loading announcement lived inside a `<td>`

It was a `<TableCell colSpan={5}>{tCommon("loading")}</TableCell>`. A live
region inserted and removed with its row is never announced — assistive tech
sees a table that gains and loses a row. The row is now `aria-hidden` (it stays
for geometry) and the list-level `StateBlock` carries the announcement.

### 2.3 The a11y static guard found a **sixth** route nobody had audited

`users/activity/user-activity-view.tsx` still had the original dashed `Card`.
It was not in the five routes the task named, and no existing suite covered it.

---

## 3. A test defect that hid a production defect

The RTL browser suite regressed from 27 to 25 after I converted two
`text-right` utilities to the logical `text-end`. The failure:

```
FAIL en/nodes: the actions column aligns to the left (start) edge
     computed text-align: end (this is the defect TASK-49 fixed)
```

The test was wrong. It read `td:last-child` — the **actions** column, which is
the *end* edge in every locale — and then demanded the **start** edge from it.
It also expected `left`/`right`, but once logical properties are in use the
computed value is never `left`/`right`; it is `start`/`end`.

So the old check was not merely wrong, it was **unable to detect the very defect
it claimed to detect**. Fixed by measuring both edges and, crucially, by adding
a **geometry** check: where does the text *physically* sit inside its cell?

```
ok  en/nodes: the first column's text physically sits at the left edge
ok  fa/nodes: the first column's text physically sits at the right edge
```

Same computed value (`start`), opposite physical edge. That is what a logical
property buys, and a physical `text-right` cannot reproduce it. The mutation run
confirms the check is load-bearing — and reproduces the original asymmetry:

```
mutant: physical text-right on the first cell (the original TASK-49 defect)
  30 passed, 3 failed
  FAIL en/nodes: the first column's text physically sits at the left edge
  FAIL fa/nodes: the first column aligns to the start (start) edge
```

`fa` **passed** the geometry check with the bug installed, because `right` *is*
the start edge in Persian. The defect was only ever visible in English — which
is exactly how it shipped: the primary UI is English, and the Persian one merely
looked odd.

---

## 4. Where a fixture cannot reach an empty state, the test says so

`create-admin.mjs` writes one `User`, and every sign-in writes an `AuditLog` row.
So `/users` and `/audit` are **never** empty in this harness, and asserting an
empty state there would assert a state no operator can reach. Those two assert
their populated table instead, and the suite states why.

`/users/activity` *is* reachable, so its empty state is driven **for real**: the
seed adds a second audit action with a NULL actor, then the harness drives the
real Radix Selects and the real Apply button, and the browser's own request log
confirms the filter actually applied:

```
[req] /api/users/activity?userId=03274719-…&action=node.create
```

---

## 5. Harness defects that produced confident, wrong readings

| Symptom | Cause |
|---|---|
| "empty state is not present" on users/audit | the fixture was never empty; the routes were never annotated as reachable-empty |
| **all six routes silently skipped** after a "fix" | I added a `reachableEmpty` field to the usage but not to the **type**, so it was `undefined` and `!undefined` sent every route down the vacuous branch. 18 green ticks proving nothing |
| "the action filter did not apply" | `element.click()` on a Radix Select does not move focus into the list, so `ArrowDown` went nowhere. The request log proved it: `?userId=…` with no `action=` |
| "the loading state never renders" | the `Apply` button is `disabled={loading}`, so a synthetic click after the filter step was a no-op. It needed a real mouse click |
| "the loading branch is unobservable" | the `page.evaluate` fallbacks (`[aria-busy='true']`, `[role='status']`) matched the **connection-status badge** ("Checking connection…"), so the check reported the connection indicator's politeness while claiming to test loading |
| `ERR_SQLITE_ERROR 1555` | a leftover database from a previous run; the seed needed `INSERT OR IGNORE` and a per-run database path |
| `Route is already handled!` | `unroute()` landing while a held route handler was still sleeping — the `continue()` threw outside any `try` and killed the process |

Two of these had to be fixed by **inspecting the real network requests** rather
than the DOM: a control that looks correct can still not have sent the query
that filters the list.

---

## 6. Mutation testing — 9/9

| Mutant | Change | Killed by |
|---|---|---|
| M1 | `aria-live` removed from `StateBlock` | static |
| M2 | `error` mapped to `status`/`polite` | static |
| M3 | `action` prop removed from a view | static |
| B1 | `action` prop removed, browser suite | browser — `nodes empty state offers a next action` |
| B5 | `description` removed | **survived, by design** — a description is a progressive enhancement, not part of the contract. Recorded, not counted |
| B6 | `error` → `status`/`polite` | static |
| B7 | `empty` polite → assertive | browser, after the assertion was tightened |
| B8 | `loading` status → alert | browser |
| B9 | loading block buried again | static — the new guard |

**B7 and B8 both survived the first browser run.** The check asked "is there a
role or a live region", which accepts `role=alert` — and an empty state marked
`assertive` interrupts whatever the screen reader was saying. Tightened to
require the *right* politeness per state kind.

While tightening them, a broad regex that was meant to strip debug output also
deleted the tightened assertion. The mutant then survived **again**, which is
how it was caught. A mutant that suddenly survives after the test got stricter
usually means the test got weaker.

Three mutations were discarded rather than counted, because the build failed and
`.next` was deleted — a build error is not a behavioural result:

- removing `aria-live` left an unused `live` (`TS6133`)
- hardcoding `role="status"` left an unused `role` (`TS6133`)
- `aria-live="off"` is not assignable to `"polite" | "assertive"` (`TS2322`)

That last one is worth stating plainly: **the type annotation is part of the
contract**. The compiler rejects a politeness outside the allowed set, so the
test never has to be the only thing standing between a mistake and a release.

---

## 7. What this does not claim

- **No screen reader was run.** The evidence is the accessibility tree, computed
  geometry, and keyboard behaviour.
- **2.5.8 target size, 1.4.3/1.4.11 contrast, and 1.4.10 reflow are still not
  asserted.** They need rendered geometry and computed colour at specific
  breakpoints; TASK-48 owns them.
- The **error** state is asserted at the HTTP boundary (a real 404/401 body
  carries no internals). The in-page error *rendering* — `kind="error"` — is
  guarded statically but was not driven through the browser, because no route
  currently renders one: errors surface as transient toasts.
- `/users` and `/audit` empty states are statically guarded, not browser-proven,
  for the fixture reason in §4.

---

## 8. Final state

```
test-state-a11y        50 passed, 0 failed   (en + fa, real Chromium)
test-a11y-baseline     58 passed, 0 failed   (9/9 mutants)
test-rtl-browser       33 passed, 0 failed   (was 27; the edge check was wrong)
test-dialog-keyboard   34 passed, 0 failed
test-a11y-browser      13 passed, 0 failed
test-locale-parity     15 passed, 0 failed
test-line-endings      54 passed, 0 failed
test-optimizations     77 passed, 0 failed
test-supply-chain      49 passed, 0 failed
test-secret-redaction  52 passed, 0 failed
test-auth-security     30 passed, 0 failed
test-rate-limit        30 passed, 0 failed
test-method-matrix     50 passed, 0 failed
typecheck              clean
lint                   0 errors (23 warnings)
version:check          7/7 files match
```
