#!/usr/bin/env bash
# TASK-61: run the REAL staged release artifact under a real 1-vCPU / low-RAM
# cgroup, and assert readiness, representative API operations, and clean
# shutdown.
#
# Usage (inside WSL as root):
#   wsl -d Ubuntu -u root -- bash -s -- <artifactRoot> <serverDir> < this.sh
#
# Design notes that matter:
#  * MEMBERSHIP IS ASSERTED, NOT ASSUMED. The first version moved this shell
#    into the cgroup AFTER spawning the server, so the server stayed in
#    /init.scope: the limits were verified but never applied to the process
#    under test, and the run still printed PASS. The server is a child of this
#    shell and inherits its cgroup, so the shell must enter the cgroup BEFORE
#    the spawn -- and /proc/<pid>/cgroup is then checked explicitly.
#  * Limits are read back after being written, because a limit that silently
#    failed to apply produces a green run that proves nothing.
#  * memory.peak / memory.events are the kernel's authoritative record of what
#    was actually charged, as opposed to what the app reports about itself.
#  * Every port is ephemeral, the database is disposable, and secrets are
#    throwaway literals that exist only in this process.
#  * The host's cgroup configuration is never modified: a child cgroup is
#    created, used, and removed, and this shell moves itself back out first.
set -u

ARTIFACT_ROOT="${1:?usage: bash -s -- <artifactRoot> <serverDir> [memMaxBytes] [port]}"
SERVER_DIR="${2:?usage: bash -s -- <artifactRoot> <serverDir> [memMaxBytes] [port]}"
# Limits are POSITIONAL, not env-derived. `XT_MEM_MAX=x wsl ... bash -s` did
# not propagate the variable into the script at all, so a 32 MiB run silently
# executed against the 256 MiB default and reported PASS -- a negative control
# that controlled nothing. Positional args cannot be dropped that way.
MEM_MAX="${3:-268435456}"      # 256 MiB
PORT="${4:-39311}"
CG=/sys/fs/cgroup/xt-lowram
LIKE=/sys/fs/cgroup
DBDIR=${XT_TEST_DIR:-/tmp/xt-lowram}
CPU_QUOTA=${XT_CPU_QUOTA:-100000}  # 1 CPU over a 100ms period
NODE=${XT_NODE:-node}
ADMIN_EMAIL=lowram@xistance.local
ADMIN_PASS='LowRamDisposable!x1'
PEAK=0

echo "=== 0. inputs ==="
echo "artifact root: $ARTIFACT_ROOT"
echo "server dir:    $SERVER_DIR"
[ -f "$SERVER_DIR/server.js" ] || { echo "FAIL: no server.js in $SERVER_DIR"; exit 1; }
[ -f "$ARTIFACT_ROOT/apply-migrations.mjs" ] || { echo "FAIL: no apply-migrations.mjs in artifact root"; exit 1; }
echo "node:          $($NODE --version)"
echo "port:          $PORT"
echo "limits:        memory.max=$MEM_MAX  cpu.max=$CPU_QUOTA/100000"

echo
echo "=== 1. clean, disposable fixture ==="
rm -rf "$DBDIR"
mkdir -p "$DBDIR"
export DATABASE_URL="file:$DBDIR/db.sqlite"
export JWT_SECRET=lowram-disposable-secret
export XTENC_KEY=lowram-disposable-key
# Deliberately NOT setting XT_TRUST_PROXY: the panel is addressed directly here.
unset XT_TRUST_PROXY || true
echo "db: $DATABASE_URL"

echo
echo "=== 2. apply the constraint, then VERIFY it applied ==="
if [ -d $CG ]; then
  echo $$ > $CG/cgroup.procs 2>/dev/null || true
  echo $$ > $LIKE/cgroup.procs 2>/dev/null || true
  rmdir $CG 2>/dev/null || true
fi
mkdir -p $CG || { echo "FAIL: cannot create cgroup"; exit 1; }
echo $MEM_MAX > $CG/memory.max
echo "$CPU_QUOTA 100000" > $CG/cpu.max
GOT_MEM=$(cat $CG/memory.max)
GOT_CPU=$(cat $CG/cpu.max)
echo "readback memory.max = $GOT_MEM"
echo "readback cpu.max    = $GOT_CPU"
if [ "$GOT_MEM" != "$MEM_MAX" ]; then echo "FAIL: memory limit did not apply"; exit 1; fi
if [ "$GOT_CPU" != "$CPU_QUOTA 100000" ]; then echo "FAIL: cpu limit did not apply"; exit 1; fi
echo "constraint VERIFIED written"

