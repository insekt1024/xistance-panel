# TASK-122 — the ledger reconciler reports 73/73 and cannot see 47 tasks

**Status: gap confirmed and now gated. One readiness finding remains open by
design: the 47 ledger entries do not exist and I have not fabricated them.**

## The blind spot

`scripts/reconcile-task-ledger.py --check` runs in the aggregate and reports:

```
73/73 tasks evidence-backed, 0 dangling, 0 waivers
```

That number is **true and useless**. The reconciler enumerates:

```python
glob.glob(os.path.join(TASK_DIR, "TASK-*.json"))
```

so it can only describe tasks that already have a ledger file. A task with an
evidence file and **no** ledger entry is invisible to it by construction — the
count it prints can never fall below the number of files that exist, whatever the
real state of the work.

The ledger stops at **TASK-73**. The evidence directory runs to **TASK-121**.

| side | count |
| --- | --- |
| ledger entries | 73 (TASK-1..73) |
| distinct evidence ids | 116 |
| **evidenced but unledgered** | **47** (TASK-74..121) |

So 47 tasks — including all the release-critical work of TASK-89..112 and every
defect found in TASK-114..121 — were proven by evidence files that the reconciler
cannot see. **A ledger reconciled against itself proves it is internally tidy,
not that it describes the work.**

## The gate

`test-prd-success-metrics.ts` now enumerates from the **evidence side** and
compares, rather than trusting the reconciler's own count:

```
FAIL every task with an evidence file also has a ledger entry
     47 task(s) are evidenced but absent from the ledger: 74..121
```

Non-vacuity proven: moving `.agent/tasks/TASK-72.json` aside moves the count
47 -> 48 and the range from `74..121` to `72..121`. The check reacts to a real
absence.

## A second check, and two false positives it caused

The reverse direction is also gated — a ledger task whose declared `evidence`
cites a path that does not exist is a dangling claim. Getting it to stop crying
wolf took two corrections:

1. **Matching by task number was wrong.** My first version reported TASK-63 as
   unevidenced, but its `evidence` field cites
   `target-os-docker-available.md` and `task-72-final-gate-decision-v2.md` —
   neither carries "63" in the filename. A check that fails a correctly-cited task
   gets ignored, which is worse than no check.
2. **Then it reported a file that plainly exists.** The field mixes two forms —
   `.agent/evidence/target-os-docker-available.md` (repo-relative) and
   `task-72-final-gate-decision-v2.md` (bare filename). Resolving both against
   the repo root made TASK-63 cite a "missing" file that is right there in
   `.agent/evidence/`.

It now resolves a bare name against the evidence directory and a repo-relative
path against the repo root, and TASK-63 passes for the right reason. It also
skips tasks that declare no `evidence` at all (TASK-2/3/4 are procedural — their
deliverable is the repository itself), so it flags absence of a claim rather than
the absence of the claim itself.

## What is NOT done, deliberately

**I did not write 47 ledger entries.** Each would need a title, acceptance
criteria and steps reconstructed from evidence files — and a reconstructed
ledger is a *fabricated* one. It would convert a visible gap into an invented
record, which is the failure mode this whole task exists to prevent.

The gap is now **visible and enforced** instead of invisible. That is the honest
end state until someone authors the entries or retires the numbering.
