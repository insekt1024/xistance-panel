# TASK-98 — the targets now run the exact archive that ships

**Status: verified. Both amd64 targets run a payload byte-identical to the
published artifact, and the manifest digest agrees on all three sides.**

The TASK-96 fix rebuilt `dist/artifact` and the amd64 archive. The targets were
still running the pre-fix archive, so "the installer works" had been proven
against an artifact that was no longer the one being shipped. That gap is now
closed: the current archive was installed on both required OSes and the running
tree was compared to the published tree file by file.

## Install — the current archive, both targets

```
=== xtinst (Ubuntu 22.04.5 LTS) ===   INSTALL EXIT: 0
    ✓ Xistance Panel v1.2.0 is installed and healthy on port 8080.
       Previous release retained: /opt/xistance/releases/v1.2.0-20260930222912
=== xt24 (Ubuntu 24.04.5 LTS) ===     INSTALL EXIT: 0
    ✓ Xistance Panel v1.2.0 is installed and healthy on port 8080.
       Previous release retained: /opt/xistance/releases/v1.2.0-20260930222925
```

## Runtime state

| property | xtinst (22.04.5) | xt24 (24.04.5) |
| --- | --- | --- |
| active release | `v1.2.0-20261001013929` | `v1.2.0-20261001013933` |
| `systemctl is-active` / `is-enabled` | active / enabled | active / enabled |
| `GET /api/health` | 200 | 200 |
| `GET /api/nodes` (unauthenticated) | 401 | 401 |
| `app.db` owner / size | `xistance` / 176,128 | `xistance` / 176,128 |
| `resetStreak` in running chunks | 6 | 6 |
| `apply-migrations.mjs` script-relative | yes | yes |
| Prisma engines | debian + linux-musl (amd64) | same |
| static chunks | 38 | 38 |

## The identity proof

Per-file SHA-256 over every file except `release-manifest.json`, local staged
tree vs each target's `/opt/xistance/current`:

```
xtinst: BYTE-IDENTICAL (1987 files)
xt24:   BYTE-IDENTICAL (1987 files)
```

Embedded manifest digest, all three sides:

```
shipped : e731bc60686009413c193f602bfad035a4ef6c2b29ffa369169e5f29ebbbaa1b
xtinst  : e731bc60686009413c193f602bfad035a4ef6c2b29ffa369169e5f29ebbbaa1b
xt24    : e731bc60686009413c193f602bfad035a4ef6c2b29ffa369169e5f29ebbbaa1b
```

This is the end-to-end statement of what TASK-96 was for: the manifest now
describes the tree that installs, and the tree that installs is the tree that
ships.

## Two harness details worth recording

**1. The first `diff` showed 3 differences that were not real.** `find | sort`
uses the locale collation, so `app-path-routes-manifest.json` and
`app-paths-manifest.json` ordered differently on the Windows/WSL side than under
the container's locale. Re-comparing with `LC_ALL=C sort` on both sides showed
identical sets. A manifest diff over a cross-platform copy needs a fixed
collation or it manufactures differences that do not exist.

**2. A shell reimplementation of the digest produced a false mismatch.** The
first attempt computed the payload digest on the target with a
`find … | sort | sha256sum` pipeline and got `432dcf4d…` against an expected
`e731bc60…`. The cause is that `stagedPayloadDigest` sorts entries **per
directory during a depth-first walk**, while the shell version sorts **globally**.
Same tree, same file hashes, different order, different digest.

Rather than "fix" the shell version, the comparison was changed to compare
per-file hashes, which is order-independent and states the property directly. The
same trap applies to any digest that depends on traversal order: reimplementing
it in shell is a new algorithm, not a check of the original.

An attempt to ship `stagedPayloadDigest` to the target also failed —
`node --experimental-strip-types` cannot load a `.ts` file on Node 22 — which is
why the per-file comparison is the right shape for a target-side check: it needs
no TypeScript on the target at all.
