#!/bin/bash
# Durable gate: a target OS may only be reported green if the service user's
# real application WRITE path works, not just a 200 health endpoint.
#
# The root-owned app.db defect (TASK-74) passed unit=active, /api/health=200,
# /api/nodes=401 -- and every write in the product failed. On the 22.04.5 cell
# that was live until a real INSERT was run as the unprivileged service user
# (TASK-75). This script makes that the definition of a green target.
#
# Usage: bash scripts/test-target-write-path.sh <container> [<container>...]
# Exits 0 only if every named target passes every check. Targets that are not
# running are reported as BLOCKED, never as a pass.
set -u
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <container> [<container>...]" >&2
  exit 2
fi

PASS=0; FAIL=0; BLOCKED=0
ok()  { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  \033[31m✗\033[0m %s — %s\n' "$1" "$2"; }
skip(){ BLOCKED=$((BLOCKED+1)); printf '  \033[33m⊘\033[0m %s — %s\n' "$1" "$2"; }

for c in "$@"; do
  echo
  echo "=== $c ==="

  if ! docker inspect "$c" >/dev/null 2>&1; then
    skip "$c" "container not found (not counted as a pass)"
    continue
  fi
  if [ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null)" != "true" ]; then
    skip "$c" "container not running (not counted as a pass)"
    continue
  fi

  # 1. Real systemd as PID 1 -- a container without it is not a target host.
  if [ "$(docker exec "$c" sh -c 'ps -p 1 -o comm=' 2>/dev/null)" = "systemd" ]; then
    ok "$c: systemd is PID 1"
  else
    bad "$c: systemd is PID 1" "PID 1 is $(docker exec "$c" sh -c 'ps -p 1 -o comm=' 2>/dev/null || echo unknown)"
  fi

  # 2. The service must be running, but this is NOT sufficient on its own.
  if [ "$(docker exec "$c" systemctl is-active xistance 2>/dev/null)" = "active" ]; then
    ok "$c: xistance unit is active"
  else
    bad "$c: xistance unit is active" "unit is $(docker exec "$c" systemctl is-active xistance 2>/dev/null || echo unknown)"
  fi

  # 3. Health must be green (a read).
  h=$(docker exec "$c" sh -c 'curl -s -o /dev/null -w %{http_code} http://127.0.0.1:8080/api/health' 2>/dev/null)
  if [ "$h" = "200" ]; then
    ok "$c: /api/health is 200"
  else
    bad "$c: /api/health is 200" "got '$h'"
  fi

  # 4. THE CHECK THAT MATTERS: a real INSERT through the same SQLite file the
  #    app uses, executed as the unprivileged service user. A green health
  #    endpoint is a read; a wrong-owned database passes every check above and
  #    fails here with ERR_SQLITE_ERROR errcode 8.
  out=$(docker exec -i "$c" sh -c \
    'su -s /bin/sh xistance -c "node --input-type=module"' <<'JS' 2>&1
import { DatabaseSync } from "node:sqlite";
try {
  const db = new DatabaseSync("file:/var/lib/xistance/app.db");
  db.exec("CREATE TABLE IF NOT EXISTS _xt_write_probe(v INTEGER)");
  db.prepare("INSERT INTO _xt_write_probe (v) VALUES (?)").run(1);
  const r = db.prepare("SELECT COUNT(*) AS n FROM _xt_write_probe").get();
  db.exec("DROP TABLE _xt_write_probe");
  db.close();
  console.log("PROBE_OK rows=" + r.n);
} catch (e) {
  console.log("PROBE_FAIL " + (e && e.message ? e.message : String(e)));
}
JS
)
  case "$out" in
    *PROBE_OK*) ok "$c: service user can write to the application database" ;;
    *) bad "$c: service user can write to the application database" "$(printf '%s' "$out" | grep -m1 -E 'PROBE_FAIL|Error' | cut -c1-160)" ;;
  esac

  # 5. No readonly-database errors in the recent window. Historical occurrences
  #    are expected on a host that has been reinstalled over time; a NEW one
  #    means the fix regressed.
  #
  #    `grep -c` prints 0 AND exits 1 when there are no matches, so a naive
  #    `... || echo 0` appends a SECOND line and the value becomes "0\n0",
  #    which string-compares unequal to "0". Take the first line only, and
  #    do not add a fallback that duplicates grep's own zero.
  recent=$(docker exec "$c" sh -c \
    'journalctl -u xistance --since "-3min" --no-pager 2>/dev/null | grep -c "readonly database"' 2>/dev/null | head -1)
  case "$recent" in
    ''|*[!0-9]*) recent=0 ;;   # no journal, or an unparseable value
  esac
  if [ "$recent" -eq 0 ] 2>/dev/null; then
    ok "$c: no readonly-database errors in the last 3 minutes"
  else
    bad "$c: no readonly-database errors in the last 3 minutes" "$recent occurrence(s) after the install"
  fi
done

echo
echo "=================================================================="
printf ' %d passed, %d failed, %d blocked\n' "$PASS" "$FAIL" "$BLOCKED"
if [ "$FAIL" -gt 0 ]; then
  echo "RESULT: FAIL"
  exit 1
fi
if [ "$BLOCKED" -gt 0 ]; then
  # Blocked is a distinct outcome, never a pass.
  echo "RESULT: INCOMPLETE ($BLOCKED target(s) not exercised)"
  exit 3
fi
echo "RESULT: PASS"
