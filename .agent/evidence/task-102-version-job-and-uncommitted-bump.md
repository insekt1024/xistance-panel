# TASK-102 — the version job is proven, and it would publish v1.1.3, not v1.2.0

**Status: the CI `version` job's logic is verified end to end in an isolated
clone. Doing so surfaced a release-process fact that matters more than the job
itself.**

## What was exercised

GitHub Actions cannot be run from this host. But the `version` job's steps are
plain shell, and its dry-run path commits and tags **locally** without pushing
anything. So the job was replayed verbatim in a throwaway clone
(`--no-hardlinks`, detached from the real worktree, which was never touched):

| CI step | result |
| --- | --- |
| `git config user.name/email` | `github-actions[bot] <…@users.noreply.github.com>` |
| `node scripts/version.mjs patch --commit` | 1.1.2 → **1.1.3**, `[master 949b99a] chore: release v1.1.3`, 7 files changed |
| `version=$(node scripts/version.mjs --show)` | **1.1.3** |
| `release_tag=v$(…)` | **v1.1.3** |
| `git show --stat HEAD` | the 7 version files, exactly as expected |
| `git tag --list "v1.1.3"` | **v1.1.3** |
| `npm run version:check` | **exit 0 — "All 7 version files match 1.1.3"** |

So the job's logic is sound: it bumps, commits, tags, exports the version the
downstream jobs consume, and `version:check` agrees. The dry-run gate stops
before the push, as documented.

## A correction to my own reading

My first attempt appeared to show `version.mjs` printing nothing, which would
have meant the workflow tagging a bare `v` and publishing
`xistance-panel-v-amd64.tar.gz`. That was **my shell quoting**, not the script:
running the same command with its output redirected showed `--show` returning
`1.1.2` and the bump landing cleanly. Worth recording because I nearly reported
a nonexistent defect — the same reporting-pipeline trap that produced two false
"squashed" mutations earlier in this session.

## The finding that matters

```
HEAD package.json     : 1.1.2
working tree          : 1.2.0
all 7 version files   : modified, uncommitted
dirty paths           : 230
```

**The 1.2.0 bump is uncommitted.** The release workflow bumps from whatever is
committed, so if it were dispatched today it would bump 1.1.2 → **1.1.3** and
publish `xistance-panel-v1.1.3-{amd64,arm64}.tar.gz` — not v1.2.0.

Every artifact verified in this session is named for 1.2.0 and embeds a manifest
whose `version` is 1.2.0. Those artifacts were built from the *worktree*, which
is correct. But they are not reachable by the workflow as it stands, because the
workflow derives its version from the *commit*.

This is not a bug in the workflow — it is the workflow working as designed
against a repository whose release commit does not yet exist. It becomes a
defect only if the release is attempted before the bump and the work are
committed.

## Consequence for the release gate

This adds a concrete precondition to "ready to tag":

1. the 1.2.0 version bump must be committed, and
2. the ~230 dirty paths of verified work must be committed with it, and
3. **then** the workflow would bump 1.2.0 → 1.2.1, not produce v1.2.0.

Point 3 is worth flagging explicitly. The workflow *always bumps*. Publishing
`v1.2.0` therefore requires either the committed version to be 1.1.x with the
bump producing 1.2.0 (i.e. commit 1.1.3–1.1.9, then the bump lands on 1.2.0), or
the tag to be produced outside this workflow. That is a release-process decision
for the maintainer, not something to guess at — and it is another reason the
`v1.2.0` tag must not be created automatically.

## What remains unproven

The `artifact` and `publish` jobs still have never executed on a real runner.
Their logic is now verified (TASK-101) and the version job is verified here, but
a workflow that has never run is not a verified workflow.
