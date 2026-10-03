# Install path: the Prisma CLI fetch defect (TASK-45 follow-up)

Date: 2026-09-29
Found during: supply-chain audit, reachability check
Fixed in this pass: **yes**, with mutation-verified tests

## The defect

`scripts/install.sh` → `init_db()` ran:

```sh
npx prisma db push --accept-data-loss --skip-generate ...
  || { npx prisma generate ... && npx prisma db push ...; }
npx prisma db seed ...
```

The release artifact ships the Prisma **client** and deliberately omits the
**CLI** — `apply-migrations.mjs` states this in its own header and explains that
a zero-build install "cannot run `prisma db push`". `dist/artifact/node_modules/prisma`
does not exist.

So on a real target `npx prisma` resolves to nothing local and **downloads the
package from the registry at install time**. Consequences:

1. it breaks the zero-build contract — the whole point of the artifact is that
   the target never builds or fetches;
2. it runs unpinned code that no manifest, checksum or attestation covers, which
   is precisely the supply-chain link the artifact's integrity gates claim to
   close;
3. it fails or hangs on a host with no registry access, i.e. exactly the air-gapped
   case the local-archive installer mode exists to support.

Meanwhile `install.sh` never referenced `apply-migrations.mjs` or
`create-admin.mjs` — the two entry points that *are* shipped at the artifact root.

**Why it survived a 23-assertion contract suite:** `test-release-installer.sh`
had *zero* assertions about the database-init path. Nothing was checking it.

## The fix

`init_db()` now branches explicitly:

- **zero-build** (both `.mjs` present, the artifact case) → `node apply-migrations.mjs`
  with an explicit `--migrations` directory, then `node create-admin.mjs` with the
  email and a quoted `--password`;
- **source build** (`command -v prisma` succeeds) → the original `npx prisma`
  path, which is correct there because the CLI genuinely exists;
- **neither** → fail loudly, so the installer never silently reaches the network.

The `--migrations` path is passed explicitly because the shipped SQL lives one
level deeper than the directory (`prisma/migrations/<name>/migration.sql`), and
the tool's default is `process.cwd()`-relative — which is `packages/db` after
the `cd`, not the release root.

The admin password is passed as a quoted flag / env var and never spliced into a
command string.

## Coverage added, and proven non-vacuous

Six assertions added to `scripts/test-release-installer.sh`:

1. `init_db` references `apply-migrations.mjs`
2. `init_db` references `create-admin.mjs`
3. `npx prisma` appears **only after** a `command -v prisma` guard
4. prisma use is guarded by an existence check
5. an explicit `--migrations` directory is passed
6. the admin password is a quoted flag, not spliced into a command

Verified in both directions by reverting `init_db` to the pre-fix body:

| version | result |
|---|---|
| fixed | **29 passed, 0 failed** (exit 0) |
| pre-fix defect restored | **23 passed, 6 failed** (exit 1) |
| fixed, restored again | 29 passed, 0 failed (exit 0) |

All six fire on the defect, so none is a test that cannot fail.

## Two test bugs found while writing these

**A comment that names the forbidden command was matched as an invocation.**
The assertion scanned `init_db` for `npx prisma` and found it on the *comment*
line explaining why the original was wrong — so the fixed installer reported a
defect that did not exist. Fixed by stripping comments before scanning
(`sed 's/[[:space:]]*#.*$//'`). Same trap as a forbidden-word scan that reads a
script's own documentation as a violation.

**A line-order assertion was the wrong shape.** The first attempt asserted "no
top-level `npx prisma`", which is false for correct code — the source-build
branch legitimately contains it. The meaningful property is structural: the CLI
must not be reachable *unless a local prisma binary exists*. That is what
assertion 3 now checks, by comparing the line number of the guard against the
first `npx prisma`.

Both were test defects, not code defects, and were fixed in the test.

## What is still unproven

The new `init_db` branch has been verified **statically** (assertions + `bash -n`)
and its two constituent commands were verified **functionally** — the TASK-61
cgroup gate runs `apply-migrations.mjs` and `create-admin.mjs` against the
staged artifact under a real memory/CPU cap and asserts a working admin login
afterwards.

What is **not** proven is the assembled path: nobody has run `init_db` itself
end to end on a target, because that requires the real Ubuntu VPS (TASK-62). The
TASK-61 gate exercises the same two entry points but not through the installer's
own control flow.

## Remaining supply-chain gap

TASK-45 also requires pinning the **tunnel binary** versions, sources, checksums
and licenses. `tunnels/bin/gost` is a third-party daemon fetched by the installer
and is not covered by anything in this audit. It is the larger of the two
supply-chain surfaces and remains open.
