# TASK-67 — English README updated to match the shipped 1.2.0 release

## Verdict: all five criteria met. Three real defects found and fixed, one of
## which turned out to be a two-language defect.

I compared `README.md` against the actual implementation rather than reading it
for plausibility: every documented installer flag was checked against the shell
script that parses it, every documented file path against the filesystem, every
documented command against the repo, and the version against the release
contract.

---

## Defect 1 — a paragraph duplicated verbatim (rendering stutter)

`README.md` lines 189–193 contained the same two-line paragraph twice, back to
back, with a blank line between:

```
Release directories are immutable and reproducible from the artifact; only
`/var/lib/xistance` (database, logs, tunnel binaries) needs backing up.

Release directories are immutable and reproducible from the artifact; only
`/var/lib/xistance` (database, logs, tunnel binaries) needs backing up.
```

A copy-paste or bad-merge artifact. It is invisible to every other check in
`test-release-docs.ts` because the duplicated text still satisfies each
requirement — a check that greps for "does the README mention the data
directory" passes just as well twice as once.

Fixed by deleting the second copy, and `test-release-docs.ts` now asserts
against this class of defect (see below).

## Defect 2 — the update example pointed at a version that does not exist

The "Updating" section said:

```bash
sudo bash /tmp/xistance-release-install.sh --version v1.2.1
```

`v1.2.1` is not a released tag. The repository is at `1.1.2`; the release being
prepared is `1.2.0`. A reader following the update instructions literally would
get a 404 from the release URL — the exact failure the pinned-tag design exists
to make visible rather than silent.

Rewritten to name the current release and state the rule that makes the command
safe: there is no floating `latest`, so an update is the same audited command as
the first install.

## Defect 3 — the same defect in Persian

After fixing the English file, `test-readme-fa-parity.ts` failed 2 of 62:

```
FAIL no version in README_FA is absent from README.md — v1.2.1
FAIL both documents name the release version — v1.2.0 v1.2.1
```

`README_FA.md` carried the identical `v1.2.1` update example. The parity check
earned its place immediately: the English fix exposed a second instance of a
defect that a single-language review would have missed. Fixed in Persian with
matching prose (the no-floating-`latest` rule and the `--dry-run` hint).

## New check: duplicated prose

`scripts/test-release-docs.ts` section 7 now fails on a repeated prose line or
a repeated multi-line paragraph, in either README. Scoping matters here — the
first version produced two false positives:

```
README.md repeats the same sentence on lines 86, 289: "curl -fsSL https://raw.githubusercontent…"
README.md repeats the same sentence on lines 104, 175: "sudo bash /tmp/xistance-release-install.sh --version v1.2.0…"
```

Both repeats are *correct*: the bootstrap `curl` legitimately appears in both
the recommended artifact path and the source-build path, and the pinned install
command appears in the one-liner and again under "Updating". A duplicated
command is documentation; a duplicated sentence is a stutter. The check now
excludes lines that carry a shell verb, a URL, or a flag, and paragraph blocks
made entirely of such lines.

**Non-vacuity:** re-inserting the original duplicate makes the suite exit 1 with
all three diagnostics — both repeated lines and the paragraph. Reverted and
byte-compared. `test-release-docs.ts` is green on clean source.

## AC1 — identity, version, requirements

| claim | README says | source says | |
|---|---|---|---|
| release | `v1.2.0` | PRD + release contract | ✅ |
| OS | Ubuntu 22.04, 24.04 | `release-install.sh` OS gate | ✅ |
| arch | `amd64`, `arm64` | `release-install.sh` arch map; other archs refused, not guessed | ✅ |
| runtime | Node.js 22+, plus `curl`/`tar` | no `npm ci`, no `next build`, no compiler | ✅ |

The README states explicitly that an unsupported architecture is refused rather
than guessed, which matches the script's behaviour rather than describing an
aspiration.

## AC2 — pinned install command, checksum and provenance

- The one-liner uses `--release --version v1.2.0`; `--release` selects the
  prebuilt path and `--version` pins the tag. The README explains that **both**
  are required and that there is no floating `latest`.
- The verbose alternative fetches the three real shell files at the pinned tag
  (`release-install.sh`, `lib/release-layout.sh`, `lib/service-unit.sh`) — all
  three exist.
