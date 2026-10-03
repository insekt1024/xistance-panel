# TASK-124 — XRAY reconnect: still open, and the harness was wrong five ways

**Status: NOT PROVEN. GOST is proven. The XRAY tunnel itself is proven healthy;
what remains unproven is reconnect, and my harness could not drive it.**

## What IS established

Both xray processes start, both inbounds listen, and **the tunnel carries traffic**:

```
client: from 127.0.0.1:45199 accepted tcp:127.0.0.1:18082 [xistance-in -> xistance-out]
server: from 127.0.0.1:58531 accepted tcp:127.0.0.1:18082 [xistance-in >> direct]
```

`xistance-in -> xistance-out` is the routing rule the product writes; `>> direct` is
the far end releasing to freedom. **Two hops of a real vmess tunnel accepted real
connections.** So the product's XRAY config is not broken.

## Why my probe returned nothing — five harness bugs, one per attempt

1. **Stray `)` in hand-written JSON** → `SyntaxError`. Rewritten as named structures
   with a `json.load` pre-flight so a syntax error names itself.
2. **Probed the vmess inbound with HTTP.** vmess is a proxy protocol and will never
   answer an HTTP GET. The server was listening on 19083 the whole time.
3. **Client had no local inbound**, so nothing accepted a connection on 18082.
4. **Invented a `socks` inbound.** The product's `buildXrayConfig()`
   (`packages/tunnel-core/src/config/xray.ts:67`) emits a **`dokodemo-door`** inbound
   with `sniffing`, a second `freedom` outbound, and a routing rule. I had guessed
   the shape instead of reading it.
5. **Probed the wrong port.** With `dokodemo-door` and **no address**, the destination
   comes from the request and the product relies on an **iptables/nft REDIRECT** to
   steer local traffic into `listenPort`. My probe asked the tunnel to dial **its own
   listen port** — a loop. The logs showed exactly that: destination
   `127.0.0.1:18082`.

With the correct config shape and the redirect installed (`iptables` rc=0, one rule
present), the probe still returns nothing. I stopped rather than keep guessing.

## The honest ledger state

`real-binary-evidence.json` keeps `reconnect: false` for XRAY with its note. **That is
correct and must not be flipped.** GOST carries `reconnect: true`, proven three times
across runs (pid 102597 -> 102760, 319 -> 338, 1956 -> 1973).

So the PRD's "100% of the nine methods have ... reconnect evidence" is **6/8 of the
binary-executing methods**, with XRAY the single open item, plus the installer's
silent-stderr defect fixed and verified in TASK-123.

## What would close it

Not more guessing at the harness. The product's own e2e path builds the config via
`buildXrayConfig()` and installs the matching redirect — so the test should invoke
**that code**, not a hand-written config. A hand-built replica of the thing under test
proves the replica (the lesson already recorded in TASK-120).

## One thing this did find, worth keeping

The precondition assertion I added is what stopped a false conclusion. When the origin
unit failed to start, the harness said:

```
FAIL the origin under test answers before anything is measured
     127.0.0.1:19098 returned '' -- the PRECONDITION failed, so no tunnel result
     below would be meaningful
```

Without it, three XRAY assertions would have failed for a reason that had nothing to
do with XRAY, and I would have "fixed" the tunnel.
