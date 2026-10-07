# TASK-63 — startup, health, localized routes and assets on Ubuntu 24.04

**Status: met, by execution on the running release.** This is the one of the four
VPS-blocked tasks (62/63/64/65) that did **not** in fact need external access: the
target is Ubuntu 24.04, and `xt24` is Ubuntu 24.04.5 running the installed
artifact. Recorded here as evidence, not as a waiver.

## Host metadata (non-secret only)

    os       : Ubuntu 24.04.5 LTS
    kernel   : 6.18.40.1-microsoft-standard-WSL2
    arch     : x86_64
    vCPU     : 16
    RAM      : 7834 MiB total, 6449 MiB available
    swap     : 2048 MiB
    disk     : 915G available of 1007G
    node     : v22.23.3

**Constraint stated plainly: this host is not low-RAM.** 16 vCPU / 7.8 GiB is a
desktop-class WSL2 VM, not the one-vCPU / ~1 GiB target the low-resource budgets
(TASK-57/58/60) are defined against. So this task's ACs are satisfied, but
**nothing here proves the panel fits the low-resource budget on the target host** --
that remains TASK-62's job, and TASK-57's own evidence says the same about its
baseline.

## AC1 — host metadata recorded

Above. No credentials, no env values, no keys.

## AC2 — starts on Node 22 without a source build, reaches health

    service: active
    ExecStart="/usr/bin/node" "/opt/xistance/current/apps/web/server.js"
    User=xistance
    server.js present (no source build needed)

    {"ok":true,"status":"healthy","version":"1.3.5",
     "checks":{"database":"ok","engine":"ok","managedTunnels":"0"}}

Runs the **prebuilt standalone bundle** -- no `npm ci`, no `next build` on the
host. Unauthenticated `/api/tunnels` still returns 401.

## AC3 — EN and FA routes load, and JS/CSS/media assets succeed

Routes (307 = correct unauthenticated redirect to login; 200 on login):

    en  /tunnels   307     en  /login   200
    en  /nodes     307     fa  /tunnels 307
    en  /settings  307     fa  /login   200
                          fa  /nodes   307
                          fa  /settings 307

Assets, fetched the way the page actually references them:

    /_next/static/chunks/2ryrns202awk0.js      -> 200 (27709 bytes)
    /_next/static/chunks/1gpl87e04rd-n.js      -> 200 (172425 bytes)
    /_next/static/media/797e433ab948586e...woff2 -> 200 (23108 bytes)

59 static files ship, including the Persian `woff2` faces. The FA login page
carries `lang="fa"` markers, so localization is real rather than a fallback.

**A measurement I got wrong and corrected.** My first media fetch used
`/apps/web/.next/static/media/...` and returned **404**. That was my error, not a
packaging defect: the page references `/_next/static/media/...`, which serves 200.
Recorded because a 404 looked like the standalone-static bug and was not.

**No CSS file exists** -- neither in the release nor in the local tree. The app
ships no stylesheet; `static/` holds chunks, manifests and fonts only. Not a
packaging gap.

## AC4 — API operation and restart, no OOM or leaked processes

    RSS before restart : 147 MiB
    restart            : healthy again, HTTP 200 within ~4s
    RSS after restart  : 116 MiB (settled)
    process count      : 1  (PID 34449, parented to init)
    OOM kills in dmesg : 0

**Two of my own readings were wrong before they were right.** `pgrep -c node`
reported 0 and `pgrep -fc next-server` reported 2 and 3, because the pattern
matched the very shell running the probe. `ps -eo pid,ppid,rss,args` is the
truth: a single `next-server` parented to PID 1. Reading a leak into a
self-matching `pgrep` would have been a fabricated defect.

## What this does and does not close

Closes TASK-63. Does **not** close TASK-62 (real Ubuntu 22.04 one-vCPU/low-RAM
VPS), and therefore not TASK-64 or TASK-65, which depend on it. The low-resource
budget remains unproven on its target host.

## Correction: the "Prisma is not packaged for Linux" risk does NOT apply to v1.3.5

`task-1.md` records an outstanding prerequisite risk: the standalone release tree
carried only `query_engine-windows.dll.node`, missing `index.js`, `package.json`
and any Linux engine. Checked against the **published v1.3.5 amd64 artifact**:

    ./packages/db/generated/client/libquery_engine-debian-openssl-3.0.x.so.node
    ./packages/db/generated/client/libquery_engine-linux-musl-openssl-3.0.x.so.node
    ./packages/db/generated/client/query_engine_bg.wasm
    ./packages/db/generated/client/query_engine_bg.js
    ./packages/db/generated/client/schema.prisma
    ./packages/db/prisma/schema.prisma
    ./packages/db/prisma/migrations/20260823214332_init/

Both Linux glibc and musl engines ship, plus the wasm fallback and the migrations
directory. 2425 entries in total. **The risk was real at the time it was written
and has since been fixed; it is closed for v1.3.5.**

### How I nearly reported it as a live defect

My first check used `tar -tzf` on a Windows-style path and got:

    tar (child): Cannot connect to C: resolve failed
    gzip: stdin: unexpected end of file
    total entries: 0
    any prisma paths at all: (none)

`tar` parsed the `C:` prefix as a remote host spec, so it read **zero** entries.
Grepping an empty listing for "prisma" trivially returns nothing -- which looks
exactly like "the artifact has no Prisma engine". Repeating the greps did not help;
they were all reading the same empty list.

Re-read via Python's `tarfile` (which takes the path natively), the engines are
right there. **An empty result from a tool that failed is not a finding.** The
lesson is the same one that produced two earlier false readings this session: a
probe that errors looks identical to a probe that legitimately finds nothing, and
"no results" needs a positive control before it becomes a conclusion.

