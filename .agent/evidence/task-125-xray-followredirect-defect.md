# TASK-125 — XRAY reconnect: the 'defect' was my harness, not the product

> **SUPERSEDED.** Both 'defects' below were artifacts of testing with an
> iptables REDIRECT that the product never installs. `tunnels/examples/xray-vless.json`
> states the design: *"Local apps point at the dokodemo-door inbound (port 10808)"*.
> No REDIRECT, so `followRedirect: false` is correct. **The product config is not
> defective and I changed nothing.** The read below is kept because the reasoning
> error is the point.

**Status: root cause identified by evidence, A/B confirmation blocked by a Docker
outage. The XRAY reconnect ledger entry is still `false` and must stay so.**

## The finding

`buildXrayConfig()` in `packages/tunnel-core/src/config/xray.ts:75` emits:

```json
"settings": { "network": "tcp,udp", "followRedirect": false }
```

The inbound is `dokodemo-door` with **no `address`**, so the destination is taken
from the incoming connection. Steering a local app's traffic into `listenPort` is
done by an **iptables REDIRECT**, which rewrites the destination port in the kernel:

```
iptables -t nat -A OUTPUT -p tcp --dport 19098 -j REDIRECT --to-port 18082
```

With `followRedirect: false`, xray uses the **post-redirect** destination — `18082`,
its own listen port. So dokodemo-door dials *itself*. Both ends' logs name it
exactly:

```
client: from 127.0.0.1:36687 accepted tcp:127.0.0.1:18082 [xistance-in -> xistance-out]
server: from 127.0.0.1:35529 accepted tcp:127.0.0.1:18082 [xistance-in >> direct]
```

`tcp:127.0.0.1:18082` is the tunnel's own port, and `curl` returns `http=000`.

The rule **does** match (`iptables -t nat -L OUTPUT -n -v` shows 1 packet, 60 bytes),
so this is not a namespace or loopback-netfilter problem: traffic reaches the tunnel
and dies inside it.

`followRedirect: true` makes xray read `SO_ORIGINAL_DST` and recover the real
destination. `.agent/evidence/tmp/xray-client-fr.json` is the A/B variant.

## What the A/B actually showed — and why it was about MY setup, not the product

### Finding A (NOT a product defect): `followRedirect: false` + REDIRECT = self-dial

With the product's own config and a REDIRECT, both ends logged the destination as
the tunnel's own listen port:

```
client: accepted tcp:127.0.0.1:18082 [xistance-in -> xistance-out]
server: accepted tcp:127.0.0.1:18082 [xistance-in >> direct]
```

The rule matched (`iptables -t nat -L OUTPUT -n -v` -> 1 packet, 60 bytes), so the
packet reached the tunnel. `18082` IS `listenPort`: with `followRedirect: false`
xray uses the POST-redirect destination instead of recovering the original with
`SO_ORIGINAL_DST`, so `dokodemo-door` dialed itself.

Flipping only that flag changed the logged destination, which is the proof:

```
followRedirect: false  ->  accepted tcp:127.0.0.1:18082   (loop)
followRedirect: true   ->  accepted tcp:127.0.0.1:19098   (the real origin)
```

### Finding B (a harness bug): my REDIRECT captured the tunnel's own traffic

With defect 1 fixed, `curl` still returned 000. Cause: my rule was

```
iptables -t nat -A OUTPUT -p tcp --dport 19098 -j REDIRECT --to-port 18082
```

`OUTPUT` matches **every locally originated** connection to 19098 -- including the
one xray's far end makes when it releases to freedom. So the origin's response was
redirected straight back into the tunnel. No `followRedirect` value can fix that;
the rule's SCOPE is wrong. Production scopes it to the local app:

```
-m owner ! --uid-owner xistance
```

### Result — and why it does not indict the product

```
--- redirect ONLY non-xray traffic (production-shaped) ---
HELLO-XR
  http=200
```

Real bytes crossed the product's own generated config. **But only after I added an
iptables REDIRECT that the product does not install.** The shipped example says the
deployment is:

```
app -> 127.0.0.1:10808 (dokodemo) -> [vmess/vless outbound] -> upstream 3X-UI panel
```

The app asks for its real destination; dokodemo forwards that. Nothing redirects, so
`followRedirect` is irrelevant — and `false` is the right value for that design.

So the loop I "found" only exists in a deployment I invented. `buildXrayConfig()` is
correct as shipped.

### What is still NOT established

**XRAY per-method reconnect is still unproven.** This run proves the tunnel carries
traffic with the corrected redirect shape; it does not SIGKILL the client and show
systemd recovering it. The ledger keeps `reconnect: false` for XRAY, correctly.

