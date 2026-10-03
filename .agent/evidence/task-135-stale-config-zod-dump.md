# TASK-135 — a stored config that no longer validates reached the UI as a 348-character Zod dump

## The defect

`loadTunnelConfig()` (`apps/web/src/lib/tunnels.ts`) re-validates every stored
config against `TunnelConfigSchema` on each deploy. That behaviour is **correct**
and I verified it is load-bearing: a row saved before a schema tightened cannot
produce a working tunnel, and the loader refuses it (verified for GOST, BACKHAUL
and SSH).

The defect is what it throws. A `ZodError`'s `.message` is a JSON dump of every
issue, and it travelled verbatim:

```
loadTunnelConfig -> buildDeploySpec -> engine.deploy
  -> catch (err) { results.push({ ok: false, error: (err as Error).message }) }
  -> JSON response -> the operator's UI
```

Measured for a GOST row saved before TASK-131 made the relay target required:

```
348 chars, beginning:
[ { "code": "invalid_type", "expected": "string", "received": "undefined",
    "path": [ "gost", "forwardHost" ], "message": "Required" }, { ...
```

So the tunnel is unstartable, and the only thing the operator is told is a schema
dump naming internal config paths.

This turn made the finding more likely, not less: every schema tightened since
TASK-131 creates a class of *previously-valid stored rows* that now fail this way.

## The fix

`loadTunnelConfig` now translates a schema failure into one sentence naming the
field, what is wrong with it, and the remedy:

```
This tunnel's stored configuration is no longer valid: "gost.forwardHost" is
missing. It was saved by an earlier version of the panel. Delete the tunnel and
create it again with the current fields.
```

A `describeIssue()` helper maps the Zod issue codes a stored row can actually
produce (`invalid_type`/undefined → "is missing", `unrecognized_keys` → "no longer
accepts", `too_small` on a string → "is empty", custom refine failures → "has a
value this version does not accept"). Anything unrecognised falls back to a
generic clause **rather than leaking the raw message** — the same fail-closed
instinct the GOST/SSH builder guards follow.

## Gates added (`scripts/test-secret-redaction.ts`)

Ten assertions across three stale-row shapes, each checking three properties:

| property | why it is load-bearing |
| --- | --- |
| refused, not silently repaired | the loader must keep failing closed |
| the message names the offending field | otherwise the operator cannot find it |
| the message reads as guidance, not a dump | no `"code":`, `"path":`, `invalid_type`, `ZodError`, or raw "must not contain"; under 260 chars |

Plus a positive control: a valid stored config still loads unchanged.

**Mutation:** `throw new Error(describeConfigProblem(e))` → `throw e` gives
**56 passed, 6 failed** — every one of the "reads as guidance" assertions, with
the fail-closed and field-naming assertions correctly unaffected, since those
properties come from the throw itself rather than its message.

Note the import had to be hoisted to module scope: the enclosing block is
synchronous, so `await import(...)` inside it was a transform error
(`"await" can only be used in an async function`). Caught by running the suite.

## Results

| check | result |
| --- | --- |
| `scripts/test-secret-redaction.ts` | **62 passed, 0 failed** |
| mutation (raw ZodError re-thrown) | 6 failed — gate catches it |
| leaked Zod internals across 3 shapes | 0 |
| typecheck / lint | 0 errors |