# TASK-93 — the flaky retry test: an assertion about a state that had legitimately changed

**Status: fixed and proven. `test-retry-bounds.ts` is now deterministic under
load (4/4 with 8 CPU burners, previously failing intermittently).**

The 62-suite aggregate failed at `test-retry-bounds.ts` (22 passed, 2 failed):

```
FAIL the streak really had climbed before recovery
     pre-kill delay was only 1000 ms, so the post-kill reading proves nothing
FAIL after recovery the next failure restarts at the base delay
     still 1000 ms after the kill (exit event never landed)
```

Note what the passing assertion in the same block said:

```
ok an explicit start resets the streak (climbed to 8000 ms, now attempts=1)
```

Escalation demonstrably worked — 8,000 ms — while the two failing assertions
claimed it had not reached base+1 at all. The two readings contradict each
other, which locates the defect in the test.

## Root cause: reading a state after the state changed

The block captured `climbed` correctly at line 376, **before** the explicit
`start()`:

```ts
const climbed = handle.retryState().lastDelayMs;   // 8000 — correct
await handle.start();                                // operator recovery
await new Promise((r) => setTimeout(r, 30));        // settle
...
const beforeKill = handle.retryState().lastDelayMs; // re-read!
```

`lastDelayMs` is history and is deliberately not cleared, but this spec's child
is `node -e "process.exit(1)"` — it exits immediately. So the explicit
`start()`'s **own exit** lands inside the 30 ms settle window and reschedules
the delay back to `base`. By the time `beforeKill` was read, the value had
legitimately changed from 8,000 back to 1,000, and the assertion "the streak
really had climbed" was evaluating a state that no longer held.

The same error was in the follow-on poll:

```ts
const settled = await waitFor(
  () => handle.retryState().lastDelayMs !== beforeKill,   // "it changed"
  "the exit event to reschedule at the base delay",
);
```

This waits for a **transition** to observe a **value**. Since the value may
already have arrived (early, during the settle), the poll waits for a change
that will never come — hence "exit event never landed", which was a misleading
diagnostic: the event landed fine, early.

## The fix

1. `const beforeKill = climbed;` — assert against the capture taken when the
   property was true, not a re-read taken after it stopped being true.
2. Poll for the **state wanted**, not for a difference:
   ```ts
   const settled = await waitFor(
     () => handle.retryState().lastDelayMs === baseDelayMs,
     "the next failure to schedule at the base delay",
   );
   ```
   This is correct whether the value arrives early or late.

## Why the product was not at fault

The product behaviour is correct and is now asserted correctly: the streak
climbs to 8,000 ms across four driven failures, an explicit `start()` resets it,
the next failure schedules at the 1,000 ms base, and an automatic respawn still
preserves escalation. The TASK-88 fix (`resetStreak()`) is what makes the
explicit-reset case work, and the suite still covers it.

## Verification

| condition | result |
| --- | --- |
| 6 consecutive unloaded runs | 24/24 each |
| 4 runs under 8 CPU burners | 24/24 each |

The loaded runs are the meaningful ones: the previous defect appeared only
under aggregate-level load, because that is when the settle window is wide
enough for the instant-exit child's exit event to land inside it.

## The general lesson

**A flaky assertion is often an assertion about a mutable value read at the
wrong moment.** Poll for the value you are asserting, not for evidence that
something changed. And when two assertions in the same block disagree — one
saying "climbed to 8000 ms", the other saying "was only 1000 ms" — believe the
one whose evidence is a capture and find which read happens later.