echo
echo "=== 3. enter the cgroup BEFORE spawning anything that matters ==="
echo $$ > $CG/cgroup.procs
SHELL_CG=$(cat /proc/self/cgroup)
echo "shell cgroup: $SHELL_CG"
if ! echo "$SHELL_CG" | grep -q "xt-lowram"; then
  echo "FAIL: shell is not in the constrained cgroup (got: $SHELL_CG)"
  echo $$ > $LIKE/cgroup.procs; rmdir $CG 2>/dev/null; exit 1
fi
echo "membership established: children spawned from here inherit the cap"

echo
echo "=== 4. install-time work, INSIDE the cap (a real install runs on the VPS) ==="
# Timing uses $EPOCHREALTIME, NOT `date +%s%3N`. Under WSL, date's %N is NOT
# zero-padded to 3 digits: it returns 9-digit nanoseconds, so `%s%3N` produced a
# 16-digit number and every duration below was wrong by ~10^6 (migrations
# reported as 121252620ms -- thirty-four hours for a 1.2s job). EPOCHREALTIME
# is bash's own clock and is correct in milliseconds.
ms_now() { local t=${EPOCHREALTIME/./}; echo "${t}"; }
cd "$ARTIFACT_ROOT" || { echo "FAIL: cannot cd to artifact root"; exit 1; }
MIG_T0=$(ms_now)
# Pass BOTH flags, exactly as release-install.sh does.
#
# Without them the applier falls back to its SCRIPT-RELATIVE default --
# `<artifact>/../packages/db/prisma/migrations` -- which is one level ABOVE the
# artifact root and does not exist. It then printed
#
#   no migrations found in /root/xt-gate-NNNN/packages/db/prisma/migrations;
#   nothing to apply
#
# and exited 0. The gate reported `apply-migrations rc=0`, moved on, and
# create-admin failed with `no such table: User` -- reported as an admin-bootstrap
# failure 90 seconds later, when the real cause was a silently empty schema.
# That is the same silent-success shape as TASK-115, reached by a missing flag.
$NODE apply-migrations.mjs \
  --database "$DATABASE_URL" \
  --migrations "$ARTIFACT_ROOT/packages/db/prisma/migrations" \
  > "$DBDIR/migrate.log" 2>&1
MIG_RC=$?
MIG_MS=$(( $(ms_now) - MIG_T0 ))
echo "apply-migrations rc=$MIG_RC (${MIG_MS}ms)"
# `rc=0` is NOT proof the schema was created -- an empty migrations directory
# exits 0 by design. Check the table the next step depends on.
#
# The probe is written to a file rather than passed with `node -e`: a
# single-quoted SQL string inside a single-quoted `-e` argument terminates the
# shell string early, which produced a syntax error 30 lines away from the cause.
cat > "$DBDIR/check-schema.mjs" <<'PROBE'
import { DatabaseSync } from "node:sqlite";
const path = process.argv[2].replace(/^file:/, "");
const db = new DatabaseSync(path);
const row = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='User'")
  .get();
db.close();
process.exit(row ? 0 : 1);
PROBE

if ! $NODE "$DBDIR/check-schema.mjs" "$DATABASE_URL" 2>/dev/null; then
  echo "FAIL: migrations reported success but the User table does not exist"
  tail -20 "$DBDIR/migrate.log"
  echo "--- kernel view (did install-time work OOM?) ---"; cat $CG/memory.events
  echo $$ > $LIKE/cgroup.procs; rmdir $CG 2>/dev/null; exit 1
fi

if [ "$MIG_RC" -ne 0 ]; then
  tail -20 "$DBDIR/migrate.log"
  echo "--- kernel view (did install-time work OOM?) ---"; cat $CG/memory.events
  echo "FAIL: migrations did not complete under the cap"
  echo $$ > $LIKE/cgroup.procs; rmdir $CG 2>/dev/null; exit 1
fi
ADM_T0=$(ms_now)
$NODE create-admin.mjs --database "$DATABASE_URL" --email "$ADMIN_EMAIL" --password "$ADMIN_PASS" \
  > "$DBDIR/admin.log" 2>&1
ADM_RC=$?
ADM_MS=$(( $(ms_now) - ADM_T0 ))
echo "create-admin rc=$ADM_RC (${ADM_MS}ms)"
if [ "$ADM_RC" -ne 0 ]; then
  tail -20 "$DBDIR/admin.log"; cat $CG/memory.events
  echo "FAIL: admin bootstrap did not complete under the cap"
  echo $$ > $LIKE/cgroup.procs; rmdir $CG 2>/dev/null; exit 1
