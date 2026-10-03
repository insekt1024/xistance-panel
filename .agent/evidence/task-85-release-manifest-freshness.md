# TASK-85 — the release manifest described a payload that no longer existed

**Status: closed. Three real defects found and fixed, the most serious being a
migration script that reported success while doing nothing.**

## The starting observation

`release-manifest.json` claimed a payload digest of `044c1b8f3ae0bc9b…`. The
real amd64 archive's SHA-256 was `9960ec2047d89b1c…`. Different — but the
manifest is *not* supposed to hold the archive's digest.

`treeDigest` is documented in `scripts/release-manifest.ts` as the digest
"which must be computable without archiving (an archive cannot contain its own
digest)". So the correct comparison is against the **payload tree**, not the
tarball. That is why an earlier draft of this check reported a false defect, and
it is worth recording: the first version compared the manifest to the archive
because the two numbers visibly differed, and would have "fixed" a manifest that
was correct by design.

## What the manifest actually described: nothing

```
apps/web/.next/standalone/apps/web   b70db5e3b8a789e7...   (836 files)
dist/artifact                       5c5e630c807db105...   (1988 files)
release-manifest.json claims        044c1b8f3ae0bc9b...
```

It matched **neither** tree the release scripts stage from. The manifest
described a payload that no longer exists on disk. A verifier that recomputes
the digest before extraction — the entire point of recording a payload digest —
would have rejected the release.

### Why nothing caught it

Three independent checks all passed, which is exactly why it survived:

1. **The `.sha256` sidecar verified OK.** It is compared to the archive, and the
   archive is correct. Nothing compared it to the manifest.
2. **`test-verify-artifact.ts` uses synthetic fixtures** built by
   `buildReleaseManifest`, so manifest and digest are produced together and agree
   by construction. It proves the verifier's logic, never that the repo's own
   manifest is current.
3. **`buildReleaseManifest` takes the digest as an INPUT.** Regenerating the
   manifest produces a new value only if the caller remembers to recompute the
   tree. A stale value is not merely possible; it is what you get by default.

## The fix

`scripts/test-release-manifest-freshness.ts` recomputes the digest of every
tree the release scripts stage from and requires the manifest to match one. It
also checks the archive and its sidecar, so the whole release is described in
one place.

Regenerated the manifest from the real payload:

```
manifest digest matches a payload tree on disk
     dist/artifact (1988 files)
the built archive exists for this manifest
     dist\amd64\xistance-panel-v1.2.0-amd64.tar.gz (40720039 bytes)
the .sha256 sidecar matches the archive
     9960ec2047d89b1c...
--- 4 passed, 0 failed ---
```

Non-vacuity: with the digest set to `0`×64, the gate reports
`3 passed, 2 failed`. Restored, it returns to 4/4.

## Second defect: the local manifest named a file the release never publishes

Restaging revealed it. `scripts/stage-real-artifact.ts` built the artifact name
as:

```ts
artifactName: `xistance-panel-${version}-amd64.tar.gz`
```

while `.github/workflows/release.yml` publishes:

```yaml
ARTIFACT_NAME: xistance-panel-v${{ needs.version.outputs.version }}-${{ matrix.architecture }}.tar.gz
```

No `v`. So the manifest a developer generated locally described
`xistance-panel-1.2.0-amd64.tar.gz` while the release publishes
`xistance-panel-v1.2.0-amd64.tar.gz` — a disagreement on the one filename a
downloader types. The two are edited independently, which is how they drifted.

Fixed to match, with the workflow cited in the comment rather than the
convention assumed.

## Third defect, and the serious one: a migration script that silently did nothing

Running the payload suite under the aggregate surfaced:

```
Error: staged create-admin.mjs failed: admin creation failed: no such table: User
    no migrations found in /root/xt-gate/packages/db/prisma/migrations; nothing to apply
```

`apply-migrations.mjs` defaulted its migrations directory to the **process
working directory**:

```js
options.migrations || path.join(process.cwd(), "packages/db/prisma/migrations")
```

and, on finding nothing, printed "nothing to apply" and **exited 0**.

That is a silent success. A caller in the wrong directory gets a clean exit, an
installer that checks only the exit code concludes the schema is current, and
the first symptom appears much later as `no such table: User` from a live
server with the installer long gone.

`scripts/release-install.sh:482` was already correct — it passes
`--migrations` explicitly. So the shipped install path was never exposed to
this. But:

- the default was wrong, and anything relying on it was silently broken;
- a supplied-but-empty `--migrations` also exited 0.

Both fixed:

- the default now resolves **next to the script**, which is the only location
  correct regardless of the caller's cwd;
- an explicitly supplied `--migrations` that contains nothing is now an **error**,
  because the caller has stated where they are.

```js
if (options.migrations) {
  process.stderr.write(
    `no migrations found in ${migrationsDir}, which was passed explicitly. ` +
      `Refusing to report success: the release's schema would be missing.\n`,
  );
  return 1;
}
```

Verified both ways: run from `/tmp` it now resolves beside the script; pointed at
an empty directory it refuses and exits non-zero.

`scripts/lib/staged-app.ts` now also passes `--migrations` explicitly rather than
relying on the default, since it stages the payload to an arbitrary location.

## Restaging was required

The staged tree carried the old applier, so `dist/artifact` was rebuilt with
`scripts/stage-real-artifact.ts` (1,988 files, applier now byte-identical to
source). The manifest was regenerated in the same pass, which is what surfaced
the filename defect.

## Also fixed: two harness bugs the new work exposed

**The WSL suite runner transpiled only one helper.** `run-all-tests.ts`
esbuild-transpiled `lib/asset-refs.ts` and nothing else, so when a suite began
importing a second helper it failed at runtime with
`Cannot find module './lib/pick-port'`. The transpile list is now explicit and
errors loudly on a missing target, so the next added helper fails at the point
of addition rather than inside WSL.

**One argv list was shared by every shell suite.** The `.sh` branch passed the
cgroup gate's four arguments (`$H/artifact $H/artifact/apps/web 268435456 39355`)
to whatever `.sh` file it was given. The release-payload suite takes a single
optional argument and died on the unrecognised extras. Arguments are now
per-suite in `SHELL_SUITE_ARGS`, and an unlisted suite fails with an explicit
message instead of inheriting someone else's argv.

**A copied script resolved the wrong repository root.** `REPO` came from
`$BASH_SOURCE`, so when the runner copies the script to `$HOME/xt-gate/` it
resolved to `/root` and found no `node_modules`. It now accepts `XT_REPO`, and
the runner exports it.

## Not changed, deliberately

The manifest still records a payload digest, not the archive's. Comparing it to
the `.tar.gz` would be meaningless, and doing so is the mistake that produced the
first, wrong version of this check. The suite compares against the tree.

No credentials, tokens, private keys, or connection details appear in this file.
