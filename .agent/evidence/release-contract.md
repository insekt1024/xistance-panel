# Release runtime and architecture feasibility — TASK-3

Date: 2026-09-24
Repository: `xistance-panel`

## Verified release boundary

- Target OS matrix: Ubuntu 22.04 and Ubuntu 24.04, with Debian allowed only as a documented installer compatibility path outside the release acceptance matrix.
- Target architectures: `amd64` (from `x86_64`/`amd64`) and `arm64` (from `aarch64`/`arm64`).
- Runtime: Node.js 22 or newer compatible runtime; the installer enforces major version 22 as the minimum.
- Production server: Next standalone `apps/web/.next/standalone/apps/web/server.js`; `next start` is not used for production.
- The successful local build produced the standalone server, traced `node_modules`, package metadata, and a generated Prisma client.
- The build output contains native modules (including sharp variants and the Prisma query engine), so an artifact must preserve the generated client and the correct native module for its target architecture. The current local output includes Windows and Linux engine files because the build host is Windows; cross-architecture publication must be generated/validated on the corresponding Linux architecture or with a proven reproducible native-dependency strategy.
- Tunnel binaries (`backhaul`, `frpc`, `frps`, `gost`, `xray`) are separate runtime assets. They may be bundled per architecture or installed by the pinned installer; the VPS must not compile the application source.
- `public` and `.next/static` are required application assets and must be staged into the standalone tree. Their staging is handled by TASK-6 and remains a release gate until its focused test is green.

## Contract decisions

- This is a prebuilt application artifact plus Node 22 runtime and managed OS/tunnel binaries, not a native self-contained rewrite of Next.js.
- Mutable data, SQLite databases, keys, logs, local env files, and generated development state are excluded from the immutable artifact.
- Secrets are supplied at install time through a root-owned environment file and are never included in release archives.
- The installer rejects unsupported `uname -m` values with an actionable error rather than silently selecting the wrong binary.

## Feasibility result

The application can be built in CI/CI-equivalent environment and consumed by the VPS without `npm install` or `next build` when the standalone tree, traced dependencies, native engine, public/static assets, and external tunnel binaries are staged correctly. Cross-architecture native assets and Ubuntu 22.04/24.04 runtime/install evidence remain required release gates; local Windows build evidence is not a substitute.

The selected “single immutable release artifact” wording means one immutable prebuilt bundle per architecture, not one self-executing native binary.

## arm64 feasibility gate — RESOLVED: FEASIBLE (2026-09-30)

`arm64` is a **required** release target, not an optional one. The PRD makes it
conditional on an explicit feasibility gate, and that gate is now discharged with
evidence. Full record: `.agent/evidence/task-77-arm64-feasibility-gate.md`.

Prisma selects the query engine for **the machine that generates the client**, so
the gate question is whether a native linux-arm64 engine is published for the
pinned version.

- Pinned Prisma: `6.19.3`
- Pinned engines commit: `c2990dca591cba766e3b7ef5d9e8a84796e47ab7`
  (from `node_modules/@prisma/engines-version/package.json` → `prisma.enginesVersion`)
- Probe template: `https://binaries.prisma.sh/all_commits/<commit>/<platform>/query-engine.gz`

| target | platform string | HTTP |
| --- | --- | --- |
| control (x64) | `debian-openssl-3.0.x` | 200 |
| control (x64) | `debian-openssl-1.1.x` | 200 |
| arm64 GNU/Linux | `linux-arm64-openssl-3.0.x` | 200 |
| arm64 GNU/Linux | `linux-arm64-openssl-1.1.x` | 200 |
| arm64 musl/Alpine | `linux-musl-arm64-openssl-3.0.x` | 200 |
| arm64 static | `linux-static-arm64` | 200 |

**Conclusion: arm64 is feasible.** The platform names are read from
`node_modules/@prisma/get-platform/dist/*.js` (`binaryTargets`), not guessed —
they are *prefixed* (`linux-arm64-openssl-3.0.x`), which is why an earlier
`-arm64`-suffix probe reported a false absence.

### What this does not establish

1. ~~**No arm64 tarball artifact has been built.**~~ **RESOLVED 2026-09-30
   (TASK-80/82).** A real `linux/arm64` build produced
   `dist/arm64/xistance-panel-v1.2.0-arm64.tar.gz` (26,624,485 bytes, SHA-256
   `67a303df…`), which passed checksum, inspection (1,990 files, exactly two
   native blobs, both arm64) and a full service run on Ubuntu 24.04.5 aarch64:
   migration applied as the unprivileged service user, `Next.js 16.3.6` ready,
   `/api/health` 200, `/api/nodes` 401, persistence intact across a restart.
   **What is still unrun is the CI cell itself** — the workflow job on
   `ubuntu-24.04-arm` has not executed, so local emulated proof does not yet
   stand in for the release workflow.
2. ~~**This host cannot execute arm64.**~~ **FALSIFIED 2026-09-30 (TASK-80).**
   `binfmt_misc` was simply unregistered. One command —
   `docker run --rm --privileged tonistiigi/binfmt:qemu-v9.2.0 --install arm64`
   — registered `qemu-aarch64`, after which `--platform linux/arm64` reports
   `aarch64` while the amd64 control still reports `x86_64`. A real arm64 build
   and a real arm64 runtime were then proven on this host. A capability written
   down as absent from a single failing invocation is a claim about the
   invocation, not the host.