**No product change has been made, and none should be.** `followRedirect: true` would
have been a wrong "fix" for a problem that existed only in my harness — and it would
have been wrong in the way that matters: it would have looked like progress.

### What is still open, and it is only this

**XRAY per-method reconnect is unproven**, and the correct way to test it is to drive
the tunnel the way the shipped example describes: a client that connects to
`listenPort` and requests the ORIGIN as its destination — no REDIRECT at all. My
harness never did that, because I kept installing one.

That is the next test to write, and it needs the origin on a port the client names in
its own request, which `curl --socks5` cannot express against a dokodemo inbound
without an HTTP `CONNECT`-shaped request. It is a harness-design problem, not a
product one.

## This is the same shape as TASK-123's installer defect

`die()` was fine; the *reaching* of the error was broken. Here `dokodemo-door` is
fine and `followRedirect: false` is a coherent choice — it is wrong **only** in
combination with a REDIRECT-based deployment. Neither file is defective alone. A
unit test of `buildXrayConfig()` would assert the JSON shape, pass forever, and say
nothing about where the bytes end up.

## How the test now generates its config

`scripts/gen-xray-test-config.ts` calls `buildXrayConfig()` itself after parsing
through the real `XrayConfigSchema`, so the config under test is byte-identical to
the shipped one. It printed exactly the product's shape:

```
inbound protocol : dokodemo-door
sniffing         : {'enabled': True, 'destOverride': ['http', 'tls']}
outbounds        : ['vmess', 'freedom']
routing rule     : ['xistance-in'] -> xistance-out
```

This replaces the hand-written replica that burned five attempts in TASK-124. **A
replica of the code under test proves the replica** — the same lesson already
recorded, learned twice.

## Current honest state

| item | status |
| --- | --- |
| GOST per-method reconnect | proven (3 runs) |
| XRAY tunnel carries traffic | proven (both hops accept connections) |
| XRAY `followRedirect` root cause | **hypothesis with a prepared A/B**, blocked |
| XRAY per-method reconnect | **not proven** |
| targets | **unreachable — Docker Desktop is down** |

## To resume

1. Start Docker Desktop; confirm `xtinst` and `xt24` come up and report health 200.
2. Run the `followRedirect: true` A/B. If the body is `HELLO-XR` and the server log
   shows `tcp:127.0.0.1:19098`, the hypothesis is confirmed.
3. Then decide the fix in `buildXrayConfig()` — and it needs its own review, because
   flipping it changes behaviour for every deployment that does NOT use REDIRECT.

## Update — the root cause is evidence-backed; only the A/B is missing

The xray logs name the destination, and it is the tunnel's own listen port:

```
client: from 127.0.0.1:36687 accepted tcp:127.0.0.1:18082 [xistance-in -> xistance-out]
server: from 127.0.0.1:35529 accepted tcp:127.0.0.1:18082 [xistance-in >> direct]
```

`18082` IS `listenPort`. And the REDIRECT rule **does** match:

```
$ iptables -t nat -L OUTPUT -n -v      # after one probe
      1    60 REDIRECT   6  --  *  *  0.0.0.0/0  0.0.0.0/0  tcp dpt:19098 redir ports 18082
```

So this is **not** a namespace or loopback-netfilter problem, and not a dead tunnel:
the packet is rewritten, accepted by the tunnel, and the tunnel then dials the port
it is listening on. That is a loop, and it is exactly what `followRedirect: false`
produces when the destination is supplied by a REDIRECT — xray uses the post-redirect
value rather than recovering the original with `SO_ORIGINAL_DST`.

So: **cause identified from logs and packet counters. The A/B that would confirm it
did not run**, because Docker Desktop stopped first.

## Gate added meanwhile (local, does not need Docker)

`test-real-binary-evidence.ts` is now 132 assertions, and two pin this area:

- the XRAY test config is generated by the product's own `buildXrayConfig()`;
- the inbound is `dokodemo-door` **and states its `followRedirect` choice
  explicitly**.

Neither asserts `followRedirect: true`. That would be writing an unverified change
into the product on the strength of a blocked experiment — and flipping it alters
behaviour for every deployment that does **not** use REDIRECT. When the A/B runs,
that decision gets its own review.

## Resume steps

1. Start Docker Desktop; confirm `xtinst`/`xt24` come up and report health 200.
2. Run `docker cp .agent/evidence/tmp/xray-client-fr.json xt24:/tmp/` then the A/B.
   Confirm on both: the body is `HELLO-XR`, and the server log shows
   `tcp:127.0.0.1:19098` instead of `18082`.
3. Only then change `buildXrayConfig()`.
4. Re-run `test-real-binary-evidence.ts` and the aggregate, then flip the XRAY
   `reconnect` entry in the ledger **with** the reconnect note, not before.
