#!/usr/bin/env bash
# X-UI / 3X-UI reachability check.
#
# Mirrors XUI_LOGIN_PATHS in packages/tunnel-core/src/config/xui.ts and the
# /api/xui/test route. x-ui and 3x-ui expose different login paths, so try
# each one: HTTP 200/302 with a session cookie means the credentials work.
#
# Usage: PANEL_URL=http://203.0.113.10:2053 USER=admin PASS=secret bash xui-check.sh

PANEL_URL="${PANEL_URL:?set PANEL_URL, e.g. http://203.0.113.10:2053}"
USER="${USER:?set USER}"; PASS="${PASS:?set PASS}"
PANEL_URL="${PANEL_URL%/}"

for path in /login /panel/login /xui/login; do
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 8 \
    --data-urlencode "username=$USER" --data-urlencode "password=$PASS" \
    "$PANEL_URL$path")"
  echo "$path -> $code"
  if [[ "$code" == "200" || "$code" == "302" ]]; then
    echo "OK: panel reachable, login accepted via $path"
    exit 0
  fi
done
echo "FAIL: panel unreachable or credentials rejected"
exit 1