fi

echo
echo "=== 5. start the panel (inherits the cgroup) ==="
cd "$SERVER_DIR" || { echo "FAIL: cannot cd to server dir"; exit 1; }
PORT=$PORT HOSTNAME=127.0.0.1 $NODE server.js > "$DBDIR/server.log" 2>&1 &
SRV=$!
SRV_CG=$(cat /proc/$SRV/cgroup 2>/dev/null)
echo "server pid: $SRV"
echo "server cgroup: $SRV_CG"
if ! echo "$SRV_CG" | grep -q "xt-lowram"; then
  echo "FAIL: server is NOT in the constrained cgroup (got: $SRV_CG)"
  kill $SRV 2>/dev/null
  echo $$ > $LIKE/cgroup.procs; rmdir $CG 2>/dev/null; exit 1
fi
echo "membership VERIFIED: the cap applies to the server process"

echo
echo "=== 6. readiness (poll, no blind sleep) ==="
READY=0
i=0
for i in $(seq 1 120); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/health" 2>/dev/null)
  if [ "$code" = "200" ]; then READY=1; break; fi
  kill -0 $SRV 2>/dev/null || break
  sleep 0.5
done
echo "ready=$READY after ~$((i/2))s (last health code: ${code:-none})"
if [ "$READY" != "1" ]; then
  echo "--- server log ---"; tail -25 "$DBDIR/server.log"
  echo "--- kernel view ---"; cat $CG/memory.events
  kill $SRV 2>/dev/null; echo $$ > $LIKE/cgroup.procs; rmdir $CG 2>/dev/null
  exit 1
fi

echo
echo "=== 7. representative authenticated API operations ==="
rm -f "$DBDIR/cj"
LOGIN=$(curl -s -c "$DBDIR/cj" -X POST "http://127.0.0.1:$PORT/api/auth/login" \
  -H "content-type: application/json" \
  -H "Origin: http://127.0.0.1:$PORT" -H "Host: 127.0.0.1:$PORT" \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS\"}" \
  -o /dev/null -w '%{http_code}')
