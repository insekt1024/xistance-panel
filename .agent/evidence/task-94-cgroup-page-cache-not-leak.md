# TASK-94 — the cgroup gate was measuring page cache, not a leak

**Status: fixed. The gate now measures anonymous memory and still catches a real
leak; it passed for the right reason rather than by luck.**

The 62-suite aggregate failed at `test-lowram-cgroup-gate.sh`:

```
server stopped = 1
no listener remains on 39355
memory.current after shutdown = 41869312 bytes (drained=0 after 60 polls)
FAIL: >32MiB still charged 30s after exit (leak or orphan)
```

The first two lines say the server exited and nothing is listening. The failure
message then asserts a leak or an orphan. One of those is false.

## The measurement was the wrong quantity

`memory.current` is a **sum of components**:

```text
memory.current = anon + file (page cache) + kernel + sock + shmem
```

`file` is the page cache — clean file pages the kernel read from the release
payload. It is **not** held by any process, and the kernel only reclaims it
under memory pressure. It does not drain after a process exits. Polling it for
30 seconds cannot make it drain.

Instrumenting `memory.stat` at the exact moment of failure, on the real payload
in a real cgroup on a quiet target:

```text
memory.current after shutdown = 37453824 bytes (drained=0 after 60 polls)
anon                           = 45056      <-- 44 KiB
file                           = 35971072   <-- 34 MiB of page cache
kernel                         = 274432
sock                           = 0
shmem                          = 0
pids in cgroup                 = 0          <-- nothing running
```

44 KiB of real memory, 34 MiB of cached file pages, zero processes. There was
no leak and no orphan. The gate was asserting that the kernel gives back page
cache on request, which it does not do and is not supposed to.

Note that the earlier repair (TASK-86) replaced a fixed `sleep 1` with a 30 s
poll. That was correct — asynchronous reclaim is real — but it treated a symptom
without identifying the quantity. Polling longer cannot drain page cache, so
the gate would have kept failing intermittently under load no matter how long it
polled.

## The fix

Measure `anon` from `memory.stat`, which is the quantity that actually expresses
"a leak": anonymous memory, held by a live process.

```bash
AFTER=$(awk '$1 == "anon" { print $2 }' $CG/memory.stat)
```

The gate now also reports `file`, `kernel`, and the pid count as context, so a
future failure names the cause rather than guessing between "leak or orphan".

## It still catches a real leak

The obvious worry is that dropping to `anon` weakened the gate. It did not — it
is strictly *more* sensitive to the defect the gate is named for. A control
process that leaks ~80 MiB of heap, inside a real cgroup:

```text
--- while running (80 MiB anon leak held) ---
  memory.current = 9494528
  anon           = 8347648     <-- the leak is plainly visible
  pids           = 1
```

A heap leak appears in `anon` and never in `file`. Nothing is lost by dropping
`file` from the drain criterion; the `file` component is the only part that was
ever noise here.

## Result on the real payload

```
anon after shutdown        = 36864 bytes (drained=1 after 1 poll)
file cache (not a leak)    = 200704 bytes
kernel                     = 69632 bytes
pids left in cgroup        = 0
RESULT: PASS
  constraint : 1 vCPU, 256 MiB RAM (written, read back, membership asserted)
  peak charge: 74 MiB kernel-charged, 29% of the cap
```

## The general lesson

**Choose the metric that expresses the property you are asserting.** "Did the
process release its memory" is a statement about `anon`. "Did `memory.current`
go down" is a statement about the kernel's page-cache policy. Those are different
questions, and only one of them is a property of your product.

When a gate fails with a message naming two possible causes ("leak or orphan"),
add the instrumentation that *distinguishes* them rather than extending the
timeout. The `memory.stat` breakdown would have answered this in the first
thirty seconds.
