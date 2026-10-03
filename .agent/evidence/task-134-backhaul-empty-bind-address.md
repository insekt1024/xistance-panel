# TASK-134 — BACKHAUL: an empty listen address produced a `bind_addr` the binary happily served

**Fourth instance of one class.** After TASK-130 (XRAY), TASK-131 (GOST) and
TASK-133 (SSH), the pattern is consistent: a field interpolated into a single
delimited argument is declared as free text, and the tunnel binary accepts the
malformed result instead of rejecting it.

## The defect

`BackhaulConfigSchema` declared both address fields as bare strings:

```ts
listenAddress: z.string().default("0.0.0.0"),
remoteHost:    z.string().optional(),
```

`buildBackhaulConfig()` splices `listenAddress` into:

```ts
`bind_addr = ${tomlQuote(`${cfg.listenAddress}:${cfg.listenPort}`)}`
```

Measured through the schema and builder:

| `listenAddress` | result |
| --- | --- |
| `0.0.0.0` (normal) | `bind_addr = "0.0.0.0:3080"` |
| `""` | **`bind_addr = ":3080"`** |
| `http://evil.example/` | `bind_addr = "http://evil.example/:3080"` |
| `0.0.0.0 extra` | `bind_addr = "0.0.0.0 extra:3080"` |
| `-oX` | `bind_addr = "-oX:3080"` |

All five were **accepted**.

## And backhaul does not reject it

On the real target OS, with the pinned binary
(`/var/lib/xistance/bin/backhaul`), running the config the builder would have
produced:

```
bind_addr = ":19098"
  -> listening on 19098: 1
  -> exec 3<>/dev/tcp/127.0.0.1/19098   CONNECTED
```

It **binds, listens, and accepts a client connection.** The tunnel reports itself
running while the operator's intended address was never honoured. Identical to the
GOST finding (TASK-131), where `dial tcp :0: connect: connection refused` came
after a successful bind.

Note `tomlQuote()` already existed in this file and already refused control
characters — it defends the *quoting*, not the *content*. `bind_addr` is one
quoted token, so quoting it correctly changes nothing about whether the address
inside it is valid.

## The fix

Both fields now use `hostLikeAddress`, the shared bare-address rule:

```ts
listenAddress: hostLikeAddress.default("0.0.0.0"),
remoteHost:    hostLikeAddress.optional(),
```

`remoteHost` **stays optional** — on the client side it is omitted by default and
falls back to `127.0.0.1`, which is a real address rather than a half one. Making
it required would break the legitimate single-node case; making it free text (as
it was) let anything through. A positive-control gate pins the loopback default.

## Gates added (`scripts/test-backhaul.ts`)

Seven new assertions: four hostile `listenAddress` values rejected, a delimiter in
the client's `remoteHost` rejected, plus two positive controls (the loopback
fallback still applies; a real bind still builds `bind_addr = "0.0.0.0:3080"`
unchanged).

**Mutation:** reverting both fields to `z.string()` → **41 passed, 5 failed**,
exactly the five rejection assertions. The two positive controls correctly stayed
green, since they do not depend on the tightened fields.

## A mistake I made and repaired

Hoisting `hostLikeAddress` above the schemas that use it (it is a `const` arrow,
so every schema above its declaration raised `TS2448`/`TS2454`) was done with a
script that walked backwards over "comment" lines and stopped **mid-block**,
truncating the `.refine()` call and orphaning its tail below the GOST banner. That
produced eight downstream type errors including a missing `TunnelMethod` export.

Caught by typecheck, repaired in place rather than by resetting the file — a reset
would have discarded the TASK-131 and TASK-133 fixes, which are not in git. The
lesson: a structural move computed by index arithmetic needs the *whole* block
located by a terminator match, not by "walk back while the line looks like a
comment".

## Results

| check | result |
| --- | --- |
| `scripts/test-backhaul.ts` | **46 passed, 0 failed** |
| mutation (fields reverted to `z.string()`) | 5 failed — gate catches it |
| `test-gost` / `test-ssh` / `test-reverse` / `test-direct` | 37 / 67 / 36 / 49, all green |
| typecheck | 0 errors |