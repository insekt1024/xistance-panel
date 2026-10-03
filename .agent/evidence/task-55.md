# TASK-55 evidence — browser smoke suite for static assets and localization

## What it does

`scripts/test-artifact-assets.ts` boots the **Next standalone server** — the release
runtime — against a disposable database, logs in over the real HTTP endpoint, and
checks what the artifact actually serves.

It deliberately does **not** use `startApp` from `scripts/lib/browser-harness.ts`.
That helper runs `next start` from the source tree on purpose, which is correct for
behavioural tests but answers the wrong question here: the source tree contains
`.next/static` and `public/`, the standalone output contains neither, and a
`next start` server would report a clean bill of health for a release that 404s
every stylesheet on the target host. `scripts/lib/staged-app.ts` runs
`apps/web/.next/standalone/apps/web/server.js` and nothing else.

`scripts/lib/asset-refs.ts` holds the shared `collectAssetReferences`,
`forbiddenReason` and `mimeOk` helpers, so this suite and
`scripts/test-protected-routes.ts` cannot drift apart on what counts as an asset.

## The two production bugs it found

**1. `stageReleaseArtifact` was not self-sufficient.** It imported
`stageReleaseAssets` but never called it, so staging failed with
`standalone static chunks is missing` — a message that reads like a broken build
rather than a forgotten step. This was a gap already recorded in TASK-16's own
evidence. Fixed: the call is now made inside `stageReleaseArtifact`, conditional
on a real `apps/web/.next/static/chunks` existing so that synthetic fixtures keep
asserting the copy step rather than a Next build.

**2. The language switcher marked the wrong locale.**
`apps/web/src/components/language-switcher.tsx` compared against
`routing.defaultLocale` instead of the active locale, so an English user saw the
tick on English (correct) and a Persian user **also** saw the tick on English —
the menu never indicated which language was being read. Fixed to use `useLocale()`.

## Two test bugs found while building it

**A substring match reported a false pass.** The first locale-switch check was
`/href="\/fa/.test(body)`, which returned true — but no component emits that link.
The switcher is a Radix dropdown, so its links do not exist in server HTML at all.
The real href set, printed on failure, is `en links: /en /en/tunnels /en/nodes …`
and `fa links: /fa /fa/tunnels /fa/nodes …` — every link stays inside its own
locale. The check now asserts locale-prefix integrity from SSR, and the
interactive behaviour is covered in real Chromium.

**A wrong selector would have passed the broken switcher.** The first tick
detection queried Radix `[data-state]`, which is not how the tick is rendered —
it is a lucide `<Check>` icon inside the item. That assertion found an empty list
and would have been satisfied by any switcher at all, including the broken one.
It now measures which menu item actually contains `svg.lucide-check`.

## Results

```
=== artifact static assets and localization (TASK-55) ===
artifact under test: dist\artifact-local
  ok   the standalone server authenticates a login
--- /en: authenticated route and its assets ---
  ok   /en: an authenticated localized route returns an HTML document
  ok   /en: the page references assets — 19 local reference(s)
  ok   /en: every asset the authenticated page references is served — 19 assets, all 200
  ok   /en: every served asset has a suitable content type
--- /fa: authenticated route and its assets ---
  ok   /fa: an authenticated localized route returns an HTML document
  ok   /fa: the page references assets — 20 local reference(s)
  ok   /fa: every asset the authenticated page references is served — 20 assets, all 200
  ok   /fa: every served asset has a suitable content type
  ok   no referenced asset is a development-only path
  ok   the artifact ships no source maps or test files — no .map files under .next/static
--- locale switching ---
  ok   every navigation link keeps its locale prefix — en: 10 links, 0 escaped; fa: 10 links, 0 escaped
  ok   both locales expose the same navigation set
  ok   en and fa render different documents — en=146781 bytes fa=146282 bytes
  ok   the Persian route renders Persian — Persian script present in /fa
  ok   the Persian route's assets all load — 20 assets, all 200
--- the asset check is not vacuous ---
  ok   a missing asset is reported missing, not tolerated — expected 2 absent, saw 2 absent of 2 referenced
  ok   a development-only path is rejected by name — app.js.map -> a source map exposes the original source
  ok   the server never logged the disposable password — clean

--- 19 passed, 0 failed ---
rc=0
```

## Acceptance criteria

| AC | Proved by | Result |
|---|---|---|
| 1. Localized protected route returns expected HTML; all referenced local assets 200 with suitable content types | `/en` and `/fa` authenticated round trip, per-asset GET, `mimeOk` on the served `content-type` | 4 checks per locale, all pass |
| 2. No required asset from a development-only path or missing from the artifact | `forbiddenReason` on every reference; a recursive scan of `.next/static` for `.map` files | pass |
| 3. Locale switching and translated route assets work in en/fa | locale-prefix integrity in SSR, differing documents, Persian script in `/fa`, all `/fa` assets loading, plus the browser interaction test below | pass |
| 4. The suite fails when public/static assets are removed | negative test below | pass |

## AC4 — the suite is not vacuous

