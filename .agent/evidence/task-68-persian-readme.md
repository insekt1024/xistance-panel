# TASK-68 — Persian README for the final release

## Verdict: all four criteria met. One real documentation gap found and closed.

`scripts/test-readme-fa-parity.ts` (new, 62 assertions) verifies AC1–AC4
mechanically. Reading the two documents side by side and agreeing they agree is
the exact failure mode this task exists to prevent, so the check compares token
sets in both directions.

---

## The one real gap: no RTL/direction guidance

AC3 requires "Persian UI direction/RTL guidance and troubleshooting are clear".
The Persian README had **none**. It documented the product correctly but never
told a reader what to expect from the layout or what to do about overflow.

Added a `### زبان و جهت رابط (RTL)` section before the troubleshooting table,
covering: the panel follows browser language; Persian applies right-to-left
layout with table columns and action buttons on the right while numbers and
paths stay left-to-right so addresses and commands are not mistyped; how to
force the locale via `/fa` and return via `/en`; and what to do about horizontal
overflow on a narrow window.

The check now asserts the direction guidance is present, and the assertion is
proven non-vacuous by deleting the section (see below).

## Nine assertions were wrong, not the document

The first run reported `27 passed, 13 failed`. Most failures were defects in the
test I had just written. Each was traced to the actual file content before
changing anything:

| reported failure | reality |
|---|---|
| "README_FA must document the Node.js runtime prerequisite" | FA says `Node.js ۲۲` — **Persian digits**. The regex was ASCII-only. |
| "…the Ubuntu 22.04 / 24.04" | FA heading: `اوبونتو ۲۲.۰۴ / ۲۴.۰۴` — Persian digits again. |
| "…the update path" | FA heading is `به‌روزرسانی`, with a ZWNJ. |
| "…states its direction" | **genuine gap**, fixed above. |
| "all nine method identifiers appear in README_FA" *and* "…in README.md" | Both docs fail identically — the docs write `Reverse`, `Direct`, `Xray`, and `انتقال پورت`, not the UPPER_SNAKE enum. Identical failure in both documents is not drift; the check was asserting a spelling the authors deliberately do not use. |
| "no encryption key value in README_FA — found: XTENC_KEY" | FA says "…only `XTENC_KEY` is needed to read it". That is the *name*, which is what documentation should contain. The pattern matched the name, not a value. |
| "no build-time env var leaks into either user README" | `TURBO_DISABLE` is a real env var the English README legitimately uses in its developer section. Excluding it was wrong. |
| "README_FA has no command the English README lacks" | It reported `bash sudo xt_activate_release /opt/xistance/releases/<تگ-قبلی>` — a *Persian placeholder* in a correct translation. A doc spelling a placeholder in Persian is not a defect. |
| "the two documents document a comparable number of code blocks — en 22 / fa 12" | EN carries a developer section (`npm run build`, `npx tsx`, standalone server) that has no place in a user guide. Equal length was the wrong requirement. |

Each fix is a comment explaining the trap, not just a looser regex. Two
examples worth stating plainly:

- Persian documents use Persian digits. A verification that only accepts ASCII
  digits reports a complete, correct Persian README as missing its runtime and
  OS support. Every numeric pattern now accepts both digit sets and the Persian
  decimal separator `٫` (U+066B) as well as the ASCII `.`.
- A variable NAME is documentation; a VALUE is a leak. The secret patterns now
  target the value side of an assignment, and a documentation placeholder
  (`YOUR_…`, `CHANGEME`, `<…>`) is recognised as such.

The URL comparison is scoped to **user-facing** URLs. The English README
additionally carries CI and shields.io badges, `http://localhost:3000`, a
`bootstrap.sh` curl in its developer section, and the `panel.example` hardening
example — none of which belong in a Persian user guide. The reverse direction
stays strict: a URL the Persian guide sends a reader to must exist in the English
source, or the Persian doc is inventing a destination.

## AC2 — identifiers, URLs, versions, env vars, architectures

All checked **bidirectionally**, because a Persian-only token is as much drift
as an English-only one — a command translated into something that does not exist
would pass a subset check.

| category | result |
|---|---|
| version tags | both documents name `v1.2.0`; no tag in either is absent from the other |
| user-facing URLs | identical sets; Persian invents none |
| architectures | `amd64` and `arm64` in both; Persian introduces none |
| env vars | `SUPER_ADMIN`, `XTENC_KEY`, `YOUR_NEW_PASSWORD` in both. `XT_ALLOWED_ORIGINS` / `XT_TRUST_PROXY` are English advanced-hardening table entries; the Persian guide is a walkthrough. **The omission is permitted but must be deliberate**: if the Persian doc does carry one, the check asserts it is the real var from the English list, not a guess. |
| tunnel methods | all nine identifiable in both, by enum or by the gloss the docs actually use |
| install/ops commands | nine required commands present in both: fetch installer, run installer, pin exact version, dry run, checksum verify, service control, backup tar, activate release, health check |
| code fences | balanced in both; Persian carries 12 of 22 blocks, above the half-floor |

## AC1 — the same operational contract

Present and confirmed in Persian: the release-install command, Node.js 22
prerequisite, Ubuntu ۲۲.۰۴ and ۲۴.۰۴, update path, rollback, backup, health
check, checksum verification, atomic cutover, and the static-assets note.

## AC3 — RTL guidance and troubleshooting

Direction guidance added (above). The troubleshooting table was already present
and is unchanged: systemd `path is not absolute`, installer CRLF
(`set: pipefail: invalid option name`), `database: unreachable` in
`/api/health`, and 401 on correct password.

## AC4 — no secrets, no contradiction

Seven secret patterns checked against the Persian document for **values**:
JWT secret, encryption key, bearer token, JWT-shaped triple, private-key block,
connection string, password. All absent. `XTENC_KEY` and `YOUR_NEW_PASSWORD`
appear only as names and placeholders.

No source-build-on-VPS contradiction: the release path documented is the pinned
installer, which is the point — the Persian README already explains that
building from source on the machine exhausted its memory.

## Non-vacuity

Three mutations, each restored and byte-compared afterwards:

| mutation | result |
|---|---|
| `v1.2.0` → `v9.9.9` | **exit 1** — version and URL parity both fail |
| remove `arm64` | **exit 1** — "both documents name amd64 and arm64" |
| delete the RTL guidance | **exit 1** — direction assertion fails |

Final: **62 passed, 0 failed**, exit 0. `test-release-docs.ts` re-run after
editing the Persian README: still green.

## One thing this does not prove

The check proves the two documents agree. It does not prove the Persian prose
*reads* well to a Persian speaker — that needs a human reader, and it is not
something a token comparison can substitute for. The technical accuracy of the
wording is unverified by machine.
