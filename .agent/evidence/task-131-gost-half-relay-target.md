# TASK-131 — GOST accepted a half relay target: it listened, and refused every connection

## The defect

`GostConfigSchema` declared **both** `forwardHost` and `forwardPort` as
`.optional()`, and `listenerTarget()` in `packages/tunnel-core/src/config/gost.ts`
papered over that with `?? ""`:

```ts
function listenerTarget(cfg: GostConfig): string {
  return `${cfg.forwardHost ?? ""}:${cfg.forwardPort ?? ""}`;   // -> ":"
}
```

So a config with a cleared forward host and no port was schema-valid, was accepted
by `POST /api/tunnels` (which validates through `TunnelConfigSchema`), and was
stored — building the listener token:

```
["gost", "-L", "tcp://:9000/:"]          is a valid host:port? false
```

**The important part is what gost does with it.** It does not reject the malformed
token. Measured on the real target OS (`xt24`, gost v2):

```
route.go:700:  tcp://:19099 on [::]:19099
forward.go:109: [tcp] 127.0.0.1:11514 - 127.0.0.1:19099
forward.go:137: [tcp] 127.0.0.1:11514 -> 127.0.0.1:19099 : dial tcp :0: connect: connection refused
```

The empty port becomes `:0`. gost **starts, binds the listener, reports itself
running, and accepts every inbound connection — then refuses all of them.** So the
tunnel looked healthy in the UI and carried nothing. This is the failure mode the
whole evidence ledger is supposed to prevent: a "started" tunnel with no traffic.

## The fix, in two layers

**1. Schema** (`packages/types/src/index.ts`) — the pair is now required, and the
host is held to the same bare-address rule DIRECT and REVERSE already use:

```ts
forwardHost: hostLikeAddress,
forwardPort: z.number().int().min(1).max(65535),
```

`hostLikeAddress` had to be moved above `GostConfigSchema` — it is a `const` arrow,
so referencing it from above raised `TS2448` / `TS2454` (TDZ). Both the API and the
wizard validate through this schema, so one change covers both entry points.

**2. Builder** (`config/gost.ts`) — the `?? ""` fallbacks are gone. `listenerTarget`
now throws with a named diagnostic if either half is missing, so a caller that
bypasses the schema still cannot get a half-address token. `buildGostForwardArgs`
now returns `string`/`number` instead of `| undefined`, and the mirrored side's
`?? "127.0.0.1"` host fallback is no longer reachable.

### A stale build output hid the second half of this

After tightening the schema, typecheck still reported two errors in `gost.ts`:
`Type 'string | undefined' is not assignable to type 'string'`. The source was
correct — `packages/types/dist/index.d.ts` still carried the **old** optional
shape:

```
before build:  forwardHost: z.ZodOptional<z.ZodString>;   forwardHost?: string
after  build:  forwardHost: string;                        forwardHost: string
```

`tunnel-core` consumes `@xistance/types` through its compiled output, so a schema
change is invisible to typecheck until `npm run build:packages` runs. Worth
remembering: after any schema edit, rebuild the packages before trusting a type
error — or the absence of one.

## Gates added (`scripts/test-xray.ts`)

| assertion | mutation that must fail it |
| --- | --- |
| GOST rejects a blank `forwardHost` | pair made optional again → **4 fail** |
| GOST rejects a `forwardHost` with no `forwardPort` | ” |
| GOST rejects a `forwardPort` with no `forwardHost` | ” |
| GOST rejects a `forwardHost` carrying a scheme | ” |
| `buildGostCommand` refuses a half relay target (bypassed schema) | `?? ""` fallbacks restored |
| GOST still accepts a complete target and builds `tcp://:9000/origin.example:80` | positive control |

The mutation was run: reverting `forwardHost`/`forwardPort` to optional makes
**4 of 6** fail (48 passed, 4 failed). The two survivors are correct — the
positive control must still pass under a loosened schema, and the
defence-in-depth assertion tests the builder, not the schema.

## Wizard

`tunnel-wizard.tsx` already refused a blank `forwardHost` at submit, and defaulted
`forwardPort` to `80` — but its port check was `if (gost.forwardPort && !isPort(...))`,
which a cleared field satisfies vacuously. The schema now makes that a
non-issue: the wizard's own payload has to satisfy the same required pair.

## Results

| check | result |
| --- | --- |
| `scripts/test-xray.ts` | **53 passed, 0 failed** |
| mutation (schema reverted to optional) | 4 failed — gate catches it |
| typecheck / lint | 0 errors |
| aggregate | 76/76, `RESULT: PASS` |