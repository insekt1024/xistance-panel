# TASK-111 — the documented install was never checked against the code

**Status: gated by `scripts/test-documented-install-command.ts` (24/24, 3
readiness findings). The documented command was also executed for real.**

## The gap

TASK-18 asks for a version-pinned one-line install in both READMEs. The
documentation existed, and it was **correct** — but nothing tested that the
commands it prints would run. `test-readme-fa-parity.ts` compares the two
documents to each other; it never compares either of them to the installer.

A README can therefore drift from the code with every test in the repository
green, because the docs are prose and the tests read code.

## What the suite checks, against the real files

- both READMEs document the same commands (TASK-18 criterion 1)
- every documented URL is pinned to `v1.2.0` — no floating `latest`
- **every file the docs fetch exists at that tag** (tracked *and* committed)
- every such file is named by the command, with an explicit `-o` destination
- the documented flat `/tmp` layout is one the installer's resolution loop finds
- the resolution loop requires both libraries in the *same* directory, so the docs
  cannot silently split them
- the documented `--version` matches what the installer expects
- no real secret values in either README (TASK-18 criterion 5)

## The finding

All three files the documented command fetches are **untracked**:

```
✗ scripts/release-install.sh    is reachable at v1.2.0
✗ scripts/lib/release-layout.sh is reachable at v1.2.0
✗ scripts/lib/service-unit.sh   is reachable at v1.2.0
      UNTRACKED -- the documented curl would 404
```

Both READMEs fetch from `raw.githubusercontent.com/.../v1.2.0/...`. **No `v1.2.0`
tag exists and these files are in no commit**, so the documented command cannot
work yet. The failure a user would see is a `curl` **404**, which is easy to
misread as a network or DNS fault rather than as "this file was never committed".

That is the same hazard as TASK-109/110, now stated from the *user's* side rather
than the release engineer's.

## Two corrections made along the way

Both are recorded because both produced false confidence rather than a clean
failure.

### A wrong claim, caught by reading the docs

My first TASK-110 note asserted the one-line install "cannot work". **That was
wrong.** It came from grepping for a release-asset URL shape and concluding none
existed, without reading the README — which already fetches all three files from
the repo at the pinned tag, and which resolves correctly. The documented install
was then executed for real and passed (exit 0). The asset upload added in
TASK-110 is a **self-containment improvement, not a repair**. Both the evidence
file and `release-status.md` now say so.

### A regex that matched nothing, and a tally that hid a real failure

The suite's first version extracted **0** curl commands from both READMEs, because
the README mixes three command shapes (line-continued, `&&`-chained, piped) and
the pattern only handled one. Every downstream check — "is each file named by the
command?", "is each URL pinned?" — became **vacuously true**, and the suite would
have passed for a reason unrelated to the docs.

Two things caught it:

1. a **non-vacuity assertion** that the extraction really finds commands;
2. counting readiness findings per *file* while there was one failing *check* per
   file, so `fail - readinessFindings` left **2 real failures unaccounted for**
   and the suite exited 1 with `24 passed, 2 failed, 1 readiness finding`.

The second is the nastier bug: a subtractive tally can silently absorb genuine
failures. It now counts failing *checks*.

## Verification

| condition | expected | result |
| --- | --- | --- |
| unmodified tree | exit 0, findings only | **exit 0** — 24/0/3 |
| one documented URL unpinned to `latest` | exit 1 | **exit 1** — 22 passed, 2 failed, 3 findings |
| tree restored | exit 0 again | **exit 0** — 24/0/3 |

Plus the documented command itself, run for real on Ubuntu 22.04.5 (see TASK-110):
checksum verified, new versioned directory, migrations up to date, systemd unit
installed, `INSTALL EXIT: 0`, health 200, `nodes` 401, and `previous` recording a
**distinct** release — TASK-108's fix surviving an actual install.

## What this closes

The user-facing install contract is now tested against the code rather than
trusted. A future edit that unpins a URL, splits the libraries across
directories, or deletes a file from the repo will fail the aggregate.

## What it does not close

The three files must still be committed. Until then the documented command 404s,
and both this suite and `test-release-version-commit-parity.ts` report it as a
readiness finding on every run rather than letting it be discovered by a user.
