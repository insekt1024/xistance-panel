# TASK-52 — Node and tunnel browser smoke

- **Status:** passed
- **Date:** 2026-09-27
- **Scope:** the node list, the add-node form, node reachability, and the tunnel
  list, driven through a real production build in real Chromium.

## What this proves, and what it does not

Proves: the `/nodes` and `/tunnels` routes render without an error boundary,
the add-node dialog opens and enforces client-side validity, a node pointing at
an unreachable host is still created, reachability is reported truthfully, the
tunnel API creates/refuses/validates correctly, and the tunnels table reflects
the server.

Does **not** prove: that a real remote node can be reached, that a real tunnel
carries traffic, or that any of the nine methods works end to end. Those remain
recorded as `realBinary: false` / `releaseComplete: false` in
`.agent/evidence/tunnel-matrix.md`.

## Result

```
--- 24 passed, 0 failed ---
```

## Four real defects found and fixed

### 1. `/nodes` was completely unusable — the whole page threw

`FormSelect` had been rewritten to render a *native* `<select>`, but four call
sites in `nodes-view.tsx` pass Radix `<SelectItem>` children. Radix's `SelectItem`
requires a `Select` ancestor and throws otherwise, so **every load of
`/en/nodes` hit the route error boundary**:

```
Xistance Dashboard Tunnels Nodes ... Something went wrong
An unexpected error occurred while loading the dashboard.
```

Detecting the child shape by element *name* is not safe: `ui/select.tsx` sets
`SelectItem.displayName = SelectPrimitive.Item.displayName`, and minification
rewrites function names — so a name check silently took the native branch every
time. Fixed with an explicit symbol marker (`RADIX_SELECT_CHILD`) applied in
`ui/select.tsx` and read by `FormSelect`, which now composes a real
`Select` / `SelectTrigger` / `SelectValue` / `SelectContent` when it sees one.

**Evidence:** the M1 mutant reproduces the exact shipped failure —

```
FAIL the add-node dialog opens
     PAGE: console: Error: `SelectItem` must be used within `Select`
```

### 2. Every form control in the app lost its accessible wiring

`FormInput` and `FormSelect` called `useFieldIds()` during their **own** render,
but the context provider lives in `FormField`, which is their *parent*. A
component cannot read context from its own parent subtree during its own render,
so `useFieldIds` always saw `null`, returned `{}`, and every input shipped with:

- no `id`
- no `aria-invalid`
- no `aria-describedby`

Measured in the browser before the fix:

```json
[{"id":"","val":"smoke-node","invalid":null,"desc":null}, ...]
```

`id: ""` on every field. This silently fails WCAG 1.3.1 and 3.3.1 across the
whole application, not just this route. Fixed by making `FormField` a render prop
that hands the generated ids to the control, which is the only way a child can
attach them to the element it actually renders.

**Evidence:** the M2 mutant fails the suite —

```
FAIL a malformed host is refused with an accessible message
--- 23 passed, 1 failed ---
```

After the fix, the same field reports:

```json
{"id":"_r_c_","val":"bad host name","invalid":"true","desc":"_r_c_-error"}
```

### 3. The required SSH-key textarea had no accessible name

Both the create and edit dialogs rendered `<label>SSH key*</label>` with no
`htmlFor` and a sibling `<textarea>`. WCAG 1.3.1 / 3.3.2 / 4.1.2 all fail
without programmatic association. The same defect existed on the password
`<input>` in both dialogs. All four now have `htmlFor` + `id`, plus
`aria-required`, `aria-invalid` and `aria-describedby` pointing at the error
paragraph (`role="alert"`).

An audit of every `<label>` in the app found exactly these four; there are no
others.

**Evidence:** the M3 mutant cannot even address the control —

```
Error: no control for label "SSH key"
```

### 4. The wizard and node form had no stable test handle

`DialogContent` now carries `data-testid="node-create-dialog"` so the suite
addresses the dialog by identity instead of by translated title. A title-based
lookup broke the moment the copy changed and the test then reported "the form is
empty" while talking to a page with no form on it.

## Two assertions that were wrong about the product

Recorded because they cost real time and the correction matters.

