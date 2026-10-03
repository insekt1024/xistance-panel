# TASK-88 — a vacuous assertion hid a real product defect in the retry backoff

**Status: closed. A product bug and two test bugs, found in that order, because
the assertion could not fail.**

## How it surfaced

`test-retry-bounds.ts` failed once inside a 60-suite aggregate run and passed
when run alone. The classic "flake" signature — and, as with the cgroup gate,
a timing assumption rather than a flake.

## Bug 1 (test): the poll could never fail, so it never tested anything

```ts
const settled = await waitFor(
  () => handle.retryState().lastDelayMs <= 1_000,     // baseDelayMs IS 1_000
  "the exit event to reschedule at the base delay",
);
if (settled) ok(...);
```

The spec is built with `baseDelayMs: 1_000`. So `lastDelayMs <= 1_000` was
**already true before the kill** and stayed true after it. The poll could not
distinguish "the exit event rescheduled at the base delay" from "nothing ever
happened."

The only reason it ever failed was the exit event being slow under load — an
unrelated reason. A test that can only fail for an unrelated reason is not
testing its subject, and worse, it was masking the real behaviour.

Fixed by waiting for the value to **differ from the pre-kill reading**, then
asserting it is exactly the base. A change is the proof that a transition
happened.

## Bug 2 (test): the "climb" loop drove one failure, not four

```ts
for (let i = 0; i < 4; i += 1) {
  await clock.advance(90_000);
  await new Promise((r) => setTimeout(r, 25));     // fixed sleep
}
```

The respawn timer fires `void this.startSerialized(true)` — an **un-awaited**
async spawn — and the *next* retry timer is only registered once that spawn's
process has exited. A fixed 25 ms sleep raced it, so the loop looked like it was
driving four failures and was driving one.

The loop now waits for the observable (`lastDelayMs` to move) before advancing
again, which is the same rule as everywhere else in this file: poll for the thing
you are waiting for, with a bounded deadline.

This is the third instance of that rule in this repository
(`test-retry-bounds.ts` exhaustion, `test-lowram-cgroup-gate.sh` drain). A fixed
sleep standing in for a condition the system reaches on its own schedule is the
recurring defect shape here.

## Bug 3 (product): an operator's "start" did not reset the backoff

With both test bugs fixed, the assertion became meaningful and failed with real
numbers:

```
  ok   the streak really had climbed before recovery (8000 ms > 1000 ms base)
  FAIL after recovery the next failure restarts at the base delay
       rescheduled at 16000 ms, expected the 1000 ms base (climbed to 8000)
```

**The streak climbed to 8,000 ms, the operator pressed start, and the next
failure continued to 16,000 ms.**

The cause is in `packages/tunnel-core/src/process.ts`:

```ts
private async startSerialized(fromRespawn: boolean): Promise<void> {
  if (this.startInFlight) {
    await this.startInFlight;
    if (fromRespawn) return;
  }
  if (this.child) return;              // <-- returns before the streak reset
  const run = this.startOnce(fromRespawn);
  ...
}

private async startOnce(fromRespawn = false): Promise<void> {
  if (!fromRespawn) {
    this.exhausted = false;
    this.retryDelay = 0;               // <-- the only place the streak resets
    this.retryAttempts = 0;
  }
```

`if (this.child) return;` sits **before** `startOnce`, which is the only place
the streak is reset. A crash-looping command has a child almost always, so:

1. the operator presses start during a crash loop,
2. `this.child` is non-null, so `start()` returns immediately,
3. `startOnce` never runs, so the streak never resets,
4. the next failure continues from wherever it had climbed to.

The comment directly above the guard claimed this was already handled — that an
explicit start "MUST fall through so the backoff streak resets." It was the guard,
not the fall-through, that prevented it. The comment described the intent and the
code did the opposite.

### The fix

```ts
if (this.child) {
  if (!fromRespawn) this.resetStreak();
  return;
}
```

with the reset extracted so both paths mean the same thing:

```ts
private resetStreak(): void {
  this.exhausted = false;
  this.retryDelay = 0;
  this.retryAttempts = 0;
}
```

Two paths now reset for the same reason: an explicit start with a child already
running (returns early, no spawn) and an explicit start that goes on to spawn.

## What was NOT changed

A respawn must still not reset the streak. The original comment records why, and
it is a real bug that was fixed once already:

> A respawn must NOT clear the backoff: doing so made every retry start from the
> base delay again, so a crash-looping command was respawned forever at 2s with no
> escalation and no exhaustion.

`resetStreak()` is called only when `!fromRespawn`, so that behavior is intact,
and it remains covered by the suite (`no delay ever exceeds the configured
ceiling`, plus the dedicated respawn assertions). The fix moves the reset earlier
in one path; it does not add one to the other.

## Verified

```
--- 24 passed, 0 failed ---   x6 consecutive runs, 6/6 clean
  ok   an explicit start resets the streak (climbed to 8000 ms, now attempts=0)
  ok   the streak really had climbed before recovery (8000 ms > 1000 ms base)
  ok   after recovery the next failure restarts at the base delay (1000 ms, not 8000)
```

Note `attempts=0` where it previously read `attempts=1`. That is the same defect
showing up in a second observable: before the fix, the child's own exit within
the settle window bumped the freshly-reset streak to 1, because the reset had
never actually happened.

## The transferable lesson

**A predicate that is already true before the action you are testing cannot test
that action.** `<= baseDelay` when the value is the base is the shape of this.
Before trusting a poll-based assertion, check what the predicate evaluates to
*before* the thing it is waiting for happens. If it already holds, the assertion
is decorative — and it will be masking whatever is really there.

Non-vacuity was previously established for this suite only in the weak sense of
"mutants die." It is now established structurally: the suite asserts its own
precondition (`the streak really had climbed before recovery`) and fails loudly
if the precondition does not hold, rather than passing on a run where the
observation cannot mean anything.

No credentials, tokens, private keys, or connection details appear in this file.
