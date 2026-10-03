# Dependency and supply-chain audit (TASK-45)

Date: 2026-09-29
Method: `npm audit --omit=dev`, then **reachability in the staged release
artifact** for every finding, because a CVSS score is not a disposition.

## Findings: 4 high, 0 critical, 0 moderate, 0 low

```
info 0  low 0  moderate 0  high 4  critical 0
```

| package | installed | advisory | fix available |
|---|---|---|---|
| `nanoid` | 3.3.17 | GHSA-2v37-7h3g-55p8 — custom generators can loop indefinitely when `size` is 0 | yes |
| `deepmerge-ts` | 7.1.5 | GHSA-ggr8-5vv4-36mx — stack exhaustion merging recursive object graphs | yes |
| `@prisma/config` | 6.19.3 | (via `deepmerge-ts`) | yes |
| `prisma` | 6.19.3 | (via `@prisma/config`) | yes |

## Provenance: none are declared; all four are transitive

No workspace `package.json` declares any of them. The full chain, resolved from
the installed tree:

```
postcss        -> nanoid ^3.3.16
prisma 6.19.3  -> @prisma/config 6.19.3
@prisma/config -> deepmerge-ts 7.1.5
```

## Reachability in the shipped artifact — the part that decides it

| package | in `dist/artifact`? |
|---|---|
| `prisma` (CLI) | **absent** |
| `@prisma/config` | **absent** |
| `deepmerge-ts` | **absent** |
| `postcss` / `nanoid` | **absent** |

`dist/artifact/node_modules/next/dist/compiled/nanoid` does exist, but that is
Next's vendored bundle, not the vulnerable `nanoid` package.

**A trap worth naming:** grepping the shipped server chunks for `nanoid` returns
six hits, which looks like reachability. It is not. Every hit is Zod's *string
validator* registered under that name —

```js
nanoid(e){return this._addCheck({kind:"nanoid",...})}
get isNANOID(){...this._def.checks.find(e=>"nanoid"===e.kind)}
```

— i.e. the string `"nanoid"` as a schema check name, not a module import. Our own
source never imports `nanoid` at all. Treating a substring match as a dependency
edge would have produced a false "reachable" finding here.

The advisory also requires `size === 0`, which is a caller-controlled argument
never supplied on any shipped path.

## Disposition

| finding | severity | disposition |
|---|---|---|
| `nanoid` | high | **Accepted, not reachable.** Only via `postcss` (build-time), absent from the artifact; the Zod validator shares the name. Advisory needs `size=0`, never supplied. |
| `deepmerge-ts` | high | **Accepted, not reachable.** Reached only through the Prisma CLI's config loader. The CLI is deliberately not shipped; nothing in the artifact loads it. |
| `@prisma/config` | high | **Accepted, not reachable.** Same chain; the config loader is a Prisma-CLI-only code path. |
| `prisma` | high | **Accepted for the runtime, but see the defect below.** The CLI is not in the artifact by design. |

None of the four is exploitable from the shipped runtime or from a zero-build
install. No fix is being taken, and that is a reasoned decision, not a skipped
step — a future change that ships the Prisma CLI, or that reaches the CLI at
install time, invalidates all three Prisma dispositions and must re-run this.

## Workflow action pinning — clean

```
.github/workflows/ci.yml      8/8   pinned to a 40-char commit SHA
.github/workflows/release.yml 14/14  pinned to a 40-char commit SHA
```

Zero unpinned `uses:` entries, no mutable tag references.

## DEFECT FOUND: the installer still calls the CLI it does not ship

While tracing reachability, a real release blocker surfaced.

`scripts/install.sh` (`init_db`, line 764) still does:

```sh
npx prisma db push --accept-data-loss --skip-generate ...
  || { npx prisma generate ... && npx prisma db push ...; }
npx prisma db seed ...
```

But:

- the artifact ships **no** `node_modules/prisma` — the CLI is absent;
- `apply-migrations.mjs` states in its own header that the CLI is *"deliberately
  [not] shipped"* and that a zero-build install *"cannot run `prisma db push`"*;
- `install.sh` **never references** `apply-migrations.mjs` or `create-admin.mjs`,
  the two entry points that *are* shipped at the artifact root;
- the `prisma/` and `generated/` directories under `packages/db` are present but
  contain no CLI.

So on a real target `npx prisma` resolves to **nothing local** and falls back to
downloading the package from the registry at install time. That breaks the
zero-build contract (a network install on the VPS), it runs unpinned code that
no manifest or checksum covers, and it is exactly the supply-chain link the
artifact's checksum gate claims to protect.

**The `dist/artifact` runs that passed the TASK-61 gate did not exercise this** —
they invoked `apply-migrations.mjs` and `create-admin.mjs` directly. So the gate
is sound but it is testing a path `install.sh` does not take, which is a coverage
gap rather than a passing result.

This is the concrete "supply-chain link your manifest does not cover" case: an
installer that fetches a dependency at run time. Fix is to make `init_db` call
the shipped entry points. **Not fixed in this pass** — it is a behaviour change to
the installer and needs its own verification on a target host.

## Tunnel binaries — not audited in this pass

TASK-45 also requires pinning tunnel binary versions/sources/checksums. The
`tunnels/bin/gost` binary is a third-party daemon fetched by the installer and
is **not covered** by this audit. It remains open, and it is the larger of the
two supply-chain surfaces.