**A `PORT_FORWARD` tunnel against a local node legitimately deploys.** The
original assertion demanded `state != "running"` for an unreachable destination.
But `planPortForward` spawns a real *local* forwarder process, so the deploy
succeeds and the tunnel really is running; the unreachable remote destination is
a runtime condition, not a deploy failure. The honest invariant is narrower: the
stored row must agree with the engine, and no row may claim `running` while
carrying a deploy error. Both are now asserted and both pass.

**`useFieldValidation` requires `touched`.** `valid = touched && !error &&
value.trim().length > 0`, and `touched` is set only by an `onBlur` handler. A
fill without a real focus change leaves every field untouched, so the submit
button stays disabled with every field holding a correct value. The suite now
focuses and presses Tab, which is what a user does and what runs React's
synthetic `onBlur`. This was the single longest-running harness bug: a
programmatic `el.blur()` does not reliably fire it.

## Harness defects fixed along the way

Each of these made the suite assert against a page it had never actually filled:

| Defect | Consequence |
| --- | --- |
| `label:has-text("Name")` matches substrings | "Name" also hit "SSH user"; real fields stayed empty |
| `input[name="host"]` | the inputs are controlled components with no `name` attribute — matched nothing, timed out at 30 s |
| `common.create` for the confirm button | the key is `common.save`; the lookup returned `""` and every click waited for a button that could never appear |
| two "Add node" buttons | bare `has-text` hits Playwright strict mode and resolves to neither |
| no `X-CSRF-Token` on writes | every write got a blanket `403 {"error":"CSRF token mismatch"}`, indistinguishable from a real authorization failure |
| invented tunnel payload | `{listenPort, targetHost, targetPort}` was rejected `422 config.portForwards: Required`, reading like an API outage |

The fill helper now throws when it cannot find its control, and asserts the value
round-tripped, so a silent miss can never be reported as a product failure again.

## Mutation results

```
M1-formselect-ignores-radix   KILLED   SelectItem must be used within Select
M2-field-ids-context-only     KILLED   23 passed, 1 failed
M3-key-textarea-unlabelled    KILLED   no control for label "SSH key"
=== 3/3 mutants killed, 0 invalid ===
```

One earlier attempt at M1 was **discarded as invalid**: forcing `radixChildren =
false` left the `RADIX_SELECT_CHILD` import unused, so the build failed with
`TS6133` for a reason unrelated to the defect. A compile-only failure is not
evidence. The final M1 keeps the symbol reference so it compiles and the failure
is behavioural.

## Full gate

```
test-smoke-nodes-tunnels   24/24   exit 0
mutate-smoke-nodes-tunnels 3/3 killed, 0 invalid
test-smoke-auth            35/35
test-state-a11y            50/50
test-a11y-baseline         58/58
test-rtl-browser           33/33
test-dialog-keyboard       34/34
test-locale-parity         15/15
line endings               54/54
version:check               7/7
typecheck                   0 errors
lint                        0 errors, 28 pre-existing warnings
build                       exit 0
```

## Files changed

- `apps/web/src/components/ui/form-field.tsx` — render-prop ids, dual
  native/Radix select support
- `apps/web/src/components/ui/select.tsx` — `RADIX_SELECT_CHILD` marker
- `apps/web/app/[locale]/(app)/nodes/nodes-view.tsx` — programmatic labels,
  `data-testid`
- `scripts/lib/browser-harness.ts` — shared harness extracted from
  `test-smoke-auth.ts`
- `scripts/test-smoke-nodes-tunnels.ts` — the suite
- `scripts/mutate-smoke-nodes-tunnels.ts` — the mutation harness
- `scripts/diagnose-node-page.ts` — Server Component exception probe
- `scripts/test-a11y-baseline.ts` — guard widened to the render-prop shape

## Not claimed

- No real remote node was contacted; `127.0.0.1:1` stands in for "unreachable".
- No tunnel carried traffic. A local forwarder process was started and is a real
  process, but no bytes crossed it.
- `TASK-36` is still listed as a declared dependency of `TASK-52` in
  `.agent/tasks.json` and is not passed; see the task graph note.
