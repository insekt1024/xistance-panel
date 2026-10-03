# TASK-120 — the install gate assumed three preconditions; it met none of them

**Status: fixed and mutation-proven. 30 assertions, suite green. One gate, three
independent breaks, each found a different way.**

The install gate added in TASK-119 was itself broken. Three separate times, for
three unrelated reasons, before it could install anything.

## Break 1 — the libraries were staged in the wrong directory

Found by **running** the step (extracted verbatim from the YAML and executed
against the real archive on a target):

```
Could not find release-layout.sh and service-unit.sh.   (exit 7)
```

The installer resolves its libraries from the SCRIPT's own directory first:

```bash
for candidate in "$SCRIPT_DIR/lib" "$REPO_ROOT/scripts/lib" "$SCRIPT_DIR"; do
```

I had staged them into `$WORK/scripts/lib`. `$SCRIPT_DIR` is `$WORK`, so the
first candidate was `$WORK/lib` — which did not exist. The install died before
extracting anything, with an error that says "missing library" rather than
"your staging layout is wrong".

## Break 2 — the version tag was a hardcoded literal

Found by **reading** the step I had just written:

```yaml
--version "${VERSION:-v1.2.0}"    # $VERSION is not set in this job
```

`$VERSION` is not a job-level variable here, so this would silently fall back to
a literal and install a release under the wrong name, drifting from the tag
actually being published. Now sourced from
`needs.version.outputs.release-tag`.

## Break 3 — the install was not running as root

Found by **reading the installer's precondition**:

```bash
if [[ "$(id -u)" -ne 0 && "$FIXTURE_MODE" != "1" ]]; then
  die "Run as root (sudo bash release-install.sh --version ${VERSION})." 4
fi
```

A GitHub-hosted `run:` step executes as the unprivileged `runner` user. So the
step would have exited **4** on both architecture legs, before touching the
archive. Fixed with `sudo bash` plus a `sudo -n true` preflight, so a runner
lacking passwordless sudo fails fast instead of hanging the release on an
interactive prompt.

## The lesson this generalises

Each break was caught by a different activity:

| break | found by |
| --- | --- |
| wrong staging directory | running the step |
| hardcoded version | reading the step |
| missing root | reading the installer |

**Running it caught one of three.** A green static review would have shipped all
three. And the two that reading found were each invisible to running-lite checks
and to the ordering assertions I had already written.

So the suite now asserts the **preconditions the step assumes**, cross-checked
against the installer's own requirements, rather than only the ordering the step
was written around:

- the installer's uid-0 guard agrees with how CI invokes it;
- a passwordless-sudo preflight exists;
- the health probe stays unprivileged (a `sudo curl` would observe a sudo side
  effect, not the service);
- **every `--flag` the step passes is one the installer actually accepts** —
  cross-checked by regex against the installer's own argument parser, because an
  unrecognized flag exits 2 on parsing before anything is extracted;
- `--version` is passed, since an unpinned install is refused.

## Mutation evidence

Each assertion was broken on purpose and each failed on its own:

| mutation | exit | assertion that caught it |
| --- | --- | --- |
| drop `sudo` | 1 | uid-0 precondition matches how CI invokes it |
| delete `sudo -n true` | 1 | preflights passwordless sudo |
| pass `--no-such-flag` | 1 | every flag is one the installer accepts |

An earlier mutation (reintroducing break 1's staging layout) also turns the
suite red, so all four breaks are pinned.

## A tooling note worth having

`npm run typecheck` reported **0 errors** while
`test-release-installer-assets.ts` contained a syntax error that made the whole
suite exit 1 on a transform failure — `Unexpected ")" in regular expression`.
Typecheck does not transform this file, so it did not see the broken regex.

**A suite that exits 1 on a transform error is indistinguishable from a suite
with a failing assertion** unless you read the error type. Check the failure
*kind*, not just the exit code.
