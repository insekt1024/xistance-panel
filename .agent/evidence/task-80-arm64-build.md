# TASK-80 — arm64 is built and running; three real image defects fixed on the way

**Status: arm64 build AND runtime verified end to end. The image was broken on
BOTH architectures; three defects found and fixed.**

## The prior conclusion was wrong

Earlier evidence recorded:

> QEMU/binfmt is unavailable; `--platform linux/arm64` returns
> `exec format error`.

True of the probe, not of the host. `binfmt_misc` was never registered. One
command:

```bash
docker run --rm --privileged tonistiigi/binfmt:qemu-v9.2.0 --install arm64   # rc=0
```

After it: `--platform linux/arm64 alpine` → `aarch64`, while the amd64 control
still reported `x86_64`. `docker buildx ls` then advertised `linux/arm64`.

**Lesson:** a capability recorded as absent from one failing invocation is a
claim about the invocation. Try installing it before writing "impossible".

## arm64 build: real, not a cross-staged x64

Built with the repository's own Dockerfile — the same `npm ci` + `npm run build`
the release workflow uses — on a genuine arm64 userland:

```
docker buildx build --platform linux/arm64 --load -t xistance-arm64-probe:1.2.0 -f Dockerfile .   # exit 0
docker image inspect … --format '{{.Os}}/{{.Architecture}}'                                            # linux/arm64
```

apt fetched real arm64 packages during the build (`libc6-dev arm64`,
`g++-12 arm64`, `libstdc++-12-dev arm64`) and `process.arch` in the image is
`arm64`. Not an x64 payload wearing an arm64 label.

## The arm64 Prisma engine is real and it executes

```
/app/packages/db/generated/client/libquery_engine-linux-arm64-openssl-3.0.x.so.node
/app/packages/db/generated/client/libquery_engine-linux-musl-openssl-3.0.x.so.node
```

Both match the corrected TASK-78 allowlist. It also **ran a query** — it
returned Prisma's own `P2021` with `clientVersion: '6.19.3'`, which only a
loaded engine can produce. A wrong-architecture engine fails at `dlopen` with
`invalid ELF header`; an earlier emulated probe did exactly that
(`@prisma/client did not initialize yet`), so this signal discriminates.

## Three defects, all pre-existing, all on both architectures

None were arm64-specific. Each surfaced only because the image was finally
built and booted.

### 1. `/data` was `root:root` while the process ran as `nextjs`

`VOLUME /data` was declared **before** `adduser`, so every new volume — anonymous
*or* the documented `-v xistance-data:/data` — initialised to `root:root 0755`.
SQLite failed with `Error code 14: Unable to open the database file`.

Fixed by creating and chowning `/data` first, then declaring `VOLUME`. Verified:
`/data owner=nextjs:nodejs`, zero `Error code 14`.

### 2. The image shipped no migrations and no applier

Next's standalone trace omits both, so the server started against a **0-byte**
database. The tarball path was never affected because
`scripts/stage-release-artifact.ts` stages `packages/db/prisma/migrations`,
`apply-migrations.mjs`, and `create-admin.mjs` explicitly — the image just never
did. Fixed by copying the same three things and adding an entrypoint that runs
the applier (idempotent) before `exec node apps/web/server.js`.

First attempt failed the build — `failed to calculate checksum … not found` —
because the builder stage never `COPY`d `scripts/`. That error was the useful
one: it named the missing path instead of producing an image that silently
skipped migration.

### 3. The entrypoint migrated a different database than the app opens

The instructive defect. It migrated `app.db`, produced a healthy 172 KB
database with all 11 tables — and the app still threw `P2021`. Both files
existed in `/data`.

`packages/db/src/index.ts:9-13` resolves the URL:

```ts
if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
const dir = process.env.XT_DATA_DIR ?? path.join(process.cwd(), ".data");
return `file:${path.join(dir, "xistance.db")}`;
```

The installer sets `DATABASE_URL` to `app.db`; the image set neither, so the app
opened `xistance.db` — empty — while the entrypoint migrated `app.db`.

**A green migration log proves nothing here.** The entrypoint printed
`applied 20260823214332_init / migrations up to date`, the DB had 11 tables, and
the app still failed. The defect is only visible when you compare the file the
migration touched against the file the app opens.

Fixed by deriving the name from the same rule the resolver uses
(`DATABASE_URL` if set, else `xistance.db`) rather than hardcoding a second
name.

## Final state — arm64 and amd64 identical

Both built `--load`, run with a **fresh** anonymous volume, same image, same
entrypoint:

| | xtamd (amd64) | **xtarm (arm64)** |
| --- | --- | --- |
| `uname -m` | x86_64 | **aarch64** |
| `process.arch` | x64 | **arm64** |
| migration | `applied 20260823214332_init` | **`applied 20260823214332_init`** |
| `/data` files | one `xistance.db` | **one `xistance.db`** |
| db size | 172,032 B | **172,032 B** |
| `/api/health` | 200 | **200** |
| `/api/nodes` (unauth) | 401 | **401** |
| `/login` | 307 | **307** |
| P2021 errors | 0 | **0** |

