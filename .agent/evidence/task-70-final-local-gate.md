# TASK-70 — final local release gate

## Verdict: all four criteria met on the current worktree, with warnings assessed

Run from the nested app root `xistance-panel/`, at `1.1.2`, HEAD `8e366d8`.

## AC1 — the named commands all exit 0

| command | exit |
|---|---|
| `npm run version:check` | 0 |
| `npm run lint` | 0 |
| `npm run typecheck` | 0 |
| `npx tsx scripts/test-optimizations.ts` | 0 |
| `TURBO_DISABLE=true npm run build` | 0 |

`TURBO_DISABLE=true` is mandatory: Turbopack fails on `tunnels/bin/gost`, and a
build that only passes because the flag was forgotten is not a passing build.

## AC2 — focused tests and checks all exit 0

| suite | exit | assertions |
|---|---|---|
| `test-bench-sanitized.ts` (new) | 0 | 39/39 |
| `test-resource-budgets.ts` | 0 | 32/32 |
| `test-ssrf-guard.ts` | 0 | 101/101 |
| `test-xui.ts` | 0 | 50/50 |
| `test-health-telemetry.ts` | 0 | 29/29 |
| `test-artifact-assets.ts` | 0 | 23/23 |
| `test-release-installer.sh` | 0 | 39/39 |

Plus all nine tunnel-method suites and the method matrix, from the same
worktree: backhaul 39 · frp 28 · gost 37 · ssh 50 · port-forward 29 · direct 49 ·
reverse 36 · xray 45 · xui 50 · method-matrix 50.

## AC3 — standalone configuration

The build emits the standalone server (prod uses `output: "standalone"`, so
`next start` is invalid). Route table prints `ƒ Proxy (Middleware)` and the
dynamic API routes, and the artifact checks confirm `.next/static` and `public/`
are staged in — they are excluded from a standalone output and will 404 every
CSS/JS asset if packaging skips them.

## AC4 — every warning assessed, none silently treated as a pass

**Build: exactly 4 warnings, 0 errors. All four are dependency- or
generated-side, none in authored code.**

| # | warning | assessment |
|---|---|---|
| 1 | `package.json#prisma` is deprecated, removed in Prisma 7 | Project config, not runtime. Migrating to `prisma.config.ts` is a real future task but carries no release risk; Prisma 6 still honours it. Owner: future maintenance. Not waived silently. |
| 2–3 | `Dynamic filesystem access causes tracing of the whole project` (×2) | From the generated Prisma client / its engine resolution at build time. Increases build trace size only. No runtime or artifact-size effect — the staged payload is unchanged. |
| 4 | `unexpected export *` in `./packages/db/generated/client/index.js` | The warning names the **generated** Prisma client. `git ls-files packages/db/generated/` returns **0** — the tree is untracked and `.gitignore:49` covers `**/generated/`. Editing machine output to silence it would be reverted on the next `prisma generate` and would desync the client from its generator. Left as-is deliberately. |

**Lint: 24 warnings, 0 errors, all `@typescript-eslint/no-unused-vars`
(20) and `no-control-regex` disable directives (4).**

Spread across 21 files, 19 of them test harness scripts
(`test-dialog-keyboard.ts` ×4, `test-forward-reconcile.ts` ×2, and 17 singles).
All pre-existing.

One was **mine**: `scripts/test-bench-sanitized.ts:15` — an unused
`import path from "node:path"` left behind after the file was written. Fixed,
and the file re-verified two ways: `npx eslint` on that file alone is now clean,
and the suite still reports 39/39. The aggregate count moved 25 → 24. This is
the reason for AC4 existing: a gate that only reports "exit 0" would have
shipped that warning indefinitely.

The `no-control-regex` warnings are unused `eslint-disable` directives in
scripts that test control-character handling — the disable is no longer needed
because the regex is now built with `\u0000` escapes instead of literal NULs.

## An assessment that was wrong and got corrected

While reading the gate output I took the line
`summary: 9 pass, 0 fail, 1 unknown (0 required)` printed next to
`RELEASE BLOCKED:` to mean the two contradicted each other. They do not. The
`throughput.absolute` unknown is **advisory** and does not block; the
required-unknown that blocked was **regression** on the no-baseline path, where
it correctly exits 1 rather than 0. Recorded because the mistaken reading is
the kind that would have justified "fixing" a gate that was behaving exactly as
its contract specifies.

## Not covered by this task

TASK-70 is the *local* gate and is now green. It does not substitute for the
VPS runs (TASK-62/63/64/65) or the release review (TASK-72), and the
`resource-gate.ts` comparison is not yet wired into CI because there is no
committed baseline to compare against.
