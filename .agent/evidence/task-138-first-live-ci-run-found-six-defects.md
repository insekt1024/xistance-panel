# TASK-138 — the first live CI runs, and six defects only CI could find

The tree had never run in GitHub Actions. Four pushes later, six real defects,
all invisible locally. Recorded because the pattern matters more than any one of
them: **every one passed on the developer's machine.**

## The runs

| run | commit | suites red |
| --- | --- | --- |
| 1 | `5c0c662` | 14 |
| 2 | `a2f1b2d` | 14 |
| 3 | `479b66e` | 10 |
| 4 | `b05c6a2` | 10 |
| 5 | `4dbdb24` | 10 |
| 6 | `59cc1fb` | **8** |

## 1. CI never cut an archive (`a2f1b2d`)

CI staged the payload tree but never archived it, so every suite reading
`dist/amd64/*.tar.gz` failed on a fresh checkout while passing locally — where a
previous run had left an archive behind. The local green was an artifact of
leftover state, and those gates had never actually executed in CI.

## 2. The manifest hashed the wrong tree (`479b66e`)

`artifact.sha256` must describe the tree the **archive** extracts to, because
that is what `test-embedded-manifest-provenance` recomputes. CI passed
`apps/web/.next/standalone`; the release workflow passed `dist/artifact`. So the
digest CI recorded could never describe the archive CI shipped. CI also built
the manifest *before* staging. The release workflow was already correct, which
is exactly why local runs passed.

## 3. The archive contained no manifest (`4dbdb24`)

CI wrote `release-manifest.json` to the repo root, then archived with
`tar -C dist/artifact`. The archive shipped with no manifest at all — so the
gate that exists to prove the published archive's embedded digest describes its
own contents was inspecting an archive with nothing embedded.

## 4. `env:` is not a shell (`b05c6a2`)

```yaml
env:
  VERSION: $(node -p "require('./package.json').version")
```

An env value is a literal string. The step received the text
`$(node -p ...)` and the manifest rejected it as a non-semantic version. The
archive step had the same defect and would have written a file literally named
`xistance-panel-v$(node ...)`. Both now compute in the run block, and the
archive takes its name from the staged manifest so the name the suites resolve
and the file on disk come from one source.

## 5. A hardcoded absolute Windows path (`479b66e`)

`test-direct.ts` read its subject through
`E:/codes/Projects/Xistance-Tunnel/xistance-panel/packages/tunnel-core/src/runner.ts`.
It passed on this machine and would have failed for every other contributor and
in CI. Now repo-relative.

## 6. The harness inherited a gitignored file (`59cc1fb`)

`getJwtSecret()` **throws** when `NODE_ENV=production` and `JWT_SECRET` is unset,
so every `/api/auth/login` answered 500 — `login failed: HTTP 500` across six
suites.

It stayed hidden for the opposite reason to the others: the harness forces
`NODE_ENV=production`, but `next start` also loads `apps/web/.env.local`, which
exists on the developer's machine and is correctly gitignored. The suites passed
locally **because of an untracked file** and failed in CI because it was absent.
Proven by moving `.env.local` aside: login returns 200 once the harness supplies
the secret.

Also fixed in the same commit: `findChromium()` hardcoded
`AppData/Local/ms-playwright` and so always returned `null` off Windows, even
though the lines below it already branched on darwin/linux.

## What is still red, and why it is not a code defect

8 suites, two causes, both missing **CI infrastructure**:

- **`xtinst`/`xt24` do not exist on a runner.** Docker *is* available there, so
  `test-rollback-drill` and `test-target-runs-shipped-payload` get past their
  own `dockerAvailable()` probe and then find no containers. These are local
  development infrastructure this machine happens to have running; nothing in
  `ci.yml` creates them.
- **No `dist/arm64` stage can exist on an x64 runner.** Prisma's query engine is
  a native binary generated on the target architecture, so
  `test-real-archive-verify` and `test-embedded-manifest-provenance` correctly
  report arm64 as absent.

### Why no skip was added

`scripts/run-all-tests.ts` states the rule:

> A suite that cannot run is a FAILURE, not a skip. Silent skips are how
> coverage gets claimed when nothing executed.

That rule exists because a suite once passed locally and was never in CI — which
is precisely how defect 1 survived. Making these two cases skippable would
reopen the same hole. Two ways to close them properly were put to the maintainer
(give `ci.yml` a target-OS job that starts the containers; or move those suites
into a separate runner mirroring the existing browser-gate precedent); the
question was cancelled, so **neither was chosen unilaterally** and the gaps are
left explicit and red rather than papered over.

## What is verified green

| gate | result |
| --- | --- | 
| `npm run version:check` | PASS |
| `npm run typecheck` | 0 errors |
| `npm run lint` | 0 errors |
| local aggregate | **76/76 suites, RESULT: PASS**, exit 0 |
| CI: lint, typecheck, version, optimize, build, stage, manifest, archive | **all success** |
| CI: dashboard-legibility | **648/648** |
| CI: health-telemetry | **29/29** (was 500-ing on every login) |

`test-protected-routes` exits 77 on this host both before and after every change
here, with its own message explaining it needs the release target's native query
engine — not a regression.
