# TASK-72 — final release review and gate decision

> **Superseded 2026-09-30.** The version below claimed local work was
> complete. That was premature: an independent security review delivered late
> reported a **critical SSH RCE**, which I reproduced and fixed. The corrected
> decision and the corrected local-gate table are in
> [task-72-final-gate-decision-v2.md](task-72-final-gate-decision-v2.md).
> This file is kept as the record of the earlier assessment.

## Decision: **NO-GO for the 1.2.0 release.** Not blocked on engineering; blocked
## on an unavailable target host.

Everything that can be verified on this machine has been verified. The release
is not blocked because work is unfinished — it is blocked because four required
gates can only be executed on an Ubuntu host that is not available, and I will
not mark them passed on the strength of local evidence.

---

## AC1 — every required task has verified evidence or an explicit blocker

**68 of 73 tasks have a dedicated evidence file.** The five that do not:

| task | status | why |
|---|---|---|
| TASK-62 installer on real Ubuntu 22.04 | **BLOCKED** | needs a target VPS |
| TASK-63 startup health / static assets on Ubuntu 24.04 | **BLOCKED** | needs a target VPS |
| TASK-64 update migration and rollback on VPS | **BLOCKED** | needs a target VPS |
| TASK-65 tunnel load and reconnect on VPS | **BLOCKED** | needs a target VPS |
| TASK-72 this review | satisfied by this file | — |

The blockers are environmental, not waivable. TASK-63 in particular is not
cosmetic: the staged artifact is exercised locally, but the claim that a *2 GB
Ubuntu 24.04* host starts the service and serves its static assets is a
different claim from the one the local runs support.

## AC2 — no critical/high finding, regression, missing asset, or failed gate

| condition | result |
|---|---|
| critical/high security findings | **0 remaining.** One HIGH found and fixed this pass (port-forward `destHost` SSRF). One reported HIGH refuted against source (`169.254.0.0/16` is blocked at `ssrf.ts:126`). |
| `npm audit --omit=dev` | **0 vulnerabilities** |
| full `npm audit` | **0 vulnerabilities** (after `deepmerge-ts 8.0.2`, `nanoid 3.3.19`, `js-yaml 4.3.2` overrides) |
| `npm run lint` | **0 errors**, 24 warnings (unchanged baseline) |
| `npm run typecheck` | exit 0 |
| `TURBO_DISABLE=true npm run build` | exit 0 |
| required artifact assets | present — `artifact-assets` 23/23 against the staged payload |
| browser / a11y gate | **12 suites, 597 assertions, 0 failed, 0 skipped**, `artifactCovered: true` |
| required VPS gates | **4 BLOCKED** — see AC1 |

### Local gate, all re-run after the last code change

```
version-check   0    typecheck        0    lint            0 (0 errors / 24 warnings)
ssrf            0    port-forward     0    forward-reconcile 0
port-allocation 0    xui              0    method-matrix   0
optimizations   0    tunnel-lifecycle 0
installer.sh    0 (41 passed)        docs contract    0
fa parity       0 (62 passed)        build            0
browser gate    0 (12 suites, 597 assertions)
audit --level=high  0
```

## AC3 — version, metadata, checksum, manifest, and both READMEs agree

| item | state |
|---|---|
| `README.md` ↔ `README_FA.md` | **agree** — 62/62 parity assertions, including the same pinned tag, same user-facing URLs, same architectures, same env vars, same method set, same nine operational commands |
| README ↔ code | **agree** — all 17 documented flags resolve to a real parser (16 in the shell scripts, `--reset-password` in `create-admin.mjs`); every documented file path exists |
| no duplicated prose | enforced by `test-release-docs.ts` §7, proven by a mutant |
| no real secret in either README | 6 patterns × both documents, 0 matches |
| **package version ↔ documented release** | **MISMATCH — this is the second blocker** |

### The version mismatch, stated plainly

`apps/web/src/lib/version.ts` and `package.json` both read **`1.1.2`**. Both
READMEs, the release contract, and the PRD describe the release as **`1.2.0`**.

This was left deliberately: bumping the version is a release action, and per the
user's standing constraint, no commit/tag/publish happens until every gate
passes. Publishing 1.2.0 documentation against a 1.1.2 tree is exactly the drift
these checks exist to catch. It is the correct state for a pre-release worktree
and it must be corrected **as the last step of the release**, not before.

## AC4 — what was tested, what passed, what was unavailable

**Tested and passing on this host (Windows 11, Node v26.7.0, npm 11.x):**

- all nine tunnel methods, plus the method matrix and lifecycle suites
- SSRF/private-network guard — 116 assertions including the new forward guard
- auth, origin/CSRF, telemetry, artifact staging and asset presence
- 12 browser + accessibility suites against both the source tree and the
  staged standalone artifact — 597 assertions
- installer suite 41/41 against the real shell sources
- documentation contract and English/Persian parity
- resource budgets, benchmark harness, sanitization of benchmark output
- dependency audit, static secret scan, CI workflow audit

**Not available, therefore not claimed:**

- installer execution on a real Ubuntu 22.04 host (TASK-62)
- service startup, `/api/health`, and static-asset serving on Ubuntu 24.04 (TASK-63)
- update / rollback / migration on a live host (TASK-64)
- sustained tunnel load and reconnect behaviour on a live host (TASK-65)
- peak CPU and memory trend on the 2 GB production host
- any live penetration test, systemd-unit hardening review, or
  `/opt/xistance` + `/var/lib/xistance` permission audit

**Explicitly *not* asserted:**

That local evidence substitutes for target-host evidence. The 1 vCPU / 961 MB
figures in the README come from a cgroup simulation, not from the production
host. The benchmark result in `.agent/evidence/task-57-*` is
`win32-x64-16vcpu` — it is honest about being Windows data, and the resource gate
exits 3 rather than comparing across incomparable hosts.

## Exact next actions

1. **Provide an Ubuntu 22.04/24.04 amd64 host** with root SSH access, so
   TASK-62 → TASK-65 can run. All four have working local harnesses; they need a
   target, not more code.
2. Run the installer end to end, then the 24.04 startup/health/static-asset
   check, then the update/rollback cycle, then tunnel load and reconnect.
3. Re-run `TURBO_DISABLE=true npm run build`, the installer suite, the browser
   gate, and `npm audit --audit-level=high` on that host, and capture the output
   as `task-62`…`task-65` evidence.
4. Bump `1.1.2` → `1.2.0` via `node scripts/version.mjs minor`, re-run
   `version:check`, the docs contract, and the parity check.
5. Commit, tag `v1.2.0`, and publish — only after step 4 is green.

**Until step 1 happens, this release is NO-GO.** The remaining four gates are
the ones that decide whether a real user can install and run this on a real
server, and none of them can be simulated into passing.
