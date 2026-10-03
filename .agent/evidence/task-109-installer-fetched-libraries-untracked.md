# TASK-109 — the installer's fetched libraries are untracked, so a verified fix would ship nothing

**Status: found and reported as a release-readiness precondition. Not a code
defect — a shipping hazard that would silently void TASK-108.**

## What I checked, and why

TASK-108's rollback fix lives in `scripts/lib/release-layout.sh`. I verified it
by deploying that file to both targets and re-running the drill. That proved the
fix *works*.

It did not prove the fix *ships*.

## The finding

`scripts/release-install.sh` obtains its two libraries like this:

```bash
LIB_URL="${GH_BASE}/${REPO_SLUG}/raw/${VERSION}/scripts/lib/release-layout.sh"
...
if [[ -n "$LIB_SRC_DIR" ]]; then
  cp -f -- "$LIB_SRC_DIR/release-layout.sh" "${WORK_DIR}/release-layout.sh"
else
  curl -fsL ... -o "${WORK_DIR}/release-layout.sh" "$LIB_URL" \
    || die "Could not obtain the release layout library for ${VERSION}." 7
fi
```

So when the libraries are **not** staged beside the installer, it **curls them
from the release tag**. And:

```
$ git ls-files --error-unmatch scripts/lib/release-layout.sh
fatal: path 'scripts/lib/release-layout.sh' exists on disk, but not in 'HEAD'
$ git ls-files --error-unmatch scripts/lib/service-unit.sh
fatal: path 'scripts/lib/service-unit.sh' exists on disk, but not in 'HEAD'
```

**Both files are untracked.** A release dispatched today would curl the
*pre-TASK-108* library from the tag, and the rollback fix — verified working on
two real targets — would not be in it. The install would succeed, the drill would
pass locally, and the published release would still contain the one-way-rollback
bug.

This is the same pre-tag class as the uncommitted version bump (TASK-102): the
workflow reads the **commit**, and here the installer reads the **tag**.

## Why it is worse than an uncommitted change

An uncommitted modification is visible in `git status` and in `git diff`, and
`git stash -u` carries it. An **untracked** file is in none of those. A release
process that checks "is the tree clean?" or "does the diff look right?" will not
see it at all.

## The gate

`scripts/test-release-version-commit-parity.ts` now checks that both libraries
are **tracked** *and* **committed**, and reports it as a readiness finding on
every aggregate run.

The first version of that check was itself vacuous: it used `git show`, which
returns null both when the file is uncommitted *and* when it is untracked, so it
printed `ok` while both files were absent from `HEAD` entirely. The fix separates
the two states with `git ls-files --error-unmatch`:

```ts
function isTracked(pathInRepo: string): boolean {
  return spawnSync("git", ["ls-files", "--error-unmatch", "--", pathInRepo], …).status === 0;
}
```

Independently confirmed:
```
tracked?  release-layout.sh -> UNTRACKED
tracked?  service-unit.sh   -> UNTRACKED
```

## What this does and does not establish

**Establishes:** the shipping hazard is visible on every run, with the two states
distinguished, and a vacuous pass is no longer possible.

**Does not establish:** that the libraries are shipped. They are not, until they
are `git add`ed and committed — which is a commit, and committing is the user's
decision, not mine.

## The lesson

**Verify that a fix is in the path the consumer takes.** I verified the rollback
fix by copying the library to the target by hand. The real installer may fetch it
from a tag instead. Both paths can be correct while only one of them carries the
fix — and the path that skips it is the one that ships.

The general form: a fix verified through a *convenient* mechanism is not verified
through the *shipping* mechanism. When a build or install step has a fallback
(fetch-from-tag, use-the-cache, resolve-from-HEAD), the fix must be present in
**every** branch of it, and the check has to name the branch.