3. ~~**Sharp's arm64 availability is settled in practice but not by the release
   gate.**~~ **RESOLVED 2026-09-30 (TASK-80).** `inspect-release-artifact` has now
   run against a real arm64 *tarball* staging tree
   (`dist/artifact-arm64`, staged from `dist/arm64-stage`): 1,990 files, exactly
   two `.node` blobs — `sharp-linux-arm64-0.35.4.node` and
   `libquery_engine-linux-arm64-openssl-3.0.x.so.node` — and zero amd64 or
   foreign native binaries. Sharp's arm64 binary is produced by a real build,
   not inferred from package metadata.

## arm64 engine filenames — CORRECTED (2026-09-30, TASK-78)

Discharging the gate exposed a real defect in the *staging* contract.
`PRISMA_LINUX_ENGINES.arm64` named `libquery_engine-debian-openssl-3.0.x-arm64.so.node`,
which Prisma never publishes (ids are *prefixed*, not suffixed), and paired it
with the arch-free `libquery_engine-linux-musl-openssl-3.0.x.so.node`, which is
an **amd64** binary. A correct arm64 build would have failed inspection, and a
wrong-architecture engine would have passed it.

Corrected allowlist, each name verified HTTP 200 for engines commit
`c2990dca591cba766e3b7ef5d9e8a84796e47ab7`:

```text
amd64: libquery_engine-debian-openssl-3.0.x.so.node          200
       libquery_engine-debian-openssl-1.1.x.so.node          200
       libquery_engine-linux-musl-openssl-3.0.x.so.node      200
arm64: libquery_engine-linux-arm64-openssl-3.0.x.so.node      200
       libquery_engine-linux-arm64-openssl-1.1.x.so.node      200
       libquery_engine-linux-musl-arm64-openssl-3.0.x.so.node 200
```

`linux-static-arm64` is a declared target with **no** published query engine
(404) and is deliberately excluded. Full record:
`.agent/evidence/task-78-prisma-engine-allowlist.md`.

## Native install gate — amd64 CLOSED, arm64 OPEN (2026-10-01)

### amd64: the official installer has now actually run (TASK-90)

`scripts/release-install.sh` is a **repository script, not an archive file**, so
it had never been executed end to end before this. Three of its four earlier
"failures" were invocation errors (a bare `1.2.0` instead of `v1.2.0`; the
`.sha256` sidecar not shipped beside the archive; its `lib/` helpers not staged).
The corrected invocation succeeds on both required targets:

| target | OS | systemd | `/api/health` | `/api/nodes` | `app.db` owner | exit |
| --- | --- | --- | --- | --- | --- | --- |
| `xtinst` | Ubuntu 22.04.5 amd64 | active + enabled | 200 | 401 | `xistance` | 0 |
| `xt24`  | Ubuntu 24.04.5 amd64 | active + enabled | 200 | 401 | `xistance` | 0 |

Record: `.agent/evidence/task-90-installer-execution.md`.

### The installer's failure path is proven (TASK-92)

QEMU's broken `tar` made a real partial extraction available on demand, so the
refusal path was exercised through the real installer on a real target: the
previous release stayed current, the service stayed active and healthy, the
database was untouched, and the partial candidate was removed. `INSTALL EXIT: 7`.
Record: `.agent/evidence/task-92-partial-extraction-safety.md`.

### arm64: the blocker is the emulated host's `tar`, not the artifact (TASK-91)

The long-standing arm64 install failure is **root-caused and is not a release
defect**:

- the shipped arm64 archive's checksum verifies **on the arm64 target itself**;
- the failure is `Cannot mkdir: Invalid argument` on 2,402 of 2,403 members,
  yielding 5 of 1,990 files;
- standalone `mkdir`, `dd`, `install`, `cat` and file creation all succeed in the
  same container, so the filesystem is sound;
- no `tar` flag avoids it (`--no-same-owner`, `--no-same-permissions`,
  `--delay-directory-restore`, `--no-overwrite-dir` all yield 5 files);
- **the control that settles it:** a 14-byte archive built *and* extracted on the
  arm64 target fails identically, as does Node.js's own official arm64
  `tar.xz`. GNU tar 1.35 under QEMU-user arm64 cannot complete an extraction.

An external extractor recovered all 1,990 files from the same bytes, which is how
the arm64 *service* was proven. Record:
`.agent/evidence/task-91-arm64-tar-qemu-defect.md`.

**Still open for arm64, and not claimed closed:**

1. the **native arm64 install path** has never completed — the installer shells
   out to `tar`, so the external extractor proves the payload but not the
   installer;
2. the `ubuntu-24.04-arm` **CI release cell** has never executed.

Both close on a native arm64 runner, where `tar` is native and this defect does
not exist. Neither is a substitute for the other.

### The arm64 installer path is proven (TASK-100)

Giving the installer a *working* `tar` on the emulated target closes the gap
TASK-91 left open. `bsdtar` (libarchive 3.7.2) is packaged for Ubuntu arm64 and
extracts the real archive completely (exit 0, 1,988 files, 1 arm64 engine). With
a three-line `tar` → `bsdtar` shim first on `PATH`, the **unmodified** installer
runs to completion:

```
INSTALL EXIT: 0
  aarch64, systemd PID 1, unit active+enabled, root-only env file,
  xt-rollback installed, /api/health 200, /api/nodes 401,
  app.db 172,032 bytes owned by xistance
```

and a row written as the unprivileged service user survives
`systemctl kill -s SIGKILL` and reads back with the same UUID.

**This is emulated evidence.** The shim is a host workaround, not a product
change: nothing in `release-install.sh` was modified and nothing shipped depends
on `bsdtar`. It proves the installer's arm64 logic; a native arm64 runner is
still required to close the native gate. Record:
`.agent/evidence/task-100-arm64-installer-completes.md`.
