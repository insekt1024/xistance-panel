# TASK-108 — a re-activation erased the rollback history

**Status: fixed in `scripts/lib/release-layout.sh`, deployed to both targets,
proven by executing the rollback command. Drill now 22/22 (and 3/3 under load).**

## The defect

`xt_activate_release` recorded `previous` as the release that was current
*before* the switch:

```bash
previous="$(xt_current_release || true)"
...
xt_write_active_manifest "$safe" "$previous"
```

When the release being activated **is already the current one**, `previous` and
`active` are the same path, so the record becomes:

```json
{ "active": "/opt/xistance/releases/v1.2.0-20261001013933",
  "previous": "/opt/xistance/releases/v1.2.0-20261001013933" }
```

`previous` now names the active release, so the record no longer says where to
go back to. **The rollback path silently becomes one-way**: the release you would
roll back to is the one you are already on.

Reproduced on a real target by re-activating the current release:

```
before : {"active":".../v1.2.0-20261001013933","previous":".../v1.2.0-20261001013933"}
after  : {"active":".../v1.2.0-20261001013933","previous":".../v1.2.0-20261001013933"}
```

Re-activation is not a rare operator action. The installer re-installs, an
operator re-runs `xt-rollback` to confirm the target, and TASK-107's own drill
ends by restoring the shipping release — which is exactly a re-activation. Any of
those would have left the target with no way back.

## The fix

A re-activation must be a **no-op for the record**, because that is what it is:

```bash
local recorded_previous=""
if [[ -f "$XT_ACTIVE_MANIFEST" ]]; then
  recorded_previous="$(sed -n 's/.*"previous".../\1/p' "$XT_ACTIVE_MANIFEST" | head -1)"
fi
if [[ -n "$recorded_previous" && -d "$recorded_previous" && "$recorded_previous" != "$safe" ]]; then
  previous="$recorded_previous"          # keep the real history
elif [[ "$previous" == "$safe" ]]; then
  previous=""                            # nothing distinct to record
fi
```

Two cases, both correct:

- **Real switch** — the recorded `previous` is kept when it is a real directory
  distinct from the target, so history is never lost by a switch either.
- **Re-activation** — `previous` is left **empty** rather than self-referential.
  Empty is honest: there is no other release to go back to until a real switch
  happens, and the installer populates it then.

Verified on a real target, same reproduction as above:

```
before : {"active":".../v1.2.0-20261001013933","previous":".../v1.2.0-20261001013933"}
after  : {"active":".../v1.2.0-20261001013933","previous":""}
health : HTTP 200
```

`bash -n` clean; `test-release-layout.sh` 35/35.

## Two test bugs this exposed in my own drill

Both are worth recording because both produced *false confidence* rather than a
clear failure.

### A two-writer bug that only appeared on the second target

The suite writes a small Node helper to enumerate releases. I wrote it at module
scope **and** re-wrote it inside the per-target loop, the second write happening
*after* `docker cp`. So the first target got the good file and **every later
target silently got the previous run's**. Symptom: `found 0 release(s)` on `xt24`
only, with `xtinst` passing 10/10 in the same run.

**A defect that appears on the second iteration is almost always state carried
between iterations.** One writer, one artefact.

### The drill assumed a `previous` existed

After the fix, `previous` is legitimately empty on a target that has only ever
had one activation, and the drill reported `active-release.json has no previous`
and skipped. That is the drill skipping the very thing it exists to prove, on a
healthy target.

Fixed by making the drill perform a **real switch first** — activate a different,
real release, which populates `previous` — and only then drill. And the
reversibility assertion now accepts `previous` as *distinct or empty*, with the
failure message naming the TASK-108 bug explicitly when they are equal.

## Verification

| condition | result |
| --- | --- |
| `test-release-layout.sh` (unit) | **35/35** |
| `test-rollback-drill.ts` (real targets) | **22/22, exit 0** |
| same, 3 runs under 8 CPU burners | **22/22 each** |
| targets restored to the shipping payload | identity gate **5/5** |

The loaded runs are the meaningful ones: the original failure appeared only under
aggregate load, which is exactly when a re-activation and the assertions race.

## The lesson

**A "previous" pointer must never be allowed to equal "current".** It is a
self-referential value that looks valid, parses, and carries no information — and
its failure mode is not a crash but a capability quietly disappearing. Assert the
invariant, not just that the file is well-formed JSON: a record whose two fields
are equal is a bug even though every field is present and correctly typed.
