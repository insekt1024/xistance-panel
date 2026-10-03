# TASK-72 — Final gate decision (v11)

Date: 2026-09-30
Supersedes: `task-72-final-gate-decision-v6.md` (which itself superseded v2)
Companion: `task-72-udp-bind-and-sidecar-defects.md` (the two defects fixed in this
stretch, with mutation results and target-OS proof)

## Verdict

**All 51 suites pass, the browser gate passes on the staged payload, and the
archive that was just rebuilt installs and runs correctly on Ubuntu 22.04.5 with
systemd as PID 1.**

No commit, tag, push, or public release was created. `HEAD` is `8e366d8` and
the tree is dirty by design (212 changed paths: the user's pre-existing work
plus this session's).

## What was fixed in this stretch

Two real defects, both found by running the real thing rather than trusting a
local gate:

1. **UDP upstream sockets were never bound.** `socket.send()` without a prior
   `bind()` let the OS pick the local port; on Windows that can be an
   *excluded* range (`EACCES`), and the per-flow error handler is a deliberate
   no-op, so the failure was swallowed — the flow was recorded as established,
   every packet for that client vanished, and the tunnel still reported healthy.
   Fixed in both `forwarder.ts` and `forwarder-runner.ts` with a retrying
   explicit-bind helper. The helper is duplicated in the worker on purpose: that
   module must import nothing but node builtins so `node
   --experimental-strip-types` can run it, and a relative `./forwarder.js`
   specifier cannot resolve to `.ts`. An earlier attempt that imported it broke
   the selftest entirely.

2. **The sha256 sidecar had a trailing blank line.** `renderChecksumFile()`
   already ends with `\n` and the CLI printed it with `console.log`, adding a
   second. 102 bytes instead of 101. The digest was correct, so every assertion
   that parsed it passed; only real `sha256sum -c` on the target reported
   `WARNING: 1 line is improperly formatted`.

## Non-vacuity

Every repaired assertion was mutation-tested. Mutants were verified to be on
disk before the suite was trusted, and the clean file was restored afterwards.

| Mutant | Result |
| --- | --- |
| `forwarder.ts` reverted to unbound `send()` | killed (31/1) |
| helper present but resolving without `bind()` | killed (31/1) |
| `release-manifest.ts` reverted to `console.log` | killed |

One assertion was **written, shown to survive, and deleted**: a "crowded
ephemeral range" test for the UDP fix. Reproducing the bug needs a port that is
*excluded from binding*, which requires administrative rights; holding other
ports open does not produce it. A test that cannot fail is worse than no test,
so it was removed and replaced with a direct assertion of the invariant
(helper exists, helper binds, no socket sent from without an intervening
`bind()`), which both mutants kill.

## Gate results

| Gate | Result |
| --- | --- |
| `npx tsx scripts/run-all-tests.ts` | **51/51**, `RESULT: PASS` |
| browser gate `npm run test:browser -- --all` | **12/12 suites, 0 skipped**, artifact payload exercised, verdict `.agent/tmp-smoke/gate-muo1vh2i/verdict.json` |
| `npm run version:check` | 7/7 files match `1.2.0` |
| `npm run typecheck` | 0 errors |
| `npm run lint` | 0 errors, 23 warnings |
| `npm audit` | 0 vulnerabilities |
| `test-release-installer.sh` | 52/52 |
| `test-supply-chain.ts` | 55/55, 8/8 digest slots populated |
| `test-readme-fa-parity.ts` | 66/66 |
| `test-real-binary-evidence.ts` | 127/127, 8/9 methods |
| `test-release-docs.ts`, `test-verify-artifact.ts` | pass |

## Archive

| Field | Value |
| --- | --- |
| path | `dist/amd64/xistance-panel-v1.2.0-amd64.tar.gz` |
| bytes | 40,921,390 |
| entries | 2,404 |
| sha256 | `6c2be9cd0ecadc6c5561d00a3872693824b9ddd9921f1a7a04674816d6318a65` |
| sidecar | 101 bytes, one line, real `sha256sum -c` → `OK`, no warning |
| payload tree digest | `d48d63f418c3a4d604d64cec85ac3f3d600e129709fef5669c5cad0e19bb2bcc` (identical in root, staged, and archived manifests) |
| archive vs staging | `diff -rq` → **0 differing entries** |
| embedded manifest | `1.2.0` / `amd64` / prisma `6.19.3` |
| staged file count (inspect) | 1,989 |

One ordering trap worth recording: an early archive was created **two seconds
before staging finished**, so it captured the previous payload — and produced a
byte-identical archive to the pre-fix one, which is what exposed it. Compare
mtimes of build → stage → archive, and confirm a distinctive string from the
fix is present *inside the archive*, not merely in the working tree.

A delayed notification then re-ran the whole build → manifest → restage
sequence after the archive already existed. The **payload tree digest moved
from `41f3f680…` to `d48d63f4…`** even though the archive bytes did not change,
because the digest is recomputed over a freshly rebuilt tree. Root manifest,
staged manifest, and archived manifest all agree on `d48d63f4…`, and
`diff -rq` between the extracted archive and `dist/artifact` reports **0
differing entries**, so the archive still corresponds exactly to what is
staged. The earlier `41f3f680…` figure is superseded.

**The digest is a derived value; the archive's own bytes are the thing that is
published.** When a digest you recorded changes while the artifact's checksum
does not, re-verify equivalence (extract and `diff -rq` against the staging
tree) rather than assuming either a defect or a no-op. Both the tree digest and
the archive checksum are legitimate, and they answer different questions.

## Target-OS proof (Ubuntu 22.04.5 LTS, x86_64, systemd PID 1)

Clean container from `xt-target:22.04`, signed NodeSource Node `v22.23.3`,
installed with the real `scripts/release-install.sh --version v1.2.0 --archive …`:

| Check | Result |
| --- | --- |
| `sha256sum -c` | `OK`, no warning |
| tamper control (append bytes, keep original sidecar) | `FAILED`, exit 1 |
| restored archive | `OK`, exit 0 |
| installer exit | **0** |
| service | `active`, `enabled` |
| pointer | `/opt/xistance/releases/v1.2.0` |
| process cwd | `/opt/xistance/releases/v1.2.0/apps/web` |
| `/api/health` | `200` `{"ok":true,"status":"healthy","version":"1.2.0"}` |
| `/api/nodes` unauthenticated | `401` |
| every static asset referenced by `/login` | **12/12 → 200** |
| `/en/login`, `/fa/login` | `200`, `200` |
| `xt-rollback` with the installer temp dir removed | resolves, prints usage |
| shipped worker contains the bound-socket fix | present |

## Real-binary evidence: 8 of 9 methods

GOST, FRP, XRAY, BACKHAUL, SSH, DIRECT, PORT_FORWARD, REVERSE have real
target-OS traffic plus reconnect proof. **XUI executes no tunnel binary** — it
is metadata/status integration for a 3x-ui panel, and the ledger records that as
a design fact in its `reason` field rather than as a shortfall.

REVERSE is proven against a real `sshd`, but the `ssh` client and `sshd` are on
the same target node. That proves the product's exact `ssh -R` argv and byte
path, **not** a distinct foreign host.

## Known gaps, stated plainly

- **REVERSE cross-host is unproven.** Applying `GatewayPorts clientspecified`
  and standing up a second authorized SSH topology both need approval that was
  not granted, so the restricted case (`GatewayPorts no`, the Debian/Ubuntu
  default) remains untested on the target. The product already detects that
  condition and reports degraded rather than falsely healthy.
- **arm64 is unbuilt.** Only `amd64` was staged, inspected, archived, and
  installed. The workflow is a matrix and `release-manifest.ts` takes
  `--architecture arm64`, but no arm64 cell was executed.
- **Task JSON step flags are incomplete**: 60 of 303 are `pass: true`. The work
  is backed by executed suites and evidence files, not by mechanically
  maintained flags, and the flags were not back-filled to make the number look
  better.
- **A live post-fix password-reset run on the target was not executed** (it
  needs approval). The wrong documented database path was reproduced verbatim,
  corrected in both READMEs, and bound to the installer's own value by a test,
  but the corrected command was not re-run on the target.
- **Privileged Docker results are exact-OS/systemd container evidence**, not
  remote-VPS evidence. They are labelled that way throughout.
- No credential, token, password, key, or connection detail appears in any
  evidence file or in this summary.

## Housekeeping

Removed 8 untracked `scripts/mutate-*.ts` mutation harnesses left from earlier
in this session. No reference to them remained. All 73 task JSONs now resolve
every `.agent/evidence/*.md` path they cite — four were pointing at filenames
that do not exist (`low-resource-budgets.md`, `vps-tunnel-load.md`,
`local-gates.md`, `browser-a11y.md`) while the real evidence existed under other
names; the pointers were corrected to the actual files.
