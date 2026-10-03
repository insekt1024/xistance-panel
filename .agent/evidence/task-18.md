# TASK-18 evidence — release installer documentation contract

**Status:** passed

## What changed

| File | Change |
| --- | --- |
| `scripts/test-release-docs.ts` | New consistency check (written first, observed RED with 12 failures) |
| `README.md` | Release contract rewritten: artifact vs runtime vs tunnel binaries, pinned install, verification, cutover, rollback, update, backup, low-resource, troubleshooting |
| `README_FA.md` | Mirrored in Persian with the same commands and the same pinned tag |

## What the check enforces

1. A documented `release-install.sh` command exists, pins an exact semver tag,
   and never runs `npm`, `next build` or `prisma generate` on the host.
2. Every long option actually passed to `release-install.sh` in the docs is
   accepted by the installer script.
3. Prerequisites are separated: Node.js 22 runtime, supported Ubuntu releases,
   supported architectures, and tunnel binaries distinguished from the artifact.
4. The operational model is documented: static assets, versioned immutable
   directories, atomic cutover, health check, rollback, backup, checksum.
5. No literal secret values in either README, and no source build presented as
   the production install path.
6. `README_FA.md` documents the same command, tags the same version, and covers
   checksum, rollback, architecture and Node.js.

## Non-vacuity

Three deliberate documentation defects were introduced and each was caught:

| Mutation | Caught |
| --- | --- |
| Persian README drifted to `--version v1.1.0` | `must document the same version tag (en=v1.2.0, fa=v1.1.0)` |
| Documented a flag that does not exist (`--force-no-clobber`) | `passes --force-no-clobber to release-install.sh, which does not accept it` |
| Put `sudo npm ci &&` in the install command | `must not run npm on the target host` |

The second mutation exposed a real weakness in my first version of the check:
it validated a hardcoded allowlist of flags, so an invented flag was invisible.
The check now collects every `--flag` from the lines that invoke the installer
and verifies each against the script, scoped to those lines so that flags meant
for `create-admin.mjs`, `bootstrap.sh` and git are not misreported.

## Errors I made and corrected

- A `git checkout README.md` used to undo a mutation **destroyed the entire
  rewritten English install section**. It was caught immediately by the
  documentation check (`en=undefined`) and rebuilt. Restoring state now uses a
  plain file copy, never `git checkout`, because the tree carries uncommitted
  work that must not be discarded.
- The Persian README backup was taken *after* a mutation had already been
  applied, so restoring it reintroduced `--version v1.1.0`. Repaired
  explicitly.

## Verified

- `test-release-docs.ts` — pass
- `test-line-endings.sh` — 54/54
- `test-rewrite-build-paths.ts` — pass
- `test-create-admin.ts` — pass
- `version:check`, `lint`, `typecheck` — pass

**19/73 tasks passed.**