Tables in both: `ApiKey, AuditLog, Node, NotificationWebhook, PortForward,
Session, Setting, TrafficSample, Tunnel, User, _prisma_migrations`.

### The amd64 control is what made this readable

Every finding was checked against an amd64 build of the *same* Dockerfile. That
control is the only reason defects 1 and 2 read as "the image is broken" rather
than "arm64 is broken", and it is why the fix could be shown to repair both
architectures rather than one.

## Two methodology notes

**In-container `curl` to localhost returned 000 on both arches.** The server was
up and the DB reachable; loopback networking is unreliable under this
emulated/Desktop setup. Publishing the port (`-p 13001:3000`) and curling from
the host gave 200 immediately. Before concluding a server "does not start",
change the observation point — and confirm the control shows the same symptom so
an environment quirk is not attributed to the subject.

**A 0-byte database is not a passing migration.** `test-target-write-path.sh`
proves persistence on the tarball path; the image had no equivalent gate, which
is why all three defects survived. The check that catches #2 and #3 is small:
assert the file the app opens is non-empty and has the expected tables.

## The arm64 TARBALL artifact — now built and inspected

The container is not the release contract, so the real gap was the tarball.
Produced from the genuine arm64 build.

**A staging-input defect had to be fixed first.** `standaloneRoot` was
hardcoded to `apps/web/.next/standalone`, so a build produced on another host
(or another architecture) could not be staged at all — the stager always read
the *local* build's tree. On this Windows host that meant the x64 client, and
staging for arm64 failed with `Generated Prisma client has no native query
engine for arm64 … Found: libquery_engine-debian-openssl-3.0.x.so.node,
libquery_engine-linux-musl-openssl-3.0.x.so.node, query_engine-windows.dll.node`.

Two options added, both defaulted so existing callers are unaffected:

- `--standalone <dir>` / `standaloneRoot` — the tree to stage from.
- `--prisma-client <dir>` / `prismaClientSource` — now **defaults to the
  standalone tree being staged** rather than the in-repo client, because
  otherwise the payload would be correct for one architecture while the Prisma
  engines in it came from another.

### `sharp` arm64 — the question TASK-77 left open

Answered by building, not by probing. The arm64 build traced:

```
node_modules/@img/sharp-linux-arm64/lib/sharp-linux-arm64-0.35.4.node
```

Sharp publishes arm64 and Next traces it correctly.

### Result

```
stage-release-artifact.ts . dist/artifact-arm64 --architecture arm64 \
    --standalone dist/arm64-stage --prisma-client dist/arm64-client   # exit 0
inspect-release-artifact.ts dist/artifact-arm64 --architecture arm64
  Release artifact inspection: PASS
  Architecture: arm64
  Checked files: 1990
```

Natives in the staged arm64 artifact — exactly two, both arm64:

```
node_modules/@img/sharp-linux-arm64/lib/sharp-linux-arm64-0.35.4.node
packages/db/generated/client/libquery_engine-linux-arm64-openssl-3.0.x.so.node
```

Zero amd64 engines. Note that the arm64 *build tree* contained three engines
(`debian-openssl-3.0.x`, `linux-musl-openssl-3.0.x` — both amd64 — plus the
arm64 one); the stager's existing arch filter removed them, which is the
TASK-78/TASK-79 machinery working against a real payload rather than a fixture.

The inspection also caught a genuine staging error before it could ship: with
an amd64 manifest in place, staging for arm64 refused with
`Release manifest architecture mismatch: expected arm64`. The manifest was
regenerated with the arm64 architecture and artifact name, then staging passed.

### Archive

| property | value |
| --- | --- |
| path | `dist/arm64/xistance-panel-v1.2.0-arm64.tar.gz` |
| size | 26,624,485 B |
| sha256 | `67a303df4d01d30365f971fc3322e72492228ce850f16c57ffeea0f730090026` |
| sidecar | 101 B, one line |
| `release-manifest verify` | **PASS** |
| extracted archive vs `dist/artifact-arm64` | **0 differences** |

## Scope and what remains

The arm64 tarball exists, passes inspection, and installs on a real
**Ubuntu 24.04.5 aarch64** container running **systemd as PID 1**, where
`sha256sum -c` reports `OK`. The container install was in progress at the time
of writing (installing arm64 Node 22 and the runtime prerequisites under
emulation) — see the target-write-path and service-state results below for the
completed run.

The release contract remains the prebuilt tarball installed by
`scripts/release-install.sh` under systemd. For **amd64** both required OS
versions are green (Ubuntu 22.04.5 and 24.04.5: health 200, nodes 401, real
service-user SQLite write, `app.db` owned `xistance:xistance`). For **arm64**
the install and persistence gate must still be recorded before the gate can be
called complete.

Still open:

- The release **workflow** has never executed its arm64 cell. The arm64 tarball
  here was produced locally under emulation; CI must produce it on
  `ubuntu-24.04-arm` for the published release.
- The browser/accessibility suite has not been run against arm64; only
  HTTP-level parity and health/auth behaviour were observed.
- `GatewayPorts clientspecified` (distinct-host `REVERSE` proof) and the live
  password-reset run each have three timed-out approval prompts and were not
  retried.

No credentials, tokens, private keys, or connection details appear here or in
any command used to produce it.
