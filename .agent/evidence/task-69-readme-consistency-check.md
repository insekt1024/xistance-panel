# TASK-69 — README command and version consistency check

## Verdict: all four criteria met, and proven non-vacuous by five mutations

`scripts/test-release-docs.ts` (186 lines) existed and exited 0. This pass
verified it actually enforces what it claims rather than agreeing with it from
reading.

## AC1 — reads real manifests, not hard-coded values

The check reads three files and derives expectations from them:

```ts
const read = (rel: string): string => readFileSync(path.join(repoRoot, rel), "utf8");
const readme    = read("README.md");
const readmeFa  = read("README_FA.md");
const installer = read("scripts/release-install.sh");
```

The flag check is the clearest case — it is *derived* from the installer's own
source rather than a frozen list:

```ts
for (const line of installerFlagLines) {
  for (const m of line.matchAll(/(?<![\w-])(--[a-z][a-z0-9-]*)/g)) documentedFlags.add(m[1]);
}
for (const flag of documentedFlags) {
  const accepted = new RegExp(`${flag}[=)\\s]`, "m").test(installer);
  check(accepted, `README.md passes ${flag} to release-install.sh, which does not accept it`);
}
```

Scope is deliberately narrow: only lines that actually invoke
`release-install.sh` are scanned, because the docs also pass flags to
`create-admin.mjs`, `bootstrap.sh`, and `git`, which are validated elsewhere.
That scoping is correct, not a loophole — proven by M2 below.

## AC2 — fails on all four required drift classes

Each was tested by mutating the README, running the check, and restoring.

| # | mutation | expected | actual | caught by |
|---|---|---|---|---|
| M1 | `--version v1.2.0` → `v9.9.9` on all 4 install lines | fail | **exit 1** | exact-tag pin |
| M2 | add `--not-a-real-flag` to a documented install line | fail | **exit 1** | flag-not-accepted |
| M3 | delete every `arm64` | fail | **exit 1** | supported architectures |
| M4 | delete `24.04` | fail | **exit 1** | supported Ubuntu releases |
| M5 | `--version latest` (floating pin) | fail | **exit 1** | exact-tag pin, explicit `--version latest` rejection |

M5's failure is the most useful: it names the offending line verbatim rather
than just failing.

Both languages are covered. `README_FA.md` is checked for the install command,
the exact version pin, the operational-model vocabulary, and — critically — its
tag is **compared against the English one** (`faTag` vs the English tag), so the
two cannot drift to different versions independently.

After every mutation, `README.md` was restored and `diff -q` against the backup
confirmed **byte-identical**. The suite returns to
`✅ Documentation contract: install command, flags, prerequisites, operations,
and both languages agree`.

## Two mutations of mine were wrong before the test was

Worth recording, because both initially looked like test failures.

- **M2 first attempt changed nothing.** I rewrote `--version v1.1.2` → added a
  flag, but the README pins **v1.2.0**, so the replace was a no-op. The check
  correctly passed — the file was unchanged. A mutation that does not apply
  produces a false "the test is weak" conclusion.
- **M3 first attempt did not remove what I thought.** I rewrote `arm64` →
  `ARM64PLACEHOLDER`, which still matches `/arm64/i`. The check correctly passed.
  Only a true removal fails it.

The lesson: before concluding a check is vacuous, confirm the mutation
actually changed the file. `assert s2 != s` plus a post-condition
(`'arm64' not in s2.lower()`) is what separated the two cases.

## AC3 — concise, actionable, no secrets

Failures name the artifact and the requirement, e.g.
`README.md must document the supported architectures`,
`the documented install must pin an exact version tag, found:\n<the line>`.
It reads repository files only — no environment variables, no network, no
credentials.

## AC4 — passes for the final documented release

Exit 0, with the Persian and English READMEs agreeing on version `v1.2.0`.

## One thing this does not prove

The check compares the READMEs against each other and against
`release-install.sh`. It does **not** verify that the tag `v1.2.0` actually
exists as a release, or that the artifact at that tag matches what the README
describes. Both READMEs are currently written for **1.2.0** while the repo is at
`1.1.2` — intentional, since the version bump is gated on the VPS runs
(TASK-62–65). The check is a consistency gate, not a publication gate.