A throwaway copy of the artifact was staged with the contents of `apps/web/public`
and `apps/web/.next/static` emptied (files deleted, directory shape kept valid, so
the only difference is that the referenced assets are gone), and the suite was
pointed at it:

```
emptied 10 top-level entries under public/ and .next/static
suite exit code: 1
suite summary:   16 passed, 3 failed
  FAIL /en: every asset the authenticated page references is served
  FAIL /fa: every asset the authenticated page references is served
  FAIL the Persian route's assets all load
```

Production is `19 passed, 0 failed`; with assets removed it is `16 passed,
3 failed`, naming the asset checks specifically. A suite that still passed here
would have proved nothing about assets.

## The language-switcher fix is verified in both directions

Isolated mutant, reintroducing `locale === routing.defaultLocale` (kept compiling
with `void active` — a build failure is not behavioural evidence):

```
  ok   the switcher offers the other locale — menu hrefs: /en /fa
  ok   the switcher marks the locale being read — ticked: ["English"]
  ok   the switcher navigates to the other locale — landed on /fa
  FAIL the tick follows the active locale
  FAIL the tick follows the active locale — ticked: ["English"] (menu: 2 links)
--- 79 passed, 1 failed ---
```

Production restored:

```
  ok   the switcher marks the locale being read — ticked: ["English"]
  ok   the switcher navigates to the other locale — landed on /fa
  ok   the tick follows the active locale — ticked: ["فارسی"] (menu: 2 links)
--- 80 passed, 0 failed ---
```

`test-smoke-routes.ts` grew from 78 to 80 checks.

## Running it

```bash
# stage a local fixture (see the platform note), then:
npx tsx scripts/test-artifact-assets.ts
```

`scripts/stage-local-test-artifact.ts` stages `dist/artifact-local`: the same
build, the same `stageReleaseArtifact` call with `architecture: "amd64"`, and then
the host's own Prisma engine copied in **after** the release filter ran.

## Recorded gaps

**`dist/artifact` cannot run on this Windows host.** The release artifact ships
only `libquery_engine-debian-openssl-3.0.x.so.node` and
`libquery_engine-linux-musl-openssl-3.0.x.so.node` — correct single-architecture
behaviour. `ReleaseArchitecture` is `"amd64" | "arm64"`, and
`inspectReleaseArtifact` treats a Windows engine in a payload as a defect, so
there is no option that would stage one. With no host engine the suite exits **77**
with that explanation rather than passing. `dist/artifact` itself is untouched by
the fixture and still ships the single-architecture amd64 payload.

Consequently **the results above come from `dist/artifact-local`**, which is
byte-identical to the release payload apart from one extra `.node` file. Assets,
content types, locale routing and HTML are therefore real results. What remains
Linux-specific — the engine actually loading on Ubuntu, and any POSIX permission
or file-mode behaviour — still needs the VPS run.

**No browser in this suite.** TASK-55's asset checks are HTTP and content-type
only. The interactive locale-switcher coverage is in `test-smoke-routes.ts`, which
drives real Chromium against `next start`; the switcher renders client-side and is
identical in both runtimes, but the two suites are not the same runtime and are
not claimed to be.

## Gates

| Gate | Result |
|---|---|
| `npm run version:check` | ✓ All 7 version files match 1.1.2 |
| `npm run lint` | 0 errors, 24 warnings — all in pre-existing files, none in the files touched here |
| `npm run typecheck` | 0 errors |
| `TURBO_DISABLE=true npm run build` | ✓ Compiled successfully |
| `npx tsx scripts/test-artifact-assets.ts` | 19 passed, 0 failed |
| `npx tsx scripts/test-smoke-routes.ts` | 80 passed, 0 failed (was 78) |
| `npx tsx scripts/test-smoke-tunnel-diagnostics.ts` | 69 passed, 0 failed (unchanged) |
| `npx tsx scripts/test-rtl-browser.ts` | 33 passed, 0 failed |
| `npx tsx scripts/test-smoke-auth.ts` | 35 passed, 0 failed |
| `npx tsx scripts/test-smoke-fa.ts` | 105 passed, 0 failed |
| `npx tsx scripts/test-a11y-browser.ts` | 13 passed, 0 failed |
| `npx tsx scripts/test-release-artifact.ts` | pass (fixture suite, after the staging change) |
| AC4 negative test | exit 1, `16 passed, 3 failed`, asset checks named |

## Files

- `scripts/lib/asset-refs.ts` — shared `collectAssetReferences`, `forbiddenReason`, `mimeOk`
- `scripts/lib/staged-app.ts` — standalone-server boot, engine guard, redirect-following fetch
- `scripts/test-artifact-assets.ts` — the suite
- `scripts/stage-real-artifact.ts` — release staging in the required order, with verification
- `scripts/stage-local-test-artifact.ts` — local fixture with the host engine added post-staging
- `scripts/stage-release-artifact.ts` — now calls `stageReleaseAssets` itself
- `scripts/test-protected-routes.ts` — uses the shared helpers
- `scripts/test-smoke-routes.ts` — language-switcher interaction coverage
- `apps/web/src/components/language-switcher.tsx` — marks the active locale
