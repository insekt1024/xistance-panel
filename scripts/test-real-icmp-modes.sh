#!/usr/bin/env bash
# Real two-node ICMP tests for the two transport modes the forward-mode suite
# does not cover: SOCKS5 proxy mode, and UDP forwarding.
#
# Same topology and same discipline as test-real-icmp-tunnel.sh -- two network
# namespaces over a veth link, configs from the product's own builders, and a
# baseline measured BEFORE either half starts -- but a different claim:
#
#   forward mode : "connect to this host:port and reach one fixed target"
#   SOCKS5 mode  : "connect to this proxy and reach ANY target the proxy can see"
#   UDP mode     : "this is a datagram path, not a stream"
#
# SOCKS5 matters because upstream selects the transport from ONE flag
# (`server.go` dials "tcp" when Tcpmode > 0 and "udp" otherwise), so a SOCKS5
# config that omits `tcp` silently rides the datagram path and carries nothing
# while every other assertion stays green. That is a failure only a real
# connection can see, which is why this suite exists.
#
# Requires: root or CAP_NET_RAW, pingtunnel, iproute2, python3, curl.

set -uo pipefail

FX=/tmp/icmp-modes
BIN=/usr/local/bin/pingtunnel
BUILT="${BUILT:-/opt/xistance/packages/tunnel-core/dist/config/pingtunnel.js}"
NS_CLI=ns-cli
NS_SRV=ns-srv
V_CLI=vx-cli
V_SRV=vx-srv
SRV_IP=10.99.0.1
CLI_IP=10.99.0.2
S5_PORT=18208
KEY=987654321

