# ICMP — a real ICMP tunnel, executed between two real nodes

**Result: 14 passed, 0 failed, on 3 consecutive runs.**
Suite: `scripts/test-real-icmp-tunnel.sh`, executed on `xt24`
(Ubuntu 24.04.5 LTS x86_64, uid 0, `CAP_NET_RAW`).

This is the only tunnel method whose proof involves a raw socket. Everything
below was observed, not inferred.

## Topology

Two network namespaces joined by a veth link — not two processes sharing one
loopback address:

```
curl ---> ns-cli (IRAN,    pingtunnel -type client)
              |  ICMP echo, raw socket
         veth 10.99.0.2 <-> 10.99.0.1
              |
         ns-srv (FOREIGN, pingtunnel -type server) ---> TCP backend
```

The separate namespaces are **required**, not cosmetic. With both halves on
`127.0.0.1` the server's peer table cannot distinguish the client from itself,
and pingtunnel 2.10 dies on the first data packet:

```
[ERROR] crash runtime error: invalid memory address or nil pointer dereference
  github.com/esrrhs/pingtunnel.(*Server).processDataPacket
    /home/runner/work/pingtunnel/pingtunnel/server.go:357
```

That is a limitation of collapsing both nodes onto one address. It is also why a
loopback test cannot speak to two real nodes, so this suite does not use one.

## What crossed

`HELLO-ICMP` — real TCP bytes from a real HTTP backend, carried inside ICMP echo
packets across the veth link. The baseline is measured too: the backend is
confirmed reachable on the FOREIGN node *before* either half starts, so a pass
cannot come from a shortcut the test happened to take.

## Checks (14)

1. two isolated network namespaces exist
2. the two nodes reach each other over the link (ICMP permitted end to end)
3. the product's builder produced both node configs
4. `server.json` is 0600 before its secrets are readable
5. `client.json` is 0600 before its secrets are readable
6. the shared passphrase is in both configs, where it must be
7. no secret reaches argv (pingtunnel is invoked with `-c` only)
8. the backend answers on the FOREIGN node (baseline, before any tunnel)
9. the FOREIGN/server half started and stayed up
10. the IRAN/client half started and stayed up
11. **real TCP bytes crossed a real ICMP hop between two distinct nodes**
12. both halves logged real ICMP traffic
13. neither half crashed while carrying traffic
14. both halves are still running after the transfer

## Non-vacuity

Removing the client half — no ICMP bridge at all — fails the transfer check:

```
FAIL real TCP bytes crossed a real ICMP hop between two distinct nodes
--- 12 passed, 2 failed ---
```

Restoring it returns 14/14. The pass therefore depends on the tunnel existing.

## Two upstream details this audit settled

- **UDP is real**, and there is no `-udp` flag. `server.go` dials `tcp` when
  `Tcpmode > 0` and `udp` otherwise, so `-tcp 0` is how UDP is requested.
- **SOCKS5 is set to `tcp=1` explicitly.** SOCKS5 is a TCP control protocol and
  upstream's USAGE.md says `-sock5 1` "automatically enables TCP", so the builder
  states it rather than relying on that.

  **Correction to what I first claimed here.** I wrote that omitting `tcp` "would
  silently put a SOCKS5 tunnel on the datagram path". Executing it says otherwise:
  with `tcp` removed from the SOCKS5 config, pingtunnel 2.10 **still served a
  SOCKS5 request over TCP** (`test-real-icmp-modes.sh`: the proxy carried a
  request to a loopback-only backend, only the config assertion failed, 11/12).
  So the line is belt-and-braces that pins intent against a stricter future
  upstream, not a fix for an observed failure. The assertion stays.

  A related process note: the first mutation run appeared to SURVIVE, which was a
  harness defect, not a result — `docker cp` of a `dist` directory nests a second
  copy instead of replacing it, so the container kept a stale build (mtime hours
  old). After replacing the directory and confirming the mtime moved, the mutation
  failed as expected. A surviving mutant is a reason to distrust the harness.

## The systemd half — `scripts/test-icmp-systemd-unit.sh`

The two-node suite starts both halves from an interactive root shell, so it
never touches the unit file the panel actually writes. That leaves one specific
risk untested: `User=root` in the generated unit is what lets `pingtunnel` open
its raw ICMP socket. A unit that lost that privilege would start, log an EPERM,
and fail at runtime with every other test still green.

So the unit is written exactly as `buildUnit()` emits it and started for real on
`xt24`: **4 passed, 0 failed.**

1. the generated unit starts and stays active
2. the unit runs pingtunnel as root, which is what allows the raw socket
3. pingtunnel opened its raw ICMP socket with no permission error
4. the unit log shows pingtunnel reached `Server start`

Non-vacuous: mutating `User=root` to `User=nobody` fails it.

One test defect found and fixed here: the check originally read
`journalctl -u <unit> -n 40`, but the journal is cumulative per unit *name*, so a
permission error from an earlier run was attributed to a clean rerun — a green
build reported a failure it did not have. The suite now rotates and vacuums the
unit's journal immediately before `systemctl start`.

## Limits — stated, not papered over

- The hop is a veth link inside one container. This proves ICMP raw-socket
  transport end to end between two real nodes. It does **not** prove that a given
  internet path permits ping; only a real IRAN→FOREIGN deployment settles that.
- Untested here: the FOREIGN node's raw-socket privilege setup as systemd would
  grant it (root vs `CAP_NET_RAW`), SOCKS5 mode, and UDP forwarding.
- Reconnect is **not** claimed: this suite proves one continuous transfer, not
  recovery after a restart.
- The **installer download path was not exercised end to end**. `xt24` reached
  `github.com` but timed out mid-transfer on the 3.7 MB asset
  (`curl: (28)`, 931 KB of 3 674 152 received) and has no `unzip`. What *is*
  proven: the pinned URL resolves (HTTP 200) from the host, and the sha256 of
  the real `2.10` `pingtunnel_linux_amd64.zip` downloaded from upstream
  (`2a4902f6…05a897`) equals the value pinned in `scripts/install.sh`.
  `scripts/test-release-installer.sh` additionally asserts the pinned branch
  names a concrete version and never resolves a floating one (64/64).

  To close this: run `scripts/install.sh` on a host with working egress, or
  pre-stage the two zips and install offline.