- Checksum: `sha256sum --check …tar.gz.sha256`, matching what the installer
  performs, plus `npx tsx scripts/verify-artifact.ts` (file exists).
- Provenance: `gh attestation verify …`, and the README is careful to say an
  attestation proves *where and by which workflow* the artifact was built, not
  that the code is safe.

**All 17 documented flags were checked against the scripts that parse them.**
16 resolve to a real parser. The 17th, `--reset-password`, belongs to
`create-admin.mjs` — confirmed present in `scripts/create-admin.mjs` and
parsed there — so it is documented truthfully, not invented.

## AC3 — all nine methods, truthful status semantics

The method table lists Reverse, Direct, Backhaul, FRP, GOST, SSH, Xray,
X-UI/3X-UI, and Port Forwarding — nine.

The status semantics are the part worth reading closely. The README documents
the **reverse-tunnel degraded case**: OpenSSH binds a reverse-forwarded port to
`127.0.0.1` and says nothing, so the `ssh` process stays alive and the port
*is* listening — a naive check would call that tunnel healthy. The panel probes
the foreign host and reports **degraded** with the reason and the
`GatewayPorts clientspecified` fix attached. That is the "truthful status"
requirement, stated as the specific failure mode it prevents rather than as a
claim that statuses are accurate.

## AC4 — low-RAM, backup/restore, update/rollback, troubleshooting, checks

- **Low-resource:** measured figures (health ~21 ms, login ~39 ms, ~117 MB RSS
  on a 1 vCPU / 961 MB host) and the reason it fits — no `npm` process at all
  during install.
- **Backup/restore:** the `tar` of `/var/lib/xistance`, and — the substantive
  part — an explicit explanation that the in-app export is **not** the same
  thing. A filesystem backup stores node credentials as ciphertext, but a
  *tunnel config cannot be encrypted that way* because the engine must hand the
  token to a process at start time, so the export masks those fields with `***`.
  The trade-off is stated rather than hidden: a restored backup keeps tunnel
  structure, not tunnel credentials, and a `tar` remains the complete backup.
- **Update/rollback:** `xt_activate_release` for rollback (the installer really
  does install that command), and the update path now names a real tag.
- **Troubleshooting:** four concrete symptoms with causes — systemd `path is
  not absolute` (quoted `EnvironmentFile`/`WorkingDirectory`), `set: pipefail:
  invalid option name` (CRLF in the downloaded script), `database: unreachable`
  (migrations did not apply), and 401 with the correct password (admin row
  missing or reset).
- **Browser/API checks:** `curl -s http://127.0.0.1:8080/api/health` appears in
  the rollback and install flows, and the "Daily use" section ends at the
  dashboard.

## AC5 — no source-build-on-VPS claim, no real secret

Six secret patterns scanned the full document for JWT-shaped triples, private
key blocks, bearer tokens, connection strings with passwords, `KEY=value`
assignments, and email+password pairs: **0 matches**. The only credentials shown
are `'YOUR_NEW_PASSWORD'` (a placeholder in the recovery command) and
`you@example.com`.

On the source-build claim: the README's *recommended* path is the prebuilt
artifact, and the two literal matches for "no `npm ci`, no `next build`" are the
sentence that **denies** a build happens. The source-checkout alternative is
presented under its own heading, explicitly framed as needing more RAM and time,
and never as the recommended server path. The Low-resource section states the
consequence plainly: a source build on such a host is what previously ran the
machine out of memory.

## Verification

| check | result |
|---|---|
| `npx tsx scripts/test-release-docs.ts` | exit 0 |
| `npx tsx scripts/test-readme-fa-parity.ts` | 62 passed, 0 failed, exit 0 |
| duplicate-paragraph mutant | exit 1, 3 diagnostics, reverted byte-identical |
| Persian version-drift mutant (`v1.2.0`→`v3.3.3`) | exit 1, 2 diagnostics, reverted byte-identical |

## What this does not prove

The README's claims are verified against the *code in this tree*. The measured
low-resource figures come from a cgroup simulation on a Linux host, not from the
1 vCPU / 961 MB production host, and the install/rollback/update flows have not
been executed end to end on Ubuntu — TASK-61 through TASK-65 remain open for
exactly that reason. A document can be internally consistent with code that has
never run on its target.
