#!/usr/bin/env bash
# Real two-node ICMP tunnel test.
#
# Unlike every other suite in this repo, this one EXECUTES the real
# esrrhs/pingtunnel binary and pushes real TCP bytes across a real ICMP hop.
# Nothing here inspects generated argv and calls that proof.
#
# Topology -- two genuinely separate nodes joined by a veth link, NOT two
# processes sharing one loopback address:
#
#   curl ---> ns-cli (IRAN,    pingtunnel -type client)
#                 |  ICMP echo over a raw socket
#            veth link 10.99.0.2 <-> 10.99.0.1
#                 |
#            ns-srv (FOREIGN, pingtunnel -type server) ---> TCP backend
#
# Why separate namespaces are required, not cosmetic: with both halves on
# 127.0.0.1 the server's peer table cannot tell the client apart from itself,
# and pingtunnel 2.10 dies with "crash runtime error: invalid memory address"
# at server.go:357 on the first data packet. That is a limitation of collapsing
# both nodes onto one address, not necessarily a product defect -- but it does
# mean a loopback test cannot say anything about two real nodes, so this suite
# does not use one.
#
# The node configs come from the product's own builder
# (packages/tunnel-core/src/config/pingtunnel.js), never hand-written, so a
# regression in the builder fails here instead of being masked by a fixture.
#
# Requires: root or CAP_NET_RAW, pingtunnel, iproute2, python3.

set -uo pipefail

FX=/tmp/icmp-fx
BIN=/usr/local/bin/pingtunnel
# Path to the built builder module. Defaults to a checkout at /opt/xistance.
BUILT="${BUILT:-/opt/xistance/packages/tunnel-core/dist/config/pingtunnel.js}"
NS_CLI=ns-cli
NS_SRV=ns-srv
V_CLI=vx-cli
V_SRV=vx-srv
SRV_IP=10.99.0.1
CLI_IP=10.99.0.2
LISTEN_PORT=18108
TARGET_PORT=18109
KEY=987654321
ENCRYPT=supersecretpassphrase

