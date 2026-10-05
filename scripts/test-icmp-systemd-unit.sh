#!/usr/bin/env bash
# Does the systemd unit the panel generates actually bring up a pingtunnel
# server that can open a raw ICMP socket?
#
# This closes a gap the two-node suite does not: that suite starts both halves
# from an interactive root shell, so it never exercises the unit file the panel
# really writes. Here the unit is the exact shape buildUnit() produces.
#
# The question it answers is narrow and specific: `User=root` in that unit is
# what lets pingtunnel open the raw socket, so a unit missing it would fail at
# runtime with EPERM while every other test stayed green.

set -uo pipefail

FX=/tmp/icmp-unit
BIN=/usr/local/bin/pingtunnel
BUILT=/opt/xistance/packages/tunnel-core/dist/config/pingtunnel.js
UNIT=xt-icmp-probe.service

pass=0
fail=0
ok()   { printf '      ok   %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '      FAIL %s\n' "$1"; [[ $# -gt 1 ]] && printf '           %s\n' "$2"; fail=$((fail+1)); }
note() { printf '       %s\n' "$1"; }

cleanup() {
  systemctl stop "$UNIT" >/dev/null 2>&1
  systemctl disable "$UNIT" >/dev/null 2>&1
  rm -f "/etc/systemd/system/$UNIT"
  systemctl daemon-reload >/dev/null 2>&1
  rm -rf "$FX"
}
trap cleanup EXIT

if [[ "$(id -u)" != "0" ]]; then note "SKIP: needs root"; exit 0; fi
[[ -x "$BIN" ]]   || { note "SKIP: $BIN is not installed on this target"; exit 0; }
[[ -f "$BUILT" ]] || { note "SKIP: $BUILT is missing"; exit 0; }
command -v systemctl >/dev/null || { note "SKIP: systemd is not PID 1 on this target"; exit 0; }

rm -rf "$FX"; mkdir -p "$FX"; chmod 700 "$FX"

node --input-type=module -e '
import fs from "node:fs";
const m = await import(process.argv[1]);
const cfg = {
  sock5: false, protocol: "tcp", listenAddr: ":18148",
  targetHost: "127.0.0.1", targetPort: 18149,
  key: 987654321, encryption: "none", maxConn: 0,
  icmpListen: "0.0.0.0", timeoutSecs: 60,
};
fs.writeFileSync(process.argv[2], m.buildIcmpServerConfig(cfg));
' "$BUILT" "$FX/server.json"
chmod 600 "$FX/server.json"

# The literal unit text buildUnit() emits for this plan, including User=root.
# Written by hand here so a change to buildUnit() cannot silently make this
# probe describe a different unit than the one it starts.
cat > "/etc/systemd/system/$UNIT" <<UNIT_TEXT
[Unit]
Description=Xistance tunnel: icmp-probe
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$BIN -c $FX/server.json
Restart=on-failure
RestartSec=5
User=root
RuntimeDirectoryMode=0750

[Install]
WantedBy=multi-user.target
UNIT_TEXT
systemctl daemon-reload >/dev/null 2>&1
# The journal is cumulative for this unit NAME: without this reset, a permission
# error from an earlier run of xt-icmp-probe.service is still in the buffer and
# gets attributed to this run, which is how a clean rerun reports a failure it
# did not have.
journalctl -u "$UNIT" --rotate >/dev/null 2>&1
journalctl -u "$UNIT" --vacuum-time=1s >/dev/null 2>&1
systemctl start "$UNIT" >/dev/null 2>&1
sleep 4

if systemctl is-active --quiet "$UNIT"; then
  ok "the generated unit starts and stays active"
else
  bad "the generated unit starts and stays active" \
      "$(systemctl status "$UNIT" --no-pager 2>&1 | tail -3 | tr '\n' '|')"
  echo "--- $pass passed, $fail failed ---"; exit 1
fi

user="$(ps -o user= -C pingtunnel 2>/dev/null | head -1 | tr -d '[:space:]')"
if [[ "$user" == "root" ]]; then
  ok "the unit runs pingtunnel as root, which is what allows the raw socket"
else
  bad "the unit runs pingtunnel as root" "ps reports user='${user:-none}'"
fi

# The decisive assertion: a raw socket either opens or it does not. A unit
# missing the privilege fails here with EPERM and every other check still green.
errs="$(journalctl -u "$UNIT" --no-pager -n 40 2>/dev/null \
  | grep -ciE 'permission denied|operation not permitted' || true)"
if [[ "$errs" == "0" ]]; then
  ok "pingtunnel opened its raw ICMP socket with no permission error"
else
  bad "pingtunnel opened its raw ICMP socket with no permission error" \
      "$errs permission errors in the unit log"
fi

if grep -q 'Server start' < <(journalctl -u "$UNIT" --no-pager -n 40 2>/dev/null); then
  ok "the unit log shows pingtunnel reached 'Server start'"
else
  bad "the unit log shows pingtunnel reached 'Server start'" \
      "$(journalctl -u "$UNIT" --no-pager -n 5 2>/dev/null | tr '\n' '|' | cut -c1-200)"
fi

note "this covers the privilege half of the systemd path only. It does not put"
note "traffic through the unit: the two-node suite covers that, from a shell."

echo "--- $pass passed, $fail failed ---"
exit $(( fail > 0 ? 1 : 0 ))