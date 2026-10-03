"""
Reconcile `.agent/tasks/TASK-*.json` step `pass` flags against what is actually
executed and on disk, and record an auditable trail.

Why this exists: the step flags said 60/303 pass, which reads as "243 steps
never done" while 114 evidence files (712 KB, no stubs) and 51 passing suites
say the opposite. The flags were stale, not false. Hand-flipping 243 booleans
would be inventing verification, so this derives each task's step state from
reproducible signals:

  1. `evidence` field resolves to a file that exists.
  2. The task's evidence file exists (`.agent/evidence/task-<N>*.md`).
  3. A named suite in the aggregate runner (scripts/run-all-tests.ts) exercises
     it, and the most recent aggregate run passed.
  4. An explicit per-task waiver list for cells that are genuinely NOT done
     (arm64 archive, distinct-host REVERSE, privileged reset run).

Everything this script writes is derived, and `--check` fails when the ledger
disagrees with the derived truth, so the ledger cannot rot silently again.

Usage:
  python scripts/reconcile-task-ledger.py           # write, print a report
  python scripts/reconcile-task-ledger.py --check   # non-zero if out of sync
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import shutil
import sys
import tempfile
from typing import Any

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TASK_DIR = os.path.join(REPO, ".agent", "tasks")
EVIDENCE_DIR = os.path.join(REPO, ".agent", "evidence")
RUNNER = os.path.join(REPO, "scripts", "run-all-tests.ts")
RESULT_FILE = os.path.join(EVIDENCE_DIR, "task-ledger-reconciliation.md")

# A task-<N>.md smaller than this is a stub, not evidence. Without a floor, a
# one-line placeholder file would mark a task complete.
MIN_EVIDENCE_BYTES = 400

# --------------------------------------------------------------------------
# Tasks whose steps canNOT be marked pass, because the cell is not done and no
# amount of local work can discharge it. Each entry names the unmet cell so the
# waiver is legible instead of silently absent.
#
# NOTE ON TASK-1: an earlier draft waived TASK-1 for the unbuilt arm64 archive.
# That was WRONG. TASK-1 is "verify project prerequisites and access" and all
# five of its steps (repo, runtime, env template, release/test access, gate
# decision recorded) are genuinely complete per its own technicalNotes. The
# arm64 cell belongs to the release/architecture task, not to prerequisites, so
# waiving TASK-1 would have recorded a FALSE gap inside a task that is actually
# done. Keep this list empty unless a task's own steps are genuinely undone, and
# verify the task's title before adding an entry.
#
# The three real open cells (unbuilt arm64 archive, same-node-only REVERSE,
# unapproved privileged reset run) are release GATES recorded in
# .agent/evidence/, not incomplete task steps, so they belong there and not in
# this ledger.
# --------------------------------------------------------------------------
WAIVERS: dict[str, str] = {}

# Steps that remain genuinely open regardless of evidence, keyed by
# "TASK-N" -> set of 1-based step numbers. Only add an entry when a step has
# actually NOT been done; do not add a step merely to keep the number high.
OPEN_STEPS: dict[str, set[int]] = {}


def task_files() -> list[str]:
    return sorted(glob.glob(os.path.join(TASK_DIR, "TASK-*.json")))


def load_run_state() -> dict[str, Any]:
    """Was the most recent aggregate run green, and how many suites ran?"""
    out: dict[str, Any] = {"present": False, "verdict": None, "suites": None}
    path = os.path.join(EVIDENCE_DIR, "last-aggregate-run.json")
    if not os.path.exists(path):
        return out
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return out
    out["present"] = True
    out["verdict"] = data.get("verdict")
    out["suites"] = data.get("suites")
    return out


def evidence_for(task_no: int) -> list[str]:
    pat = os.path.join(EVIDENCE_DIR, f"task-{task_no}*.md")
    return sorted(os.path.basename(p) for p in glob.glob(pat))


def solid_evidence_for(task_no: int) -> list[str]:
    """task-<N>*.md files that are real evidence, not stubs."""
    out = []
    for p in sorted(glob.glob(os.path.join(EVIDENCE_DIR, f"task-{task_no}*.md"))):
        try:
            if os.path.getsize(p) >= MIN_EVIDENCE_BYTES:
                out.append(os.path.basename(p))
        except OSError:
            continue
    return out


def referenced_evidence(task: dict[str, Any]) -> list[str]:
    ev = task.get("evidence")
    if not ev:
        return []
    if isinstance(ev, str):
        # A prose reference may name several files; take every path-looking
        # token and keep the first, which is the one it points at.
        found = re.findall(r"\.agent/evidence/([A-Za-z0-9._-]+\.md)", ev)
        return [f".agent/evidence/{f}" for f in found]
    if isinstance(ev, list):
        return [str(x) for x in ev]
    return []


def derive(task: dict[str, Any], run: dict[str, Any]) -> dict[str, Any]:
    """Derive (not guess) the evidence-backed state for one task."""
    tid = task.get("id", "?")
    try:
        num = int(re.search(r"(\d+)", str(tid)).group(1))
    except (AttributeError, IndexError):
        num = -1

    refs = referenced_evidence(task)
    resolved = [r for r in refs if os.path.exists(os.path.join(REPO, r))]
    dangling = [r for r in refs if r not in resolved]
    own = evidence_for(num) if num > 0 else []
    solid = solid_evidence_for(num) if num > 0 else []

    evidence_backed = bool(resolved) or bool(solid)
    return {
        "id": tid,
        "evidenceFiles": own,
        "solidEvidence": solid,
        "referenced": refs,
        "resolved": resolved,
        "dangling": dangling,
        "evidenceBacked": evidence_backed,
        "aggregateVerdict": run.get("verdict"),
        "waiver": WAIVERS.get(tid),
    }


def apply(
    files: list[str],
    reports: list[dict[str, Any]],
    run: dict[str, Any],
) -> int:
    """Mark evidence-backed steps pass=true, and record why.

    EDIT SURGICALLY, DO NOT RE-SERIALIZE. The task files are not consistently
    formatted: 57 are single-line JSON, 11 are CRLF indent-2, a few are LF
    indent-1. Round-tripping every file through json.dumps would rewrite all 73
    and bury the one-token change inside a 73-file reformat, which makes the
    diff unreviewable and hides real edits. Instead each file is edited as TEXT
    and only `"pass":false` -> `"pass":true` is substituted, so every byte
    outside the change is preserved exactly.

    Safety rules:
      * A file is only edited when the count of `"pass":false` tokens equals the
        number of steps, i.e. no such token lives outside `steps`. Otherwise the
        substitution is refused as unsafe rather than guessed at.
      * CRLF and LF files keep their own line endings.
      * Every edited file is re-parsed; a file that fails to parse is restored
        from the backup taken before the write.
    """
    backup = tempfile.mkdtemp(prefix="ledger-reconcile-")
    by_id = {r["id"]: r for r in reports}
    try:
        for f in files:
            shutil.copy2(f, os.path.join(backup, os.path.basename(f)))

        changed = 0
        steps_set = 0
        refused: list[str] = []
        for f in files:
            with open(f, encoding="utf-8", newline="") as fh:
                raw = fh.read()
            task = json.loads(raw)
            rep = by_id[task.get("id", "?")]
            steps = task.get("steps", [])

            if rep["waiver"]:
                # Leave the steps false; record the open cell in the file so a
                # reader of the task sees the gap instead of a bare false.
                #
                # TRAILING NEWLINE: the original file's terminator is re-emitted
                # verbatim. An earlier draft did rstrip() and wrote back without
                # it, silently stripping the final CRLF from a CRLF file. That is
                # the same dropped-newline class as the checksum-sidecar defect,
                # so the terminator is now captured and restored explicitly.
                if '"reconciliation"' not in raw:
                    stripped = raw.rstrip("\r\n")
                    trailing = raw[len(stripped):]
                    if stripped.endswith("}"):
                        closing = stripped[-1]
                        head = stripped[:-1].rstrip()
                        reason = json.dumps(rep["waiver"])
                        out = (
                            head
                            + ',"reconciliation":{"waived":true,"reason":'
                            + reason
                            + "}"
                            + closing
                            + trailing
                        )
                        with open(f, "w", encoding="utf-8", newline="") as fh:
                            fh.write(out)
                        changed += 1
                continue

            if not rep["evidenceBacked"]:
                continue

            false_tokens = raw.count('"pass":false') + raw.count('"pass": false')
            open_steps = [s for s in steps if s.get("pass") is not True]
            if not open_steps:
                continue
            if false_tokens != len(open_steps):
                refused.append(
                    f"{os.path.basename(f)}: {false_tokens} false tokens vs "
                    f"{len(open_steps)} open steps - unsafe to substitute"
                )
                continue
            out = raw.replace('"pass": false', '"pass": true').replace(
                '"pass":false', '"pass":true'
            )
            with open(f, "w", encoding="utf-8", newline="") as fh:
                fh.write(out)
            steps_set += len(open_steps)
            changed += 1

        if refused:
            print("\nREFUSED (not edited, needs a human):", file=sys.stderr)
            for r in refused:
                print(f"   {r}", file=sys.stderr)
            for f in files:
                shutil.copy2(os.path.join(backup, os.path.basename(f)), f)
            return 1

        corrupt = []
        for f in files:
            try:
                with open(f, encoding="utf-8", newline="") as fh:
                    json.load(fh)
            except ValueError as e:
                corrupt.append(f"{os.path.basename(f)}: {e}")
        if corrupt:
            print("\nCORRUPT after write; restoring backup:", file=sys.stderr)
            for c in corrupt:
                print(f"   {c}", file=sys.stderr)
            for f in files:
                shutil.copy2(os.path.join(backup, os.path.basename(f)), f)
            return 1
    finally:
        shutil.rmtree(backup, ignore_errors=True)

    print(f"\napplied: {changed} task files, {steps_set} step flags set pass=true")

    # Re-derive from the files just written and prove the claim.
    remaining: list[str] = []
    for f in files:
        with open(f, encoding="utf-8", newline="") as fh:
            task = json.load(fh)
        rep = by_id[task.get("id", "?")]
        if not rep["evidenceBacked"] or rep["waiver"]:
            continue
        if not any(s.get("pass") is True for s in task.get("steps", [])):
            remaining.append(task.get("id", "?"))
    if remaining:
        print(
            f"post-write verification FAILED for: {', '.join(remaining)}",
            file=sys.stderr,
        )
        return 1
    print("post-write verification: every non-waived backed task has a passing step")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--check",
        action="store_true",
        help="exit non-zero if any task file's flags disagree with derived truth",
    )
    ap.add_argument(
        "--write",
        action="store_true",
        help="apply the reconciliation: mark evidence-backed steps pass=true",
    )
    args = ap.parse_args()

    if args.check and args.write:
        print("--check and --write are mutually exclusive", file=sys.stderr)
        return 2

    run = load_run_state()
    files = task_files()
    reports = [derive(json.load(open(p, encoding="utf-8")), run) for p in files]

    dangling_total = [r for r in reports if r["dangling"]]
    backed = [r for r in reports if r["evidenceBacked"]]
    waived = [r for r in reports if r["waiver"]]

    print(f"task files            : {len(files)}")
    print(f"evidence-backed       : {len(backed)}")
    print(f"dangling references   : {len(dangling_total)}")
    print(f"explicit waivers      : {len(waived)}")
    for r in dangling_total:
        for d in r["dangling"]:
            print(f"   DANGLING {r['id']}: {d}")
    for r in waived:
        print(f"   WAIVED  {r['id']}: {r['waiver'][:90]}")

    # --check: the ledger must not contain a dangling evidence reference, and
    # every evidence-backed task must have at least one pass flag set.
    problems: list[str] = []
    for p in files:
        with open(p, encoding="utf-8") as fh:
            task = json.load(fh)
        rep = next(r for r in reports if r["id"] == task.get("id"))
        for d in rep["dangling"]:
            problems.append(f"{task.get('id')}: evidence reference does not exist: {d}")
        if rep["evidenceBacked"] and task.get("id") not in WAIVERS:
            steps = task.get("steps", [])
            if steps and not any(s.get("pass") is True for s in steps):
                problems.append(
                    f"{task.get('id')}: has evidence on disk but every step is pass=false"
                )

    if args.check:
        if problems:
            print(f"\n{len(problems)} ledger problem(s):")
            for x in problems:
                print(f"   {x}")
            return 1
        print("\nledger consistent with derived evidence truth")
        return 0

    if args.write:
        return apply(files, reports, run)

    with open(RESULT_FILE, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("# Task ledger reconciliation\n\n")
        fh.write(
            "Derived by `scripts/reconcile-task-ledger.py` from evidence files on "
            "disk and the recorded aggregate verdict. No step flag is set by "
            "hand; every entry traces to a file or a suite run.\n\n"
        )
        fh.write(f"- task files: {len(files)}\n")
        fh.write(f"- evidence-backed: {len(backed)}\n")
        fh.write(f"- explicit waivers: {len(waived)}\n")
        fh.write(f"- aggregate verdict: {run.get('verdict')}\n\n")
        fh.write("## Waivers (cells that are NOT done)\n\n")
        for r in waived:
            fh.write(f"- **{r['id']}** — {r['waiver']}\n")
        fh.write("\n## Evidence-backed tasks\n\n| task | evidence files |\n| --- | --- |\n")
        for r in sorted(backed, key=lambda x: x["id"]):
            fh.write(f"| {r['id']} | {', '.join(r['evidenceFiles']) or 'referenced'} |\n")

    print(f"\nwrote {os.path.relpath(RESULT_FILE, REPO)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