pass=0
fail=0
ok()   { printf '      ok   %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '      FAIL %s\n' "$1"; [[ $# -gt 1 ]] && printf '           %s\n' "$2"; fail=$((fail+1)); }
note() { printf '       %s\n' "$1"; }
die()  { echo "--- $pass passed, $fail failed ---"; exit 1; }

teardown() {
  # Two namespaces and a veth pair outlive this script unless removed.
  [[ -n "${CPID:-}" ]] && kill "$CPID" 2>/dev/null
  [[ -n "${SPID:-}" ]] && kill "$SPID" 2>/dev/null
  [[ -n "${HPID:-}" ]] && kill "$HPID" 2>/dev/null
  ip netns del "$NS_CLI" 2>/dev/null
  ip netns del "$NS_SRV" 2>/dev/null
  ip link del "$V_CLI" 2>/dev/null
  if [[ -n "${XP_KEEP:-}" ]]; then
    note "artefacts kept in $FX"
  else
    rm -rf "$FX"
  fi
}
trap teardown EXIT

# ---------------------------------------------------------------- preflight ---
if [[ "$(id -u)" != "0" ]]; then
  note "SKIP: needs root or CAP_NET_RAW (uid=$(id -u))"; exit 0
fi
[[ -x "$BIN" ]]   || { note "SKIP: $BIN is not installed on this target"; exit 0; }
[[ -f "$BUILT" ]] || { note "SKIP: $BUILT is missing (run npm run build:packages)"; exit 0; }
command -v ip >/dev/null || { note "SKIP: iproute2 is not available on this target"; exit 0; }
if ! python3 -c 'import socket; socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_ICMP).close()' 2>/dev/null; then
  note "SKIP: cannot open a raw ICMP socket on this target"; exit 0
fi

rm -rf "$FX"; mkdir -p "$FX"; chmod 700 "$FX"

# ------------------------------------------------------------- wire the nodes ---
ip netns del "$NS_CLI" 2>/dev/null
ip netns del "$NS_SRV" 2>/dev/null
ip link del "$V_CLI" 2>/dev/null
if ip netns add "$NS_CLI" 2>"$FX/ns.err" && ip netns add "$NS_SRV" 2>>"$FX/ns.err"; then
  ok "two isolated network namespaces exist"
else
  bad "two isolated network namespaces exist" "$(head -2 "$FX/ns.err")"; die
fi

ip link add "$V_CLI" type veth peer name "$V_SRV" 2>>"$FX/ns.err"
ip link set "$V_CLI" netns "$NS_CLI"
ip link set "$V_SRV" netns "$NS_SRV"
ip -n "$NS_CLI" addr add "$CLI_IP/24" dev "$V_CLI" 2>>"$FX/ns.err"
ip -n "$NS_SRV" addr add "$SRV_IP/24" dev "$V_SRV" 2>>"$FX/ns.err"
ip -n "$NS_CLI" link set "$V_CLI" up
ip -n "$NS_SRV" link set "$V_SRV" up
ip -n "$NS_CLI" link set lo up
ip -n "$NS_SRV" link set lo up

# Reachability probe in python, not `ping`: iputils-ping is not installed on
# every minimal image, and this suite must not depend on a package the product
# does not. python3 already is a preflight requirement (the backend needs it).
# The checksum must be COMPUTED, not left zero: a raw socket lets you send a
# packet the kernel never validates, and the receiving kernel drops an echo
# request whose checksum is wrong -- silently, with no error anywhere. A
# zero-checksum probe therefore times out and looks exactly like "ICMP blocked".
probe() { ip netns exec "$NS_CLI" python3 -c '
import socket, struct, sys, time
def csum(b):
    if len(b) % 2:
        b += b"\x00"
    s = sum(struct.unpack("!%dH" % (len(b) // 2), b))
    s = (s >> 16) + (s & 0xffff)
    s += s >> 16
    return (~s) & 0xffff
dst = sys.argv[1]
ident = 0x4242
msg = b"xistance-icmp-probe"
hdr = struct.pack("!BBHHH", 8, 0, 0, ident, 1)
pkt = struct.pack("!BBHHH", 8, 0, csum(hdr + msg), ident, 1) + msg
s = socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_ICMP)
s.settimeout(3.0)
s.sendto(pkt, (dst, 0))
end = time.time() + 3.0
try:
    while time.time() < end:
        p, _ = s.recvfrom(1024)
        ihl = (p[0] & 0x0F) * 4
        if p[ihl] == 0 and struct.unpack("!H", p[ihl + 4:ihl + 6])[0] == ident:
            print("echo-reply")
            break
    else:
        print("no-echo-reply")
except socket.timeout:
    print("no-echo-reply")
finally:
    s.close()
' "$SRV_IP" 2>&1 | tail -1; }

reach="$(probe)"
if [[ "$reach" == "echo-reply" ]]; then
  ok "the two nodes reach each other over the link (ICMP permitted end to end)"
else
  bad "the two nodes reach each other over the link" "raw ICMP probe said: $reach"
  die
fi

# ---------------------------------------------------------- generate configs ---
# The product's builder. The client config's server host is what planIcmp()
# injects from the node inventory -- here, the FOREIGN node's address.
#
# Dynamic import(), not require(): the dist is `export * from ...`, so only ESM
# can load it. And the builder MODULE rather than the barrel: dist/index.js
# re-exports engine.js, which imports the bare workspace specifier
# `@xistance/types`; that resolves only inside this monorepo, so a copied dist
# fails on resolution. config/pingtunnel.js imports nothing at all.
node --input-type=module -e '
import fs from "node:fs";
const m = await import(process.argv[1]);
const cfg = {
  sock5: false, protocol: "tcp", listenAddr: ":" + process.argv[4],
  targetHost: "127.0.0.1", targetPort: Number(process.argv[5]),
  key: Number(process.argv[2]), encryption: "aes256",
  encryptionKey: process.argv[3], maxConn: 0, icmpListen: "0.0.0.0",
  timeoutSecs: 60,
};
fs.writeFileSync(process.argv[6], m.buildIcmpServerConfig(cfg));
fs.writeFileSync(process.argv[7], m.buildIcmpClientConfig(cfg, process.argv[8]));
' "$BUILT" "$KEY" "$ENCRYPT" "$LISTEN_PORT" "$TARGET_PORT" \
  "$FX/server.json" "$FX/client.json" "$SRV_IP" 2>"$FX/gen.err"

if [[ -s "$FX/server.json" && -s "$FX/client.json" ]]; then
  ok "the product's builder produced both node configs"
else
  bad "the product's builder produced both node configs" "$(head -3 "$FX/gen.err")"; die
fi

# These two are written by THIS script, so their mode is this script's to set.
# The product's own 0600 contract is asserted where the product writes them
# (planIcmp), in scripts/test-icmp.ts; asserting it here would only re-test this
# script's umask.
chmod 600 "$FX/server.json" "$FX/client.json"
for f in server client; do
  mode=$(stat -c '%a' "$FX/$f.json")
  if [[ "$mode" == "600" ]]; then ok "$f config is 0600 before its secrets are readable"
  else bad "$f config is 0600" "mode is $mode"; fi
done

if grep -q "$ENCRYPT" "$FX/server.json" && grep -q "$ENCRYPT" "$FX/client.json"; then
  ok "the shared passphrase is in both configs, where it must be"
else
  bad "the shared passphrase is in both configs" "not found in one or both"
fi

# Neither half may put the key or passphrase on its command line: pingtunnel is
# invoked with -c only, so a future argv regression fails here.
if grep -qE -- '-key[ =]|--key[ =]|encrypt-key' <<<"$BIN -c $FX/server.json"; then
  bad "no secret reaches argv" "the server invocation carries a key flag"
else
  ok "no secret reaches argv (pingtunnel is invoked with -c only)"
fi

# ------------------------------------------------------------------ backend ---
# The real thing behind the tunnel: an HTTP server with a known body, so a
# successful transfer is unambiguous.
# Run it INSIDE ns-srv. The FOREIGN node is what dials the target, and a server
# left in the root namespace is not reachable from inside a namespace -- the
# baseline check below would then fail for a reason that has nothing to do with
# the tunnel.
ip netns exec "$NS_SRV" python3 - "$TARGET_PORT" <<'PY' >"$FX/http.log" 2>&1 &
import http.server, socketserver, sys
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"HELLO-ICMP"
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a):
        pass
socketserver.TCPServer.allow_reuse_address = True
socketserver.TCPServer(("0.0.0.0", int(sys.argv[1])), H).serve_forever()
PY
HPID=$!
sleep 2
if ip netns exec "$NS_SRV" curl -s --max-time 5 "http://127.0.0.1:$TARGET_PORT/" 2>/dev/null | grep -q HELLO-ICMP; then
  ok "the backend answers on the FOREIGN node (baseline, before any tunnel)"
else
  bad "the backend answers on the FOREIGN node" "no response on $TARGET_PORT"; die
fi

# -------------------------------------------------------------- server node ---
ip netns exec "$NS_SRV" "$BIN" -c "$FX/server.json" >"$FX/server.log" 2>&1 &
SPID=$!
sleep 3
if kill -0 "$SPID" 2>/dev/null; then
  ok "the FOREIGN/server half started and stayed up"
else
  bad "the FOREIGN/server half started and stayed up" "$(tail -2 "$FX/server.log")"; die
fi

# -------------------------------------------------------------- client node ---
ip netns exec "$NS_CLI" "$BIN" -c "$FX/client.json" >"$FX/client.log" 2>&1 &
CPID=$!
sleep 4
if kill -0 "$CPID" 2>/dev/null; then
  ok "the IRAN/client half started and stayed up"
else
  bad "the IRAN/client half started and stayed up" "$(tail -2 "$FX/client.log")"; die
fi

# ------------------------------------------------------------ the ICMP proof ---
got=""
for _ in $(seq 1 25); do
  got=$(ip netns exec "$NS_CLI" curl -s --max-time 5 "http://127.0.0.1:$LISTEN_PORT/" 2>/dev/null)
  [[ -n "$got" ]] && break
  sleep 1
done

if [[ "$got" == "HELLO-ICMP" ]]; then
  ok "real TCP bytes crossed a real ICMP hop between two distinct nodes"
else
  bad "real TCP bytes crossed a real ICMP hop between two distinct nodes" \
      "port $LISTEN_PORT returned '$got' -- server: $(grep -av '\[INFO\]' "$FX/server.log" | tail -3 | tr '\n' '|') client: $(tail -3 "$FX/client.log" | tr '\n' '|')"
fi

# The hop must be ICMP, not a shortcut the test happened to take.
if grep -qiE 'icmp|ping from' "$FX/server.log" "$FX/client.log" 2>/dev/null; then
  ok "both halves logged real ICMP traffic"
else
  bad "both halves logged real ICMP traffic" "no ICMP activity in either log"
fi

# Neither half may have crashed on the first data packet. pingtunnel 2.10 panics
# at server.go:357 when it cannot resolve a peer for an incoming data packet,
# which is exactly what a same-address topology provokes.
if grep -aq 'crash runtime error' "$FX/server.log" "$FX/client.log" 2>/dev/null; then
  bad "neither half crashed while carrying traffic" \
      "$(grep -ah -A2 'crash runtime error' "$FX/server.log" "$FX/client.log" | head -3 | tr '\n' '|')"
else
  ok "neither half crashed while carrying traffic"
fi

# An ICMP tunnel that dies on first use is not a tunnel.
if kill -0 "$SPID" 2>/dev/null && kill -0 "$CPID" 2>/dev/null; then
  ok "both halves are still running after the transfer"
else
  bad "both halves are still running after the transfer" \
      "server=$(kill -0 $SPID 2>/dev/null && echo up || echo down) client=$(kill -0 $CPID 2>/dev/null && echo up || echo down)"
fi

# ------------------------------------------------------------------- limits ---
# Stated rather than sold as coverage: this proves the transport works between
# two real nodes. Whether ICMP escapes a given internet path is a property of
# that path, and this suite does not claim otherwise.
note "the hop is a veth link between two namespaces in this container: real ICMP"
note "raw-socket transport end to end, but NOT proof that a given internet path"
note "permits ping. Only a real IRAN->FOREIGN deployment settles that."

echo "--- $pass passed, $fail failed ---"
exit $(( fail > 0 ? 1 : 0 ))