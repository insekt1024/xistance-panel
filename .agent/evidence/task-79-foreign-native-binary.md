# TASK-79 — a Windows PE binary was shipped inside the Linux release

**Status: FIXED, pinned, and re-verified on both target OS versions.** Found by
following the one item TASK-78 left open ("Sharp's arm64 availability is
unverified") — the check that asked a different question and got a more
important answer.

## The defect

The published amd64 archive contained a native binary built for a different OS:

```
node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64-0.35.4.node
442,368 bytes, magic MZ (Windows PE)
```

Inside a tarball whose manifest declares `architecture: amd64` and whose
installers target Ubuntu 22.04.5 / 24.04.5. The artifact was staged on a
Windows build host, and the Windows `sharp` binary was carried along.

**Nothing caught it.** `FOREIGN_ENGINE_PATTERN` only ever ran against the
generated Prisma client directory. Every other native module arrives through
`node_modules`, so the check was blind to the entire rest of the payload. A
Linux release could ship any amount of foreign code and still pass inspection.

## Why it was not caught, and what it was not

Established empirically rather than assumed, because "wrong binary in the
payload" and "broken image optimization" are different problems:

- `require("sharp")` on the installed target → `Cannot find module 'sharp'`.
  The installer never stages `sharp` itself, only what Next traced.
- The standalone `server.js` contains no `sharp` reference.
- Both `next/image` call sites (`login-form.tsx`, `navbar.tsx`) render
  `/xistance-logo.svg` — an SVG, which Next serves without the sharp pipeline.
- Every file in `apps/web/public` is an SVG; there is no raster asset.
- `/xistance-logo.svg` returns 200 on both targets; `/_next/image` returns 400
  with `"url" parameter is valid but image type is not allowed` — Next's
  `dangerouslyAllowSVG` default, unrelated to a missing native module.
- Zero `sharp`/`libvips` lines in either target's journal.

So the Windows binary was **unreachable dead weight**, not a missing
dependency. That distinction matters: the product was never broken by it, but
the artifact was never validated for the platform it claims, which is exactly
the property a release gate exists to establish.

## The fix

Two changes, because a report alone would have left the artifact dirty.

**1. Staging prunes it.** `shouldCopy()` in `stage-release-artifact.ts` — the
single chokepoint every staged file passes through — now drops any foreign
native binary:

```ts
if (isForeignNativeBinary(relativePath)) return false;
```

**2. Inspection rejects it.** `isForeignNativeBinary()` is exported and applied
to the whole tree, not just the Prisma client dir, so a foreign binary that
reaches the payload another way still fails the gate.

### Deny-by-default on the platform tag

A `.dll.node`/`.dylib.node` is foreign by extension. A bare `.node` is foreign
**unless** some path segment names a Linux platform. So an unknown or newly
published platform tag (`webcontainers`, `freebsd`, anything added next year) is
treated as foreign rather than silently accepted — the safe direction for a
release gate. Metadata inside a foreign package (`package.json`, `index.cjs`) is
not flagged; only the unusable binary is.

The first two drafts of this predicate were wrong in ways the test caught, both
recorded in `test-foreign-native-bins.ts`:

- A single alternation missed `sharp-win32-x64/lib/<blob>.node`, because the
  platform tag is two segments above the file.
- A `[/\\]x[/\\]` grab took the `lib` directory instead of the platform tag, so
  every real Linux `sharp` blob looked foreign. The tell was that
  already-proven-good Linux paths were failing.

## Non-recurrence

`test-foreign-native-bins.ts` (registered in the aggregate, now 55 suites) does
not hardcode a list of bad filenames. It reads the platform matrix out of the
**installed `sharp` package's `optionalDependencies`** and asserts, per tag:

- every real non-Linux platform blob is reported foreign;
- every real Linux platform blob is not.

15 sharp platforms are covered from the package's own metadata, so a dependency
that adds or drops a platform needs no edit here. A hardcoded list would have
kept passing while a newly published platform leaked through.

The test also pins the reported case exactly, asserts a clean tree reports
nothing, asserts the Prisma Windows engine is still caught, asserts non-binary
files in a foreign package are **not** flagged, and asserts that inspection
without an explicit architecture stays silent (a local `native` staging
deliberately keeps the build host's modules).

## Re-verification after the fix

The artifact was rebuilt from scratch, in the exact workflow order — build,
stage assets, manifest, `rm -rf dist/artifact`, stage, archive, checksum,
verify — never overlapping.

| property | before | after |
| --- | --- | --- |
| archive size | 40,921,390 B | 40,720,039 B |
| sha256 | `6c2be9cd…` | `9960ec20…` |
| sidecar | 101 B, 1 line | 101 B, 1 line |
| checksum verify | PASS | PASS |
| PE / dylib files in payload | 1 | **0** |
| `.node` blobs in payload | 3 | 2 (both `libquery_engine-*.so.node`) |
| extracted archive vs `dist/artifact` | 0 differences | 0 differences |
| `inspect-release-artifact --architecture amd64` | PASS | PASS |

The 201,351-byte reduction is the pruned PE. `node_modules/@img/sharp-win32-x64/`
retains only `package.json`, `index.cjs`, and `versions.json` — inert metadata
that is correctly not a failure.

**The new gate was proven against the real artifact, not just a fixture:**
before the fix, `inspect-release-artifact dist/artifact --architecture amd64`
exited 1 with

```
Payload contains a foreign-platform native binary for a amd64 release:
node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64-0.35.4.node.
```

and exits 0 after. A gate that has only ever run against synthetic fixtures is
not evidence that it would have caught the real thing.

### Both required targets reinstalled from the new archive

| | xt24 | xtinst |
| --- | --- | --- |
| OS | Ubuntu 24.04.5 LTS | Ubuntu 22.04.5 LTS |
| PID 1 | systemd | systemd |
| Node | 22.23.3 | 22.23.3 |
| checksum | `sha256sum -c` OK | `sha256sum -c` OK |
| install | rc=0, healthy | rc=0, healthy |
| unit | active, enabled | active, enabled |
| `/api/health` | 200 | 200 |
| `/api/nodes` (unauth) | 401 | 401 |
| `app.db` owner | `xistance:xistance` | `xistance:xistance` |
| native modules | 2 × `libquery_engine-*.so.node` | 2 × `libquery_engine-*.so.node` |

`bash scripts/test-target-write-path.sh xt24 xtinst` → **10 passed, 0 failed,
0 blocked**, exit 0 — a real service-user SQLite write and readback, not a
health probe.

No credentials are used or recorded: the admin email is
`xt-admin@example.invalid` and the password is the literal placeholder
`placeholder-not-a-secret`.

## Still open

Unchanged: no arm64 artifact has been built (no arm64 runner available on this
host — no QEMU/binfmt). TASK-78's corrected allowlist and TASK-79's foreign
binary rule both apply to arm64 but have only been exercised against amd64
payloads.
