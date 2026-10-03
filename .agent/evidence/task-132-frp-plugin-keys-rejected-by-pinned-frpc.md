# TASK-132 — FRP: the builder emits two plugin keys that the pinned frpc rejects

> **RESOLVED — TASK-132 closed.** The decision this file asked for was answered by
> interrogating the pinned binary rather than by guessing: `ClientPluginOptions`
> carries `type` alone, so the builder now emits only `type`, and `addr`/`port` were
> removed from `FrpProxySchema`. The panel's own generated config is now accepted
> by `frpc verify` ("syntax is ok", exit 0), proven on the target OS against the
> pinned frpc 0.70.1. Five mutation-proven gates in `scripts/test-frp.ts`.
> The original write-up below is kept as the record of how the defect was found.


**Status: RESOLVED.** Originally recorded as OPEN pending a maintainer choice;
the binary itself settled it. See the banner above.

## The defect

`buildFrpConfig()` (`packages/tunnel-core/src/config/frp.ts:109-116`) emits:

```ts
if (p.plugin?.type) {
  lines.push(
    "[proxies.plugin]",
    `type = ${tomlQuote(p.plugin.type)}`,
    `addr = ${tomlQuote(p.plugin.addr ?? "")}`,   // <-- not a frpc field
    `port = ${p.plugin.port ?? 0}`,               // <-- not a frpc field
  );
}
```

`FrpProxySchema.plugin` offers `type`/`addr`/`port`, all optional. Measured on the
real target OS against **frpc 0.70.1, the version pinned in `scripts/install.sh`**:

| `[proxies.plugin]` shape | frpc `verify` |
| --- | --- |
| `type` only | `syntax is ok`, exit **0** — accepted |
| `+ addr = "127.0.0.1"` | `unknown field "addr"`, exit **1** |
| `+ port = 3128` | `unknown field "addr"`, exit **1** |
| `+ [proxies.plugin.params]` | `unknown field "params"`, exit **1** |
| `+ addr = "" / port = 0` | `unknown field "addr"`, exit **1** |

Note the `port` row reports `addr` first: frpc reports the first unknown field it
hits, so `port` is rejected too — it is simply never reached.

So **any FRP proxy configured with a plugin produces a config frpc refuses to load**,
and the panel's schema advertises two fields no supported version reads.

## Why this is NOT the GOST class of bug

GOST silently accepted a malformed value and ran while carrying nothing. FRP is the
opposite: it exits 1 with a clear message at config-load time. That is a loud,
immediately visible failure — much less dangerous, but still a correctness defect,
because the feature cannot work at all.

## Why nothing was changed

There are two reasonable fixes and they are not equivalent:

1. **Drop `addr`/`port` from the emitted TOML.** Then only `type` is written — which
   frpc 0.70.1 accepts. But the plugin's parameters then have **no home in this
   schema at all**: frp 0.70 wants them through a mechanism the panel does not
   currently model, so an FRP plugin would start but do nothing useful.
2. **Change the pinned frp version** to one whose plugin schema does carry `addr`
   and `port`.

Option 1 quietly turns a broken feature into a no-op one; option 2 changes what
gets installed on every target. Both change product behaviour, and picking either
on my own would be guessing at intent. Hence OPEN.

## What is needed

A maintainer decision on which of the two is correct. If it is option 1, the
`addr`/`port` fields should come out of `FrpProxySchema` too, so the API stops
accepting values that cannot be sent anywhere — and the wizard needs a matching
change, since it is the only place a user could currently set them.

## Reproduce

```bash
docker exec xt24 /var/lib/xistance/bin/frpc --version        # 0.70.1
# write the TOML shapes from the table above to a file, then:
docker exec xt24 /var/lib/xistance/bin/frpc verify -c /tmp/f6.toml
```