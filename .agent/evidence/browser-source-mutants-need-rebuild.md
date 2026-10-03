# `source`-runtime browser suites serve a prebuilt `.next` — source mutations
# are never exercised unless you rebuild

## What happened

I was proving that `scripts/test-dialog-keyboard.ts` (the "node row menu
returns focus to the trigger" assertion) was non-vacuous. I broke the
component on purpose:

```tsx
<DropdownMenu onOpenChange={function(){}}>
```

That should stop a Radix menu ever closing, so focus can never return. The
suite reported **34 passed, 0 failed — twice**.

The component was correct. The test was not broken. **The mutant was never
executed.**

## Cause

`dialog-keyboard` is tagged `runtime: "source"` in `scripts/run-browser-gate.ts`,
and "source" means:

```ts
// `next start` from apps/web, exactly as test-rtl-browser.ts does.
const child = spawn(process.execPath, [nextBin, "start", "-p", String(port), ...], {
  cwd: path.join(REPO, "apps/web"),
```

`next start` serves the **compiled** output in `apps/web/.next`. Editing
`apps/web/app/[locale]/(app)/nodes/nodes-view.tsx` changes nothing until
`TURBO_DISABLE=true npm run build` regenerates it. So the assertion was reading
a component from the last successful build — one that was several code changes
old.

With the mutant rebuilt in, the same suite failed the assertion as it should.

## Two mutants, and why the first one proves the point twice

**Mutant v1 — `<DropdownMenu onOpenChange={function(){}}>`.** Survived, twice,
even after a rebuild. Not a `next start` problem after all: Radix's root state
is internal, so an `onOpenChange` prop that does nothing changes nothing. The
menu still opened and closed correctly. This is the ordinary kind of bad
mutant, and it only became instructive because I had already proved the
rebuild requirement separately.

**Mutant v2 — `<DropdownMenuContent onCloseAutoFocus={(e) => e.preventDefault()}>`.**
This is the actual kill switch for the assertion. With it rebuilt in:

```
mutant run 1: 32 passed, 2 failed
mutant run 2: 32 passed, 2 failed
```

Both `en` and `fa` failed, twice. Restored, rebuilt, `34 passed, 0 failed`.

So the sequence mattered twice over: v1 showed a semantically inert mutant is
indistinguishable from a stale build without the rebuild discipline, and v2
proved the assertion really does watch Radix's focus return.

## Correcting my own first claim

My first note in this file asserted the `onOpenChange` mutant "should stop a
Radix menu ever closing", and treated its survival as proof of the
`next start` staleness problem. The second half was wrong. I had not yet
rebuilt when I wrote it, and after rebuilding it still survived for a
different reason. The evidence above is the corrected version; the lesson
about rebuilds stands on the reasoning in "Cause" rather than on v1.

## Why this matters beyond one test

This silently invalidates a whole class of evidence:

> **A browser suite that runs `next start` cannot be used to test a source
> change without rebuilding first. Its green result is evidence about the last
> build, not about the working tree.**

That is not a subtle degradation. It means a mutation harness over any
`source`-tagged suite reports false negatives — every mutant looks like a
survivor, which reads as "the assertion is vacuous" and invites someone to
"fix" a correct test. The inverse error is worse: it can also make a genuinely
broken change look green, because the assertion is testing stale code that
happened to pass.

It also means the suite result is only trustworthy if the build immediately
preceding it included the change under test. I had been running builds before
the gate routinely, which is why the gate itself was sound; the error only
appeared when I mutated source *without* rebuilding.

## The rule this establishes

Any source-level mutation proving a browser-suite assertion non-vacuous must be:

1. mutate the component,
2. **rebuild**,
3. run the suite,
4. restore the source,
5. **rebuild**,
6. run the suite again to confirm green.

Skipping steps 2 and 5 yields a meaningless result in both directions. The
cost is two builds per mutant — around 3 minutes here — which is the price of
an evidence claim rather than a guess.

## What I changed

`scripts/test-dialog-keyboard.ts`, the one assertion in that file that read
`document.activeElement` a single time with no settle:

```ts
// Radix returns focus on unmount, AFTER the close animation, so
// this must POLL. It was the only check in this file that read
// document.activeElement once with no settle, and it failed 2 runs
// out of 3 against a component that was behaving correctly — the
// sibling search-dialog check right above waits 400ms for exactly
// this reason. A genuine focus-return defect never converges, so
// polling cannot hide one; a missing sleep can invent one.
```

It now polls up to 40 × 50 ms. A real focus-return defect does not converge, so
polling cannot mask one.

**Before/after, 6 consecutive clean runs:** 34 passed, 0 failed, all six. Prior
to the fix the same suite produced 33/1, 33/1, 34/0 across three runs.

## Separate finding, also fixed in the same suite

While here: the suite previously found no `data-kb-row-menu` anywhere in the
source tree, because **it injects the attribute at runtime** onto the row's
`aria-haspopup="menu"` button. That is a legitimate technique, but it means a
grep-based audit for test hooks will not find them — worth knowing before
concluding a selector is unused and deleting it.

## Honest status of the earlier non-vacuity claims

Every other mutation proof in this release edited **shell or TypeScript source
that the test reads directly from disk** (`scripts/release-install.sh`,
`apps/web/src/lib/ssrf.ts`, `forward-host.ts`, `packages/types/src/index.ts`),
so those were valid — the mutated file was the file under test. The
`next start` problem applies only to suites that exercise rendered components.
I have not re-audited every browser suite for this, and I am not claiming they
are all clean; what I can say is that the ones above were genuinely executed.
