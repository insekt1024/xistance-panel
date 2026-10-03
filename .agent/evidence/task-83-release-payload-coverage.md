# TASK-83 — the shipped artifact had never been browser-tested

**Status: closed. The real release payload now has asset/localization coverage,
proven non-vacuous.** Found while refreshing browser evidence after the arm64
round.

## The gap

`test-artifact-assets.ts` is the only suite in `run-browser-gate.ts` tagged
`runtime: "artifact"`. Its tree selection is:

```ts
const candidates = [
  path.join(REPO, "dist", "artifact-local"),
  path.join(REPO, "dist", "artifact"),
  path.join(REPO, "apps", "web", ".next", "standalone"),
];
```

`dist/artifact-local` comes first, so it wins — and the gate log said so:

```
artifact under test: dist\artifact-local
```

| tree | staged | files |
| --- | --- | --- |
| `dist/artifact-local` | 01:50 | 2,113 |
| `dist/artifact` (the one that ships) | 18:22 | 1,988 |

**The tree under test was staged before the foreign-binary pruning fix and
differs from the shipped tree by ~125 files.** The suite had been reporting
green against a fixture while the actual release payload went untested. The
`artifactCovered: true` in the gate verdict was true only in the weak sense that
*some* artifact tree was exercised.

## Why it could not simply be pointed at `dist/artifact` on Windows

```
$ XT_ASSET_ARTIFACT=.../dist/artifact npx tsx scripts/test-artifact-assets.ts
This host (win32/x64) needs query_engine-windows.dll.node, but the staged tree
ships only: libquery_engine-debian-openssl-3.0.x.so.node,
libquery_engine-linux-musl-openssl-3.0.x.so.node.
```

That refusal is correct and must not be worked around — the artifact is
single-architecture by design. It does mean the real payload can only be
exercised on x64 Linux.

## WSL Ubuntu is that platform

The aggregate already runs Linux suites under WSL, so this is an established
path rather than new infrastructure:

```
os    : Ubuntu 26.04 LTS
arch  : x86_64
node  : v22.22.1
glibc : 2.43
dist/artifact reachable via /mnt/e: yes (1,988 files)
```

Two things had to be worked around, both recorded here because they will recur:

**`tsx` cannot run under WSL.** The repository's `node_modules` was installed on
Windows, so `node_modules/esbuild` is a Windows binary and fails to exec. Fix:
compile on Windows, run the JS under WSL's Node. Emit **CommonJS** — the package
`type` is `commonjs`, and an ESM emit leaves extensionless imports
(`./lib/browser-harness`) unresolvable.

**`os.tmpdir()` returned a Windows path.** Node on WSL inherits `TEMP` from
Windows, producing `C:\Windows\Temp/...` and `ENOENT`. Fix: export
`TMPDIR`, `TEMP` and `TMP` at a Linux path.

## Result on the real payload

```
=== artifact static assets and localization (TASK-55) ===
artifact under test: dist/artifact
--- 23 passed, 0 failed ---
```

Covering, on the actual release tree: authenticated HTML in both locales, 19
(en) and 20 (fa) referenced assets all served 200, content types correct, no
source maps or dev-only paths, locale-prefixed navigation, distinct en/fa
documents, Persian script rendering, a clean server log (no disposable password
echoed), and clean shutdown with the port re-bindable.

The stale fixture also passes 23/23, so this is not a case of the new tree being
held to a different standard — both trees satisfy the same contract.

## Non-vacuity

A green suite proves nothing unless it can go red. Deleting 14 static chunks from
a copy of the real payload:

```
  removed 14 static chunks
  FAIL /en: every asset the authenticated page references is served
  FAIL /fa: every asset the authenticated page references is served
  FAIL the Persian route's assets all load
  --- 20 passed, 3 failed ---
```

It fails, names the missing assets, and names them per locale. The 20 remaining
passes are unaffected assertions, which is what a real defect looks like.

Scratch trees (`tmp-broken`, the CommonJS emit) were removed afterwards; the
repository has no stray build output.

## Turned into a permanent gate

`scripts/test-release-payload-linux.sh` (registered in the aggregate's
`LINUX_SUITES`) now runs this coverage every time. Its design decisions:

- **Platform gate first, probed not assumed.** On Windows it exits **77**, which
  the aggregate records as a skip — never as a pass:

  ```
  SKIP: needs Linux x86_64 (this is MSYS_NT-10.0-26200/x86_64).
        The payload is single-architecture; testing it elsewhere tests nothing.
  exit=77
  ```

- **Refuses a non-payload.** An empty directory is rejected, not reported green:
  `FAIL: .agent/tmp-empty is not a staged release payload (no apps/web/server.js).`

- **It does not bypass the architecture guard.** If the payload ships an engine
  the host cannot load, the underlying suite exits 77 and this propagates it as a
  skip.

### Verification of the gate itself

| scenario | expected | actual |
| --- | --- | --- |
| run on Windows | skip, exit 77 | `exit=77`, reason printed |
| run on WSL Linux against `dist/artifact` | 23 passed | `23 passed, 0 failed` |
| payload with 14 static chunks deleted | fail | `20 passed, 3 failed`, naming `/en` and `/fa` assets |
| empty directory | fail | `FAIL: ... is not a staged release payload` |

A gate that cannot go red is not a gate. Both negative paths were exercised
before it was registered.

All scratch trees (`tmp-bad`, `tmp-empty`) were removed; the repository has no
stray build output.

## Lesson

A preference-ordered fixture list is a silent-drift hazard. `dist/artifact-local`
exists for a good reason — a Windows host cannot boot the Linux engine — but
preferring it over `dist/artifact` means the gate silently tests the wrong tree
forever, and `artifactCovered: true` hides it.

The honest fix is not to reorder the list (the fixture genuinely is the only thing
that boots locally). It is to make the shipped tree's coverage a **separate,
explicitly-run** check on a Linux platform, so the two cannot be confused.

No credentials, tokens, private keys, or connection details appear in this file;
the suite's admin password is a fixed disposable constant defined in the test.