pass=0
fail=0
ok()   { printf '      ok   %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '      FAIL %s\n' "$1"; [[ $# -gt 1 ]] && printf '           %s\n' "$2"; fail=$((fail+1)); }
note() { printf '       %s\n' "$1"; }
die()  { echo "--- $pass passed, $fail failed ---"; exit 1; }

SPID=""; CPID=""; HPID=""; UPID=""

teardown() {
  for p in "$CPID" "$SPID" "$HPID" "$UPID"; do [[ -n "$p" ]] && kill "$p" 2>/dev/null; done
  ip netns del "$NS_CLI" 2>/dev/null
  ip netns del "$NS_SRV" 2>/dev/null
  ip link del "$V_CLI" 2>/dev/null
  if [[ -n "${XP_KEEP:-}" ]]; then note "artefacts kept in $FX"; else rm -rf "$FX"; fi
}
trap teardown EXIT

if [[ "$(id -u)" != "0" ]]; then note "SKIP: needs root or CAP_NET_RAW"; exit 0; fi
[[ -x "$BIN" ]]   || { note "SKIP: $BIN is not installed on this target"; exit 0; }
[[ -f "$BUILT" ]] || { note "SKIP: $BUILT is missing (run npm run build:packages)"; exit 0; }
command -v ip >/dev/null || { note "SKIP: iproute2 is not available on this target"; exit 0; }
command -v curl >/dev/null || { note "SKIP: curl is not available on this target"; exit 0; }
if ! python3 -c 'import socket; socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_ICMP).close()' 2>/dev/null; then
  note "SKIP: cannot open a raw ICMP socket on this target"; exit 0
fi

rm -rf "$FX"; mkdir -p "$FX"; chmod 700 "$FX"

# ---------------------------------------------------------------- topology ---
ip netns del "$NS_CLI" 2>/dev/null
ip netns del "$NS_SRV" 2>/dev/null
ip link del "$V_CLI" 2>/dev/null
ip netns add "$NS_CLI" 2>"$FX/ns.err" || { note "SKIP: cannot create a network namespace"; exit 0; }
ip netns add "$NS_SRV" 2>>"$FX/ns.err"
ip link add "$V_CLI" type veth peer name "$V_SRV" 2>>"$FX/ns.err"
ip link set "$V_CLI" netns "$NS_CLI"
ip link set "$V_SRV" netns "$NS_SRV"
ip -n "$NS_CLI" addr add "$CLI_IP/24" dev "$V_CLI" 2>>"$FX/ns.err"
ip -n "$NS_SRV" addr add "$SRV_IP/24" dev "$V_SRV" 2>>"$FX/ns.err"
ip -n "$NS_CLI" link set "$V_CLI" up
ip -n "$NS_SRV" link set "$V_SRV" up
ip -n "$NS_CLI" link set lo up
ip -n "$NS_SRV" link set lo up
if ! ip netns exec "$NS_CLI" python3 -c '
import socket, struct, sys, time
def csum(b):
    if len(b) % 2: b += b"\x00"
    s = sum(struct.unpack("!%dH" % (len(b) // 2), b))
    s = (s >> 16) + (s & 0xffff); s += s >> 16
    return (~s) & 0xffff
dst = sys.argv[1]; ident = 0x5150; msg = b"icmp-modes"
h = struct.pack("!BBHHH", 8, 0, 0, ident, 1)
s = socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_ICMP); s.settimeout(3.0)
s.sendto(struct.pack("!BBHHH", 8, 0, csum(h + msg), ident, 1) + msg, (dst, 0))
end = time.time() + 3.0
while time.time() < end:
    try:
        p, _ = s.recvfrom(1024)
    except socket.timeout:
        break
    ihl = (p[0] & 0x0F) * 4
    if p[ihl] == 0 and struct.unpack("!H", p[ihl + 4:ihl + 6])[0] == ident:
        print("ok"); break
else:
    print("timeout")
' "$SRV_IP" 2>&1 | tail -1 | grep -q '^ok$'; then
  bad "the two nodes reach each other over the link" "no ICMP echo reply"; die
else
  ok "the two nodes reach each other over the link (ICMP permitted end to end)"
fi

# --------------------------------------------------------- SOCKS5 mode test ---
# Two backends on the FOREIGN node: one on loopback (only the proxy itself can
# reach it) and one bound to the veth address (the proxy CAN reach it). Reaching
# the first through the SOCKS5 proxy is the actual claim; the second is the
# negative control that would pass even with no tunnel at all.
node --input-type=module -e '
import fs from "node:fs";
const m = await import(process.argv[1]);
const cfg = {
  sock5: true, protocol: "tcp", listenAddr: ":" + process.argv[3],
  key: Number(process.argv[2]), encryption: "none", maxConn: 0,
  icmpListen: "0.0.0.0", timeoutSecs: 60,
};
fs.writeFileSync(process.argv[4], m.buildIcmpServerConfig(cfg));
fs.writeFileSync(process.argv[5], m.buildIcmpClientConfig(cfg, process.argv[6]));
' "$BUILT" "$KEY" "$S5_PORT" "$FX/s5-server.json" "$FX/s5-client.json" "$SRV_IP" 2>"$FX/gen.err"

if [[ -s "$FX/s5-server.json" && -s "$FX/s5-client.json" ]]; then
  ok "the builder produced the SOCKS5 pair"
else
  bad "the builder produced the SOCKS5 pair" "$(head -3 "$FX/gen.err")"; die
fi

# The single field under test. `tcp` must be 1: upstream dials "udp" whenever
# Tcpmode is 0, which would put a SOCKS5 tunnel on the datagram path.
s5_tcp="$(grep -oE '"tcp": *[0-9]+' "$FX/s5-client.json" | grep -oE '[0-9]+$' || true)"
if [[ "$s5_tcp" == "1" ]]; then
  ok "the SOCKS5 config sets tcp=1, so it rides the TCP path"
else
  bad "the SOCKS5 config sets tcp=1, so it rides the TCP path" "tcp=${s5_tcp:-absent}"
fi

if grep -q '"target"' "$FX/s5-client.json"; then
  bad "the SOCKS5 config carries no fixed target" "a target is present and would be ignored"
else
  ok "the SOCKS5 config carries no fixed target"
fi

# Backend on loopback: reachable ONLY through the proxy.
ip netns exec "$NS_SRV" python3 - "$SRV_IP" <<'PY' >"$FX/lo.log" 2>&1 &
import http.server, socketserver, sys
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        b = b"HELLO-SOCKS5"
        self.send_response(200)
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)
    def log_message(self, *a): pass
socketserver.TCPServer.allow_reuse_address = True
socketserver.TCPServer(("127.0.0.1", 18209), H).serve_forever()
PY
# Second backend on the veth address: reachable DIRECTLY, so it is the control.
ip netns exec "$NS_SRV" python3 - "$SRV_IP" <<'PY' >"$FX/veth.log" 2>&1 &
import http.server, socketserver
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        b = b"DIRECT-REACHABLE"
        self.send_response(200)
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)
    def log_message(self, *a): pass
socketserver.TCPServer.allow_reuse_address = True
socketserver.TCPServer(("0.0.0.0", 18210), H).serve_forever()
PY
HPID=$!
UPID=$!
sleep 2

# Baseline BEFORE the tunnel: direct works, loopback does not. This is what
# makes a later SOCKS5 success mean the proxy carried it.
direct=$(ip netns exec "$NS_CLI" curl -s --max-time 5 "http://$SRV_IP:18210/" 2>/dev/null)
loop=$(ip netns exec "$NS_CLI" curl -s --max-time 5 "http://$SRV_IP:18209/" 2>/dev/null)
if [[ "$direct" == "DIRECT-REACHABLE" ]]; then
  ok "baseline: the veth-bound backend is directly reachable"
else
  bad "baseline: the veth-bound backend is directly reachable" "got '$direct'"; die
fi
if [[ -z "$loop" ]]; then
  ok "baseline: the loopback-only backend is NOT reachable without a tunnel"
else
  bad "baseline: the loopback-only backend is unreachable without a tunnel" \
      "it answered '$loop', so a later success would prove nothing"; die
fi

ip netns exec "$NS_SRV" "$BIN" -c "$FX/s5-server.json" >"$FX/s5-server.log" 2>&1 &
SPID=$!
sleep 3
if kill -0 "$SPID" 2>/dev/null; then
  ok "the SOCKS5 server half started"
else
  bad "the SOCKS5 server half started" "$(tail -2 "$FX/s5-server.log")"; die
fi

ip netns exec "$NS_CLI" "$BIN" -c "$FX/s5-client.json" >"$FX/s5-client.log" 2>&1 &
CPID=$!
sleep 4
if kill -0 "$CPID" 2>/dev/null; then
  ok "the SOCKS5 client half started"
else
  bad "the SOCKS5 client half started" "$(tail -2 "$FX/s5-client.log")"; die
fi

# Through the proxy, with --socks5-hostname so curl hands the SOCKS5 layer the
# target too -- a real SOCKS5 client behaviour, not a hostname the tunnel
# already resolved.
via=""
for _ in $(seq 1 20); do
  via=$(ip netns exec "$NS_CLI" curl -s --max-time 6 \
        --socks5-hostname "127.0.0.1:$S5_PORT" \
        "http://127.0.0.1:18209/" 2>/dev/null)
  [[ -n "$via" ]] && break
  sleep 1
done
if [[ "$via" == "HELLO-SOCKS5" ]]; then
  ok "the SOCKS5 proxy carried a request to a loopback-only backend"
else
  bad "the SOCKS5 proxy carried a request to a loopback-only backend" \
      "got '$via' -- client: $(tail -2 "$FX/s5-client.log" | tr '\n' '|')"
fi

if kill -0 "$SPID" 2>/dev/null && kill -0 "$CPID" 2>/dev/null; then
  ok "both SOCKS5 halves survived the transfer"
else
  bad "both SOCKS5 halves survived the transfer" \
      "server=$(kill -0 $SPID 2>/dev/null && echo up || echo down) client=$(kill -0 $CPID 2>/dev/null && echo up || echo down)"
fi

# -------------------------------------------------------------- UDP mode ---
# -tcp 0 is how upstream selects the datagram path. A DNS-shaped exchange is the
# honest test: a real query and a real answer, not a TCP payload on a UDP socket.
node --input-type=module -e '
import fs from "node:fs";
const m = await import(process.argv[1]);
const cfg = {
  sock5: false, protocol: "udp", listenAddr: ":18218",
  targetHost: "127.0.0.1", targetPort: 18219,
  key: Number(process.argv[2]), encryption: "none", maxConn: 0,
  icmpListen: "0.0.0.0", timeoutSecs: 60,
};
fs.writeFileSync(process.argv[3], m.buildIcmpServerConfig(cfg));
fs.writeFileSync(process.argv[4], m.buildIcmpClientConfig(cfg, process.argv[5]));
' "$BUILT" "$KEY" "$FX/udp-server.json" "$FX/udp-client.json" "$SRV_IP" 2>>"$FX/gen.err"

udp_tcp="$(grep -oE '"tcp": *[0-9]+' "$FX/udp-client.json" | grep -oE '[0-9]+$' || true)"
if [[ "$udp_tcp" == "0" ]]; then
  ok "the UDP config sets tcp=0, which is how upstream selects the datagram path"
else
  bad "the UDP config sets tcp=0" "tcp=${udp_tcp:-absent}"
fi

for p in "$CPID" "$SPID"; do kill "$p" 2>/dev/null; done
CPID=""; SPID=""
sleep 1

ip netns exec "$NS_SRV" python3 - <<'PY' >"$FX/udp-echo.log" 2>&1 &
import socketserver
class H(socketserver.BaseRequestHandler):
    def handle(self):
        data, sock = self.request
        sock.sendto(b"DNS-ANSWER:" + data.upper(), self.client_address)
socketserver.UDPServer.allow_reuse_address = True
socketserver.UDPServer(("127.0.0.1", 18219), H).serve_forever()
PY
HPID=$!
sleep 2

ip netns exec "$NS_SRV" "$BIN" -c "$FX/udp-server.json" >"$FX/udp-server.log" 2>&1 &
SPID=$!
sleep 3
ip netns exec "$NS_CLI" "$BIN" -c "$FX/udp-client.json" >"$FX/udp-client.log" 2>&1 &
CPID=$!
sleep 4

udp_reply=""
for _ in $(seq 1 20); do
  udp_reply=$(ip netns exec "$NS_CLI" python3 -c '
import socket, sys
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(4)
s.sendto(b"query", ("127.0.0.1", 18218))
try:
    print(s.recv(2048).decode(errors="replace"))
except socket.timeout:
    print("")
' 2>/dev/null)
  [[ -n "$udp_reply" ]] && break
  sleep 1
done
if [[ "$udp_reply" == "DNS-ANSWER:QUERY" ]]; then
  ok "a datagram crossed the ICMP hop and came back (UDP mode carries real traffic)"
else
  bad "a datagram crossed the ICMP hop and came back" \
      "got '$udp_reply' -- server: $(grep -av '\[INFO\]' "$FX/udp-server.log" | tail -2 | tr '\n' '|')"
fi

note "UDP here means upstream's datagram path end to end. It is not evidence that"
note "an arbitrary UDP protocol survives a real lossy internet path."

echo "--- $pass passed, $fail failed ---"
exit $(( fail > 0 ? 1 : 0 ))