echo "login -> $LOGIN"
CSRF=$(grep xt_csrf "$DBDIR/cj" 2>/dev/null | awk '{print $7}')
echo "csrf: ${#CSRF} chars"
FAILED=0
for ep in /api/health /api/tunnels /api/nodes /api/metrics "/api/search?q=tunnel"; do
  c=$(curl -s -b "$DBDIR/cj" -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT$ep")
  echo "  GET $ep -> $c"
  [ "$c" = "200" ] || FAILED=1
done
# A write, so the database path is exercised and not just a cache path.
NC=$(curl -s -b "$DBDIR/cj" -X POST "http://127.0.0.1:$PORT/api/nodes" \
  -H "content-type: application/json" \
  -H "Origin: http://127.0.0.1:$PORT" -H "Host: 127.0.0.1:$PORT" \
  -H "x-csrf-token: $CSRF" \
  -d '{"name":"lowram-node","type":"IRAN","host":"203.0.113.5","username":"lowram","port":22}' \
  -o /dev/null -w '%{http_code}')
echo "  POST /api/nodes -> $NC"
[ "$NC" = "201" ] || [ "$NC" = "200" ] || FAILED=1

echo
echo "=== 8. what the kernel actually charged ==="
PEAK=$(cat $CG/memory.peak)
echo "memory.peak    = $PEAK bytes  (cap $MEM_MAX)"
echo "memory.current = $(cat $CG/memory.current) bytes"
echo "headroom       = $(( MEM_MAX - PEAK )) bytes"
echo "--- memory.events ---"
cat $CG/memory.events
echo "--- cpu.stat (throttling under 1 vCPU) ---"
cat $CG/cpu.stat 2>/dev/null | head -8

echo
echo "=== 9. clean shutdown, no orphans, no leak ==="
echo $$ > $LIKE/cgroup.procs
kill $SRV 2>/dev/null
STOPPED=0
for i in $(seq 1 40); do
  kill -0 $SRV 2>/dev/null || { STOPPED=1; break; }
  sleep 0.25
done
echo "server stopped = $STOPPED"
[ "$STOPPED" = "1" ] || { echo "FAIL: server did not exit within 10s"; kill -9 $SRV 2>/dev/null; }
if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/api/health" 2>/dev/null; then
  echo "FAIL: something still answers on $PORT after shutdown"
  STOPPED=0
else
  echo "no listener remains on $PORT"
fi
# memory.current must drain back toward zero once the server is gone, which is
# the observable difference between "exited" and "actually released the RAM".
#
# POLL, do not sleep. A fixed `sleep 1` was wrong: the loop above confirms the
# server is gone, but the kernel charges its pages back asynchronously, and on a
# loaded host that reclaim has not completed a second later. The gate then
# reported ">32MiB still charged after exit (leak or orphan)" for a run that had
# released everything -- it passed alone and failed inside the aggregate, which
# is the signature of a timing assumption rather than a leak.
#
# The bound still has to catch a genuine leak, so it polls for 30s and reports
# the final value: a drain is distinguished from a leak that never drains, not
# from one that drains late.
# Measure ANONYMOUS memory, not memory.current.
#
# memory.current = anon + file (page cache) + kernel + sock + shmem. The page
# cache component is *not* a leak: it is the kernel holding clean file pages
# read from the release payload, and it is only reclaimed under memory
# pressure. A run measured with memory.current reported:
#
#   memory.current after shutdown = 37453824 bytes (drained=0 after 60 polls)
#   memory.stat: anon 45056 | file 35971072 | kernel 274432
#   pids in cgroup: 0
#
# i.e. 44 KiB of real memory and 34 MiB of cached file pages, with NOTHING
# running in the cgroup. Polling for longer cannot drain the cache, so the
# assertion could never pass and its failure message ("leak or orphan") named
# the wrong cause -- there was neither a leak nor an orphan.
#
# A leak is anonymous memory held by a live process, so `anon` is the quantity
# that actually expresses the property. It is also strictly more sensitive to a
# real defect: a process that leaks 32 MiB of heap shows up in `anon` and not in
# `file`, so nothing is lost by switching.
DRAINED=0
AFTER=0
for i in $(seq 1 60); do
  AFTER=$(awk '$1 == "anon" { print $2 }' $CG/memory.stat)
  [ -n "$AFTER" ] || AFTER=0
  if [ "$AFTER" -lt 33554432 ]; then DRAINED=1; break; fi
  sleep 0.5
done
FILE_AFTER=$(awk '$1 == "file" { print $2 }' $CG/memory.stat)
PROCS_AFTER=$(wc -l < $CG/cgroup.procs 2>/dev/null || echo 0)
echo "anon after shutdown        = $AFTER bytes (drained=$DRAINED after $i polls)"
echo "file cache (not a leak)    = ${FILE_AFTER:-0} bytes"
echo "kernel                    = $(awk '$1 == "kernel" { print $2 }' $CG/memory.stat) bytes"
echo "pids left in cgroup       = $PROCS_AFTER"
if [ "$DRAINED" != "1" ]; then
  echo "FAIL: >32MiB ANONYMOUS memory still held 30s after exit ($PROCS_AFTER pids in cgroup)"
  STOPPED=0
fi

echo
echo "=== 10. cleanup ==="
rmdir $CG 2>/dev/null && echo "cgroup removed" || echo "cgroup NOT removed"
echo "host subtree_control unchanged: $(cat $LIKE/cgroup.subtree_control)"

echo
if [ "$STOPPED" = "1" ] && [ "$FAILED" = "0" ]; then
  # A run can satisfy AC2 ("no OOM") while living on the edge: the kernel
  # reclaims rather than killing, so `oom_kill 0` is true even at 100% of the
  # cap. A negative control at 48 MiB did exactly that -- 403 `high` reclaim
  # events, zero OOM kills, RESULT: PASS. That is a passing run that hides a
  # real limit, so reclaim pressure is reported as a WARN rather than folded
  # into the pass. It does not fail the gate: surviving at 100% of a cap is
  # different from being OOM-killed, and conflating them would make the
  # assertion mean less.
  HIGH=$(grep '^high ' $CG/memory.events 2>/dev/null | awk '{print $2}')
  HIGH=${HIGH:-0}
  echo "RESULT: PASS"
  echo "  constraint : 1 vCPU, $(( MEM_MAX / 1024 / 1024 )) MiB RAM (written, read back, membership asserted)"
  echo "  peak charge: $(( PEAK / 1024 / 1024 )) MiB kernel-charged, $(( PEAK * 100 / MEM_MAX ))% of the cap"
  if [ "$HIGH" -gt 0 ]; then
    echo "  WARN       : $HIGH reclaim events -- no OOM kill, but this cap is too tight to be comfortable"
  fi
else
  echo "RESULT: FAIL (stopped=$STOPPED apiFailed=$FAILED)"
  exit 1
fi
