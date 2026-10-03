# TASK-121 — the staleness gate itself was wrong twice

**Status: fixed. The check now compares `BUILD_ID` content, not mtime. Three
distinct defects found in one small check.**

Added in TASK-118, the check reported the arm64 artifact as stale. That conclusion
was right, but the implementation was wrong in three ways, and one of them made it
report a FALSE finding on a current artifact.

## Defect 1 — mtime cannot distinguish "edited" from "touched"

The check compared the artifact's mtime against the newest file under `apps/web`.
mtime answers *"could this tree have carried the change?"* and says yes after a
bare `touch`, a `git checkout`, or any editor that rewrites identical bytes.

I hit this against myself: while mutation-testing I ran `touch` on
`dashboard-stats.tsx`, and the gate immediately began naming **amd64** as stale —
an artifact that was current. A gate that cries wolf gets ignored, and this one
would have cried wolf on every ordinary edit.

mtime cannot answer *"did it?"*. Only content can. The check now compares the
archived `apps/web/.next/BUILD_ID` against the one on disk — regenerated on every
build, so a differing id proves a different build of the app:

```
arm64: built from a different build (e8DG6UyhN3KW_U_Qhkplq)
       than the one on disk (mCl4Nt8S0HKuyq0GvghxD)
```

Verified it discriminates: after `touch`, amd64 is **not** named. Before the fix it
was.

## Defect 2 — `--wildcards` is a GNU-tar extension

The natural way to read one member is:

```bash
tar -xzOf archive.tar.gz --wildcards '*apps/web/.next/BUILD_ID'
```

But `--wildcards` is not portable. bsdtar — which backs `tar` on Windows and
macOS — rejects it:

```
tar: Option --wildcards is not supported          (exit 1)
```

So the read returned nothing and the gate reported **"the archive carries no
BUILD_ID"** for *both* architectures — a fabricated packaging bug. Replaced with
`tar -tf` to list, find the member, then extract exactly it. Both forms are
portable and listing does not decompress 40 MB of payload.

## Defect 3 — GNU tar reads `E:\path` as a REMOTE HOST

The real cause of the same false finding, and it survived the portability fix:

```
tar: Cannot connect to E: resolve failed          (exit 128)
```

`tar` on PATH here is **GNU tar 1.35**, even on Windows, and Node's `spawn` hands
it the backslashed path verbatim. GNU tar's `[host:]path` syntax parses `E` as a
**hostname**. Fixed with `--force-local`; bsdtar ignores the flag, so it stays
portable.

This one is worth remembering generally: **a shell here can make an argument look
like it worked when the same argument fails from `execFileSync`.** My first probe
ran through the shell and appeared to succeed; the identical call from Node
returned null. Only instrumenting the actual function settled it — three rounds of
"it should work" reasoning were all wrong, and each time the answer was in the
child process's stderr, not in the code.

## A splice bug of my own, for the record

Editing this file by string-splice truncated a neighbouring declaration:

```
_FILES = ["scripts/lib/release-layout.sh", ...]     # 'const LIB' eaten
```

That block then ran against an undeclared global. It happened to be tolerated
(strict mode would not have), which is exactly the class of damage that survives a
green test run. `tsc` reported 0 errors because it does not see the runtime global.

## What the check asserts now

| assertion | meaning |
| --- | --- |
| every built artifact came from the current build | no stale architecture ships |
| every built artifact carries a provable build identity | no unverifiable artifact ships |

The second exists because "could not read it" must never be reported as "fine" —
an archive with no build identity cannot be *shown* to be fresh, and that is a
finding, not a pass.

## Addendum — fixing it exposed three more defects in the same file

Editing by string-splice, then repairing the damage, produced problems worse than
the original:

**A duplicate block.** The BUILD_ID check was *added* while the mtime check was
still present, so both ran. The mtime one then called a helper I had deleted:

```
ReferenceError: newestMtime is not defined
```

That crashed the suite at exit 1 — which the aggregate correctly reported as a
**failing** suite (72/73). The crash was the good outcome: a silently-skipped
staleness check would have looked green.

**A negative failure count.** The tally printed:

```
--- 3 passed, -1 failed, 0 skipped, 5 readiness finding(s) ---
```

`readinessFindings += stale.length + unknown.length` counted one increment per
*architecture* while `check()` records one failure per *assertion*. With 2
architectures the findings outnumbered the failures and
`fail - readinessFindings` went negative — a number that reads as worse than any
real result, while masking every actual failure. Also fixed a duplicated
`readinessFindings += 1` on the same untracked-library condition.

**Three expressions of one value.** `BLOCKING` was already computed, but the
summary line and the exit code each re-evaluated `fail - readinessFindings`. That
is exactly how "prints `-1 failed`, exits `0`" happened. Now all three read the
single clamped value, so the printed number cannot disagree with the status.

## On repairing splice damage

My repair attempts made it worse three times before a real parser settled it:

- a brace counter matched a *comment* and deleted the wrong two lines;
- another matched nothing and raised `StopIteration`;
- `tsc` reported **0 errors** throughout, because it does not see these runtime
  failures.

What actually worked, in order: read the region with line numbers instead of
reasoning about offsets; locate blocks by unique *content* rather than by
indentation; and run `npx esbuild <file>` as the parser. **A brace counter is not
a parser** — template-literal `${}` makes it lie in both directions.
