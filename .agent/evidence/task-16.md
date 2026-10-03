# TASK-16 evidence — protected-route smoke test

**Status:** passed against a real staged artifact. **This task found a
release-blocking application bug** (see below).

## What it does

`scripts/test-protected-routes.ts` boots the **actual staged standalone
server** — not a fixture — against a temporary SQLite database with disposable
per-run secrets, then:

1. asserts `/api/health` returns 200 **and** reports a reachable database;
2. asserts a protected localized route redirects to login and returns no panel
   content unauthenticated;
3. requests the login page in **each** locale, following redirects;
4. parses the returned HTML for every local `<script>`, `<link>`, `<img>` and
   `<source>` reference and requests each one, failing on any non-2xx or wrong
   content type;
5. fails if the login page referenced no assets (a vacuous pass is a failure);
6. asserts the disposable password never reached the server log;
7. removes the temporary data directory and prints only sanitized summaries.

## The bug it found: the default locale loops forever

`/login` (and every unprefixed default-locale path) answered:

```
HTTP/1.1 307 Temporary Redirect
x-middleware-rewrite: http://…/en/login
location: /login
```

next-intl **rewrote** the request to `/en/login` while simultaneously telling the
browser to go back to `/login` — an infinite redirect loop. `/fa/login` returned
200, which is exactly why this was invisible: the non-default locale worked, so
manual testing on `/fa` looked fine while the default locale was completely
unusable. The panel could not be logged into in English.

**Root cause:** `localePrefix: "as-needed"` in
`apps/web/src/i18n/routing.ts` is incompatible with this app's `[locale]`
segment layout. Fixed by switching to `localePrefix: "always"`, which gives
every locale a distinct, stable URL. The middleware itself was correct and was
compiled into the build — the routing configuration was the fault.

## Verification that the test is not vacuous

| Scenario | Result |
| --- | --- |
| Real staged artifact | ✅ pass |
| Missing `.css` assets deleted from the staged tree | ❌ 2 × `404, expected 200`, exit 1 |
| Deleting an *unreferenced* file (`robots.txt`) | ✅ still pass — correct, the login page does not reference it |

The second row is the one that matters: the test fails on a real defect and is
not simply reporting everything it finds.

## Test-ownership bugs found and fixed

1. **`/chunks/` matched `.css` files.** The MIME check classified any URL
   containing `/chunks/` as JavaScript, so correct `text/css` responses were
   rejected. Now keyed on the file extension.
2. **The locale redirect was treated as a failure.** `localePrefix` changes mean
   `/en/login` legitimately 307s to `/login`; the test now follows redirects and
   only fails if the final response is not a 200 HTML document.
3. **The first "incomplete fixture" proved nothing.** Deleting `robots.txt` left
   the test passing, because nothing on the login page references it. Replaced
   with deleting the CSS the page actually loads.

## Supporting changes

- `stage-release-artifact.ts` accepts `--architecture native` so a local
  artifact can be booted and smoke-tested before it is re-staged for a release
  architecture. `native` keeps the build host's engine; `amd64`/`arm64` are
  unchanged for releases.
- The engine filter only matched `.so.node`, so a `native` staging silently
  dropped the Windows `.dll.node` and macOS `.dylib.node`. Now matches all
  three.
- `inspect-release-artifact.ts` flagged the native engine as foreign. The
  foreign-engine check is now keyed on an explicit release architecture, since
  a Windows engine is only foreign *for a Linux release* — this keeps the
  release-time guarantee while allowing local verification.

## Recorded gaps

1. **The release artifact is single-architecture by design, so this test only
   runs on a matching host.** On the wrong host it exits **77** with an explicit
   message rather than failing confusingly or passing silently. It has been run
   here on a `native` staging; **it has not been run against the Linux
   `amd64` artifact or on the VPS.**
2. **No authenticated round trip.** The test proves the protected route is
   protected, but does not log in and load the authenticated dashboard. A
   follow-up should drive the real login form and assert the authenticated
   assets.
3. **Not wired into the release workflow yet.** Nothing runs it in CI, so it
   cannot currently fail a release.
4. **`stage-release-artifact` still does not stage static assets itself**; it
   requires `stage-release-assets.ts` to have been run first. This was found
   here (the one-shot staging path produced an artifact with no CSS/JS) and is
   **not yet fixed** — the two-step requirement remains.
5. **MSYS path mangling** requires native-style paths for
   `XT_SMOKE_ARTIFACT`; on Linux this does not arise.

## Gates

Protected-route smoke green against a real staged artifact and red against a
broken one; `test-release-assets`, `test-release-artifact`,
`test-apply-migrations`, `test-create-admin` green; layout 35/35, cutover
19/19, installer 23/23, update 24/24, service-contract 24/24; `bash -n` clean;
version:check, lint, typecheck and release `tsc` clean; harness 77/77;
`npm run build` exit 0 with the Proxy registered.
