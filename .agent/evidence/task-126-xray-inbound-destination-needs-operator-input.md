# TASK-126 — XRAY: dokodemo-door cannot learn a destination, and TASK-65's PASS may not show it

> **SUPERSEDED in part — see `task-130-xray-followredirect-fixed.md`.**
>
> The two items below were open when this was written. Both are now closed:
>
> 1. **`followRedirect: false` is a product defect, not a deployment quirk.** It was
>    fixed to `true` and verified in the shipped archive and in the running release
>    on both targets. The earlier assessment here that this "needs operator input"
>    was wrong: with `followRedirect: false` a dokodemo-door inbound with no
>    `address` can only dial its own listen port, so no operator configuration can
>    make it work.
> 2. **XRAY traffic and SIGKILL reconnect are now proven on the target OS** (19/19
>    traffic suite; `real-binary-evidence.json` marks `XRAY` reconnect `true`).
>
> Still true: the product does not install the REDIRECT itself. That prerequisite
> is now **documented** in `tunnels/examples/xray-vless.json` with the required
> `-m owner ! --uid-owner` scope. Making the product install host firewall rules
> remains a deployment-behaviour change that needs maintainer direction.


**Status: an open PRODUCT question, not a test failure. No code changed. This needs
the maintainer, because the answer determines whether XRAY works as shipped.**

## The mechanism, established by running it

`buildXrayConfig()` emits a `dokodemo-door` inbound with **no `address`**:

```json
{ "protocol": "dokodemo-door", "settings": { "network": "tcp,udp", "followRedirect": false },
  "sniffing": { "enabled": true, "destOverride": ["http","tls"] } }
```

`dokodemo-door` with no `address` takes its destination from the connection. Two
probes against the product's own generated config, on xt24:

| probe | client log | result |
| --- | --- | --- |
| `curl http://127.0.0.1:18082/` | `accepted tcp:127.0.0.1:18082` | dials **itself** |
| `curl --resolve origin.local:18082 ... -H 'Host: origin.local'` | server: `accepted tcp:origin.local:18082` | sniffing **works**, port still 18082 |

So `sniffing` overrides the **host** and is working exactly as designed. What it
does **not** do is supply a **port**: the request went to `origin.local:18082`, the
inbound's own port, not `origin.local:19098`.

With no `address` and no REDIRECT, **there is no configuration in which dokodemo
learns a different port from the connection.** Either the app's traffic arrives with
a destination the tunnel can read (sniffable host + the right port), or the operator
arranges the port some other way — and nothing in `packages/` does that.

## Why this puts TASK-65's XRAY result in question

TASK-65 recorded `traffic: HTTP/1.1 200 OK body=b'HELLO-XR' PASS` using the
product's own builder. Its own note (line 97) says the probe sent `Host: x` and xray
resolved it to `tcp:x:19098`:

```
accepted tcp:x:19098 [xistance-server-in >> direct]
```

**The port there is 19098 — the origin's port, not an inbound port.** For that to
happen with `followRedirect: false` and no REDIRECT, the probe must have connected
to a port that was *already* 19098, i.e. the origin directly. That would mean the
run proved the far-end inbound releases to freedom, but did **not** exercise the
product's `dokodemo-door` inbound or its `listenPort`.

**I have not verified this, and now I know I cannot from here.** Two dead ends,
both checked rather than assumed:

- `session_search` returns **0 sessions searched** — TASK-65 predates this
  conversation's history, so the probe is not recoverable that way.
- No in-repo artifact of the probe exists. Every `xray*`/`probe*` file in the tree is
  either the builder, its `dist/` copy, the shipped example, my generator, or
  Next.js internals. The probe lived in `/tmp` on a container that no longer exists.

### What the repo does contain

`scripts/test-xray.ts` asserts only config **shape** — that the inbound protocol is
`dokodemo-door`, that the port matches, that `streamSettings` is right. It never
starts xray and never moves a byte. So **no test in the repository exercises the XRAY
data path at all**, and the only claim that it does is TASK-65's evidence file.

That is the finding, and it stands on its own: the ledger entry
`XRAY … trafficCrossed: true` rests on a single hand-written probe that cannot be
re-run, and nothing in CI would catch a regression in it.

## What is proven, and what is not

| claim | status |
| --- | --- |
| GOST per-method reconnect | **proven** (3 runs, real SIGKILL + systemd) |
| XRAY tunnel carries bytes (with a REDIRECT I added) | proven, but that is not the shipped design |
| XRAY sniffing honours the Host header | **proven** |
| XRAY per-method reconnect | **not proven** |
| `buildXrayConfig()` correct as shipped | **unclear** — see above |
| TASK-65's XRAY PASS exercised the product inbound | **unverified** |

## What would settle it

1. Recreate TASK-65's probe exactly and check which port it connected to. If it was
   19098, the recorded evidence needs correcting.
2. Decide the intended XRAY deployment: either the inbound needs an explicit
   `address` (dokodemo then forwards everything to one fixed upstream — which is
   what `dokodemo-door` with `address` is FOR), or the panel must document that the
   operator supplies the REDIRECT. Right now the shipped example says only "local
   apps point at the dokodemo-door inbound", which cannot work as written for a
   destination on a different port.

I have **not** made either change: adding an `address` alters the method's
behaviour, and documenting an operator-side REDIRECT changes the install contract.
Both are product decisions.

## The scope is larger than XRAY — a permanent gate now reports it

The reproducibility check I added to `test-real-binary-evidence.ts` asks a
whole-ledger question, and the answer is not 1 method:

```
FAIL methods whose traffic is claimed have a RE-RUNNABLE data-path test
     7 traffic claim(s) rest on no runnable test: FRP, XRAY, BACKHAUL, SSH,
     DIRECT, PORT_FORWARD, REVERSE
```

**Only GOST is re-runnable today** — because I proved it on xt24 this session with a
harness that generates its config from the product's own builder and asserts its
precondition before measuring anything.

The other seven rest on TASK-65's probes, which lived in `/tmp` on containers that no
longer exist. `scripts/test-xray.ts` asserts config **shape** only; no test in the
repo starts a binary and moves bytes for those methods.

That is a real coverage hole in CI, not a bookkeeping nit: a regression in the
`BACKHAUL`, `FRP`, `SSH`, `DIRECT`, `PORT_FORWARD`, `REVERSE` or `XRAY` data paths
would not be caught by anything the aggregate runs. The PRD's
"100% of the nine methods have ... lifecycle ... evidence" is met by evidence
records; it is **not** met by runnable tests.

The suite now reports this on every run, so the gap is visible rather than assumed.
It is left failing on purpose — I am not going to make it green by widening the
allowlist.

### Closing it needs, per method

A target-OS harness that: generates the config via the product's own builder; asserts
its preconditions (origin up, binary present, ports free) BEFORE measuring; carries
real bytes through the real binary; and cleans up after itself. GOST's is the
template. That is a body of work, not a patch.
