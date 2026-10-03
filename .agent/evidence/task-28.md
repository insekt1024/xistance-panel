# TASK-28 evidence — GOST lifecycle coverage

**Status:** passed

## The real defect: preflight tested existence, not executability

```sh
[ -e '<path>' ] && echo "OK gost" || echo "MISSING gost"
```

`-e` answers "does this path exist", not "can this be run". A `gost` that is
present but **not executable** — a download that lost its `+x` bit, a `noexec`
mount, a 0644 file from a partial install — passed preflight, the tunnel
reported healthy, and then the child died with a bare `permission denied` that
the panel had no way to explain and no way to fix in the message.

The check is now three predicates in precedence order:

```sh
if   [ ! -e p ]; then echo "MISSING gost"
elif [ ! -f p ]; then echo "NOTFILE gost"
elif [ ! -x p ]; then echo "NOTEXEC gost"
else                    echo "OK gost"; fi
```

Order matters: a **directory** reports `NOTFILE`, not `NOTEXEC`, because
`chmod +x` on a directory does not fix it. Each outcome gets its own message
naming the path, the node, and the exact remedy:

| Outcome | Message |
| --- | --- |
| `missing` | `Run scripts/install.sh (or: xistance install --bin gost)` |
| `not_executable` | `Run: chmod +x /usr/local/bin/gost` |
| `not_a_file` | `Run scripts/install.sh to reinstall it.` |

## Second fix: the path is interpolated into `bash -c`, unescaped

The probe string is passed to `bash -c`, and the absolute path was wrapped in
single quotes with no escaping. A path containing a single quote breaks out of
the quoting. A binary name is not attacker-controlled today, but paths can
contain quotes and the failure mode is arbitrary command execution on the node.
Now POSIX `'\''`-escaped, and a test asserts a hostile path cannot break out.

## Extracted rather than inlined

`packages/tunnel-core/src/preflight.ts` holds `buildPreflightScript`,
`classifyPreflightLine`, `preflightBin`, `preflightError` and `shQuote`, and
`engine.ts` calls them. Inline, none of this is testable without a live node —
and the classifier is exactly the logic that decides which message an operator
sees. `engine.ts` still issues **one `bash -c` per node**, not one per binary,
because each remote session is a full SSH round-trip.

## Coverage added

- **Schema** — port bounds, non-integer ports, unknown direction, unknown
  protocol, negative TTL, undersized buffer.
- **Command shape** — the command leads with the binary token, `-L` is second,
  and the token appears **exactly once**. (TASK-26 recorded `ssh ssh -N …`
  shipping this way for SSH; a duplicated leading token is the same class of
  bug, so it is asserted here.)
- **URL shape** — `tcp://:<listen>/<host>:<port>`, protocol token follows the
  config, and a missing forward target never leaks the word `undefined`.
- **Single relay** — the non-listener node produces no command.
- **Bidirectional** — both sides get a command, the direction node listens on
  `listenPort`, the mirror listens on `remotePort` and forwards back to the
  peer's listener, and a mirror without `remotePort` falls back to
  `listenPort`.
- **Preflight** — all four outcomes classified distinctly; each message names
  the fix; messages are mutually distinct and a missing binary never suggests
  `chmod`.
- **Real POSIX predicate** — on a POSIX host, a 0755 file passes, a 0644 file
  fails, a directory fails.
- **Determinism**, and **diagnostics** that keep the tool name while dropping
  credentials.

## Non-vacuity

| Mutation | Result |
| --- | --- |
| Revert to the existence-only `-e` check | **FAIL** `tests executability`, `distinguishes a directory` |
| Drop the shell escaping | **FAIL** both quote-escaping assertions |
| Delete the `not_executable` branch | **FAIL** 3 assertions |
| Restored | 37/37 |

**A mutant passing exposed my own vacuous test.** Deleting the
`not_executable` branch initially left the suite green, because the test
constructed the expected message string inline instead of calling
`preflightError` — it was asserting its own literal. The test now calls the
real function and additionally asserts the three messages are mutually
distinct, so a collapsed branch cannot hide behind a shared `default:`.

## Real-binary limitation (recorded, not claimed)

**No `gost` binary is available on this host, so no real GOST process was
started and no traffic flowed.** The task's note requires recording the tested
version and forbids claiming compatibility without it.

- **Proven:** the schema rejects invalid input; the command and URL shapes are
  correct and carry the binary token exactly once; single-relay and
  bidirectional topologies produce the right commands on the right nodes;
  preflight distinguishes all four filesystem outcomes and names a fix for each;
  the path is shell-safe; diagnostics carry no credential.
- **Not proven:** that a specific GOST version accepts these arguments, that
  `-L tcp://:port/host:port` is the right invocation for the pinned version, and
  that a live relay forwards traffic. `gost` v2 and v3 differ in CLI surface, so
  this genuinely needs a binary.

This joins the TASK-26 (BACKHAUL) and TASK-27 (FRP) open items and belongs to
the VPS acceptance pass.

## Verified

- `test-gost.ts` — 37/37
- `test-frp.ts` — 28/28
- `test-backhaul.ts` — 39/39
- `test-forward-reconcile.ts` — 24/24
- `test-port-allocation.ts` — 27/27
- `test-bounded-caches.ts` — 29/29
- `test-diagnostics.ts` — 22/22
- `test-disposal-cleanup.ts` — 15/15
- `test-retry-bounds.ts` — 23/23
- `test-tunnel-lifecycle.ts` — 21/21
- `test-optimizations.ts` — 77/77
- `test-line-endings.sh` — 54/54
- `typecheck`, `lint` — pass

**29/73 tasks passed.**
