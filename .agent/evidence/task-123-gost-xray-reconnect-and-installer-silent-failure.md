# TASK-123 — GOST/XRAY reconnect gap closed for GOST; installer silent-failure fixed

**Status: one real product defect fixed and verified; one of two method proofs
completed; one blocked before it ran.**

## A PRD requirement was only 6/8 met

`PRD.md` §15 is explicit:

> 100% of the nine methods have configuration, lifecycle, error, cleanup, and
> resource/**reconnect** evidence.

`real-binary-evidence.json` had `reconnect: true` for BACKHAUL, FRP, SSH,
DIRECT, PORT_FORWARD and REVERSE — and **`false` for GOST and XRAY**, both noted
as "not re-proved per-method here". So two of the eight binary-executing methods
had no reconnect evidence.

## The binaries were not on the target

`gost` and `xray` are fetched from pinned digests by `scripts/install.sh` (only
`backhaul`, `frpc`, `frps` are vendored in `tunnels/bin/`). Installed on `xt24`
(Ubuntu 24.04.5, systemd as PID 1) with the project's own installer, `gost 2.12.0`
and `Xray 26.3.27`, both digest-verified.

## GOST — PROVEN

Real bytes, real SIGKILL, real systemd `Restart=on-failure`, and **the same request
succeeding again afterwards** — the command form the product's own
`buildGostCommand()` emits:

```
ok   GOST carries real bytes before the kill (body=HELLO-XR)
SIGKILLed gost pid=102597; waiting for Restart=on-failure
ok   GOST recovered: new pid=102760 and the SAME request succeeded again
after:  HELLO-XR
```

Reproduced across two runs (pid 102578 -> 102597, then 102597 -> 102760).

## XRAY — NOT YET PROVEN

Three attempts, all my own test-harness errors, not product failures:

1. A stray `)` in hand-written JSON → `SyntaxError`. Rewritten as named
   structures with a pre-flight `json.load` so a syntax error names itself.
2. Probing the **vmess inbound** with HTTP. vmess is a proxy protocol; it will
   never answer an HTTP GET. The server *was* listening on 19083 the whole time —
   the probe was wrong, not the tunnel.
3. The client had only a vmess **outbound**, so nothing accepted a local
   connection on 18082. It needs a socks inbound that the probe goes through.

The corrected harness is written but the run that would confirm it was blocked, and
I did not retry. **So the ledger still says `reconnect: false` for XRAY, and that
is the honest current state.**

## A REAL PRODUCT DEFECT: the installer died silently

Running `install.sh --yes` on a target where port 8080 was already serving the
panel produced:

```
exit=1
STDERR:
(end stderr)
```

**Exit 1 with completely empty stderr.** A `bash -x` trace stopped dead at `+ exec`
with nothing after it.

The cause:

```bash
exec 3>&- 2>/dev/null || true
die "Port 8080 is already in use. Pick another with --port."
```

`exec` with redirections replaces the shell's **own** descriptors permanently. So
fd 2 became `/dev/null` for the rest of the script, and the very next line — the
error a user needs most — was written into a black hole. Fixed by closing fd 3 in a
subshell, `(exec 3>&-) 2>/dev/null || true`, so the shell's stderr is untouched.

Verified against the same busy port:

```
exit=1
✗ Port 8080 is already in use. Pick another with --port.
   پورت 8080 اشغال است.
```

Both languages present. The bilingual promise in the PRD is only worth something
if the error actually reaches the user.

## The lesson, which is the same one as TASK-117

`die()` was correct. The code around it was correct. The **reaching** of the error
was broken, and only running the installer on a machine where its precondition
failed exposed it. A unit test of `die()` would have passed forever.

## Current honest state

| item | status |
| --- | --- |
| GOST per-method reconnect | **proven** |
| XRAY per-method reconnect | **not proven** — harness fixed, run blocked |
| installer error reporting | **fixed and verified** |
| both targets serving | yes, health 200 |
