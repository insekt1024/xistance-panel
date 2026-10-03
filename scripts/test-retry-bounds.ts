/**
 * Bounded retry / respawn tests (TASK-20).
 *
 * These use an injected scheduler rather than real time, so "never spins" and
 * "never exceeds the ceiling" are asserted exactly instead of approximated by
 * sleeping. Real waits would make a 30-second ceiling untestable in CI.
 *
 * The defects these pin are real:
 *  - the respawn timer was never nulled when it fired, so `stop()` believed a
 *    retry was pending after it had already run;
 *  - `start()` was unserialised. Right after an exit `child` is null, so a
 *    manual start and a scheduled respawn both passed the guard and both
 *    spawned, leaving a process nothing tracked;
 *  - retries were unbounded: a command that failed instantly, forever, kept
 *    respawning at the ceiling with no terminal state.
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ChildProcessHandle,
  clampRetryPolicy,
  type ProcessSpec,
  type RetryScheduler,
  type RetryTimer,
} from "../packages/tunnel-core/src/process.ts";

const work = mkdtempSync(path.join(os.tmpdir(), "xistance-retry-"));

/** Deterministic clock: nothing fires until the test advances it. */
/**
 * Wait for a condition, polling, instead of sleeping a fixed amount.
 *
 * Fourteen assertions in this suite used a bare `setTimeout(r, N)` to let a real
 * child process fail before checking that a retry had been scheduled. That only
 * works on an unloaded machine. Under 8 background CPU workers it reproduced
 * 7 failures out of 8 runs, always the same assertion, "a retry is genuinely
 * pending before stop" — the child had not exited yet, so no timer existed yet.
 *
 * The product was fine; the test was asserting a wall-clock guess. Every wait
 * that exists to let something HAPPEN should be a poll for the thing it is
 * about, with a bounded deadline so a genuine regression still fails instead of
 * hanging.
 */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 5_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 10));
  }
}

class FakeClock implements RetryScheduler {
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  current = 0;
  liveTimers = 0;

  setTimeout(fn: () => void, ms: number): RetryTimer {
    const id = ++this.seq;
    this.timers.set(id, { at: this.current + Math.max(0, ms), fn });
    this.liveTimers = this.timers.size;
    return id;
  }
  clearTimeout(timer: RetryTimer): void {
    this.timers.delete(timer as number);
    this.liveTimers = this.timers.size;
  }
  now(): number {
    return this.current;
  }
  /** Advance time, firing due timers in order. */
  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    for (;;) {
      let nextId: number | null = null;
      let nextAt = Number.POSITIVE_INFINITY;
      for (const [id, t] of this.timers) {
        if (t.at < nextAt) {
          nextAt = t.at;
          nextId = id;
        }
      }
      if (nextId === null || nextAt > target) break;
      const timer = this.timers.get(nextId)!;
      this.timers.delete(nextId);
      this.liveTimers = this.timers.size;
      this.current = nextAt;
      timer.fn();
      // Let the callback's async work settle before the next timer.
      await new Promise((r) => setImmediate(r));
    }
    this.current = target;
  }
}

let pass = 0;
const failures: string[] = [];
const ok = (name: string): void => {
  pass += 1;
  console.log(`  ok   ${name}`);
};
const bad = (name: string, detail: string): void => {
  failures.push(name);
  console.log(`  FAIL ${name}\n       ${detail}`);
};

function specFor(id: string, retry?: ProcessSpec["retry"]): ProcessSpec {
  return {
    id,
    name: id,
    // A command that exits immediately, so a respawn is observable as a new
    // exit without waiting for anything real.
    command: [process.execPath, "-e", "process.exit(1)"],
    dataDir: work,
    unitName: `xt-${id}`,
    autorestart: true,
    retry,
  };
}

async function main(): Promise<void> {
  try {
    // ---------------------------------------------------------------------
    // 0. The policy clamps hostile input into safe bounds.
    // ---------------------------------------------------------------------
    {
      const p = clampRetryPolicy({ baseDelayMs: -5, maxDelayMs: Infinity, maxAttempts: 0, resetAfterMs: NaN });
      if (p.baseDelayMs > 0 && Number.isFinite(p.baseDelayMs)) ok("a negative base delay is clamped to a positive bound");
      else bad("negative base delay clamped", JSON.stringify(p));
      if (Number.isFinite(p.maxDelayMs)) ok("an infinite max delay is clamped to a finite ceiling");
      else bad("infinite max delay clamped", String(p.maxDelayMs));
      if (p.maxAttempts === null || p.maxAttempts >= 1) ok("a zero attempt ceiling is clamped to at least one attempt");
      else bad("zero attempts clamped", String(p.maxAttempts));
      if (Number.isFinite(p.resetAfterMs)) ok("a NaN reset window is replaced with a finite default");
      else bad("NaN reset window replaced", String(p.resetAfterMs));

      const unset = clampRetryPolicy(undefined);
      assert.ok(unset.baseDelayMs >= 100, "the default base delay must be a sane floor");
      ok("an unset policy falls back to safe defaults");
    }

    // ---------------------------------------------------------------------
    // 1. Rapid repeated failure: delays grow and never exceed the ceiling,
    //    and the attempt count is bounded.
    // ---------------------------------------------------------------------
    {
      const clock = new FakeClock();
      const handle = new ChildProcessHandle(
        specFor("rapid", { baseDelayMs: 1_000, maxDelayMs: 8_000, maxAttempts: 4 }),
        clock,
      );
      const delays: number[] = [];
      const record = setInterval(() => {
        const s = handle.retryState();
        if (s.lastDelayMs > 0) delays.push(s.lastDelayMs);
      }, 1);
      await handle.start();
      // Each cycle: the child exits, a retry is scheduled, the retry respawns
      // and exits again. Four attempts are allowed.
      for (let i = 0; i < 12; i += 1) {
        await clock.advance(60_000);
        await new Promise((r) => setTimeout(r, 30));
      }
      clearInterval(record);
      await handle.dispose();

      const unique = [...new Set(delays)];
      const monotonic = unique.every((d, i) => i === 0 || d >= unique[i - 1]);
      if (monotonic && unique.length > 0) ok(`repeated failure backs off (${unique.join(" -> ")} ms)`);
      else bad("repeated failure backs off", unique.join(" -> "));
      if (unique.every((d) => d <= 8_000)) ok("no delay ever exceeds the configured ceiling");
      else bad("no delay exceeds the ceiling", unique.join(" -> "));
      if (unique.every((d) => d > 0)) ok("no delay is ever zero (no tight loop)");
      else bad("no delay is ever zero", unique.join(" -> "));
    }

    // ---------------------------------------------------------------------
    // 2. Terminal failure: after the ceiling the handle reports exhausted and
    //    schedules nothing further.
    // ---------------------------------------------------------------------
    {
      const clock = new FakeClock();
      const handle = new ChildProcessHandle(
        specFor("terminal", { baseDelayMs: 100, maxDelayMs: 400, maxAttempts: 3 }),
        clock,
      );
      await handle.start();
      // Each iteration advances virtual time far enough to fire any pending
      // timer, then WAITS for the resulting cycle to actually complete. The
      // child is a real process: spawn + exit are asynchronous and take longer
      // than a fixed sleep allows on a loaded machine. Advancing the fake clock
      // without waiting just moves time forward while the handle is still
      // mid-spawn, so the retry sequence never accumulates enough attempts to
      // reach the ceiling -- and the test failed for that reason, reporting a
      // product defect that was not there.
      for (let i = 0; i < 10; i += 1) {
        const before = handle.retryState().attempts + (handle.retryState().exhausted ? 1 : 0);
        await clock.advance(10_000);
        // Settle: either the handle reached a new attempt/exhausted state, or
        // give the async spawn/exit a bounded chance to complete.
        await waitFor(() => {
          const s = handle.retryState();
          return s.exhausted || s.attempts + (s.exhausted ? 1 : 0) > before;
        }, `retry cycle ${i + 1} to take effect`);
        await new Promise((r) => setTimeout(r, 5));
      }
      const state = handle.retryState();
      if (state.exhausted) ok("repeated failure reaches an explicit terminal state");
      else bad("repeated failure reaches a terminal state", JSON.stringify(state));
      if (state.nextDelayMs === null) ok("no next delay is advertised once exhausted");
      else bad("no next delay once exhausted", String(state.nextDelayMs));
      if (clock.liveTimers === 0) ok("an exhausted handle holds no pending timer");
      else bad("an exhausted handle holds no pending timer", String(clock.liveTimers));
      await handle.dispose();
    }

    // ---------------------------------------------------------------------
    // 3. Stop during backoff cancels the pending retry; nothing respawns.
    // ---------------------------------------------------------------------
    {
      const clock = new FakeClock();
      const handle = new ChildProcessHandle(
        specFor("stopmid", { baseDelayMs: 5_000, maxDelayMs: 30_000, maxAttempts: null }),
        clock,
      );
      await handle.start();
      // Poll for the pending retry instead of sleeping a fixed 40ms: the child
      // has to actually exit before a retry is scheduled, and that takes longer
      // than 40ms whenever the machine is busy.
      const becamePending = await waitFor(() => clock.liveTimers > 0, "a retry to be scheduled");
      const pendingBefore = clock.liveTimers;
      if (!becamePending) bad("the child never failed, so no retry was scheduled", "timed out after 5s");
      await handle.stop();
      const pendingAfter = clock.liveTimers;
      if (pendingBefore > 0) ok("a retry is genuinely pending before stop");
      else bad("a retry is pending before stop", String(pendingBefore));
      if (pendingAfter === 0) ok("stop cancels the pending retry");
      else bad("stop cancels the pending retry", `${pendingAfter} still scheduled`);

      // Even after a long wait, nothing may come back.
      await clock.advance(600_000);
      await new Promise((r) => setTimeout(r, 40));
      if ((await handle.isRunning()) === false) ok("nothing respawns after an intentional stop");
      else bad("nothing respawns after an intentional stop", "the handle is running");
      if (clock.liveTimers === 0) ok("no timer is left behind after stop");
      else bad("no timer left after stop", String(clock.liveTimers));
    }

    // ---------------------------------------------------------------------
    // 4. The fired timer is cleared, so stop() does not think a retry is
    //    pending after it has already run.
    // ---------------------------------------------------------------------
    {
      const clock = new FakeClock();
      const handle = new ChildProcessHandle(
        specFor("cleared", { baseDelayMs: 50, maxDelayMs: 50, maxAttempts: 2 }),
        clock,
      );
      await handle.start();
      await new Promise((r) => setTimeout(r, 30));
      await clock.advance(60);
      await new Promise((r) => setTimeout(r, 30));
      // Force another exit so a retry is pending, then consume it.
      await clock.advance(60);
      await new Promise((r) => setTimeout(r, 30));
      const consumed = clock.liveTimers;
      // Firing the last timer must leave the handle with no stale reference:
      // stop() after a consumed retry must not report a pending timer.
      await clock.advance(10_000);
      await new Promise((r) => setTimeout(r, 30));
      await handle.stop();
      if (clock.liveTimers === 0) ok("after the retry fires, no timer remains registered (consumed was " + consumed + ")");
      else bad("fired timer is cleared", String(clock.liveTimers));
    }

    // ---------------------------------------------------------------------
    // 5. Concurrent starts must spawn exactly ONE child.
    //
    // The defect is invisible from the handle's own state: it only ever tracks
    // one pid, so the orphan is unobservable from outside. The count is
    // therefore taken at the OS boundary -- each spawned child appends a line
    // to a marker file, and the test counts the lines.
    //
    // A first attempt at this test used a fake clock and only compared pids
    // from the handle itself, so it passed against the unserialised code and
    // proved nothing.
    // ---------------------------------------------------------------------
    {
      const marker = path.join(work, "spawn-count.txt");
      const script = `require("fs").appendFileSync(${JSON.stringify(marker)}, "x"); setTimeout(() => process.exit(0), 400);`;
      const clock = new FakeClock();
      const handle = new ChildProcessHandle(
        {
          id: "concurrent",
          name: "concurrent",
          command: [process.execPath, "-e", script],
          dataDir: path.join(work, "concurrent"),
          unitName: "xt-concurrent",
          autorestart: true,
          retry: { baseDelayMs: 10_000, maxDelayMs: 10_000, maxAttempts: null },
        },
        clock,
      );
      await Promise.all([handle.start(), handle.start(), handle.start()]);
      // Let every child that was spawned actually run its script.
      await new Promise((r) => setTimeout(r, 250));
      const spawned = existsSync(marker) ? readFileSync(marker, "utf8").length : 0;
      if (spawned === 1) ok("three concurrent starts spawn exactly one child");
      else bad("three concurrent starts spawn exactly one child", `${spawned} children were spawned`);
      // A no-op start while running must not add another.
      await handle.start();
      await new Promise((r) => setTimeout(r, 150));
      const after = existsSync(marker) ? readFileSync(marker, "utf8").length : 0;
      if (after === spawned) ok("a start while already running spawns nothing");
      else bad("a start while already running spawns nothing", `${spawned} -> ${after}`);
      await handle.stop();
    }

    // ---------------------------------------------------------------------
    // 6. autorestart: false means no retry is ever scheduled.
    // ---------------------------------------------------------------------
    {
      const clock = new FakeClock();
      const spec = specFor("noauto");
      spec.autorestart = false;
      const handle = new ChildProcessHandle(spec, clock);
      await handle.start();
      await new Promise((r) => setTimeout(r, 40));
      if (clock.liveTimers === 0) ok("autorestart:false schedules no retry");
      else bad("autorestart:false schedules no retry", String(clock.liveTimers));
      await handle.dispose();
    }

    // ---------------------------------------------------------------------
    // 7. A successful long run resets the streak, so the next drop starts
    //    from the base delay rather than the ceiling.
    // ---------------------------------------------------------------------
    {
      const clock = new FakeClock();
      // Named so the assertion below cannot silently drift from the spec it
      // checks. A hardcoded 1_000 in the comparison would be indistinguishable
      // from the vacuous poll this replaced.
      const baseDelayMs = 1_000;
      const handle = new ChildProcessHandle(
        specFor("recover", { baseDelayMs, maxDelayMs: 30_000, maxAttempts: null }),
        clock,
      );
      await handle.start();
      // Drive failures so the delay genuinely climbs. Each round must WAIT for
      // the failure to be observed before advancing again: the respawn timer
      // fires `void this.startSerialized(true)`, an un-awaited async spawn, and
      // the NEXT retry timer is only registered once that spawn's process has
      // exited. Advancing on a fixed `setTimeout(25)` races that, so only the
      // first failure was ever driven and the streak never left the base delay.
      //
      // This is why `climbed` used to read 1_000 ms: the loop looked like it was
      // driving four failures and was driving one.
      for (let i = 0; i < 4; i += 1) {
        const seen = handle.retryState().lastDelayMs;
        // Wait until the delay has actually moved on from the previous round.
        await waitFor(
          () => handle.retryState().lastDelayMs !== seen,
          `failure ${i + 1} to be scheduled`,
        );
        await clock.advance(90_000);
      }
      const climbed = handle.retryState().lastDelayMs;
      // An explicit start is what a successful recovery looks like: the streak
      // and the pending delay must reset, so the NEXT failure schedules from
      // the base delay rather than continuing to climb. lastDelayMs is history
      // and is deliberately not cleared, so the next *scheduled* delay is the
      // thing to observe.
      await handle.start();
      await new Promise((r) => setTimeout(r, 30));
      const after = handle.retryState();
      // Deliberately NOT asserting attempts === 0 here: this spec's child exits
      // immediately, so a reset streak is bumped to 1 by its own exit within the
      // settle window. That assertion was racy and only passed by timing luck.
      // The meaningful, deterministic check is the one below: after recovery the
      // NEXT failure must schedule from the base delay, not continue climbing.
      if (after.attempts <= 1) {
        ok(`an explicit start resets the streak (climbed to ${climbed} ms, now attempts=${after.attempts})`);
      } else {
        bad("an explicit start resets the streak", `attempts=${after.attempts} after climbing to ${climbed} ms`);
      }
      if (after.exhausted === false) ok("an explicit start clears the exhausted flag");
      else bad("an explicit start clears the exhausted flag", "still exhausted");
      // Drop the child again and confirm the next retry restarts from the base
      // rather than continuing to climb.
      //
      // The arithmetic this is checking, from the product's own
      // `scheduleRetry`: `raw = retryDelay === 0 ? base : min(retryDelay * 2, max)`.
      // An explicit start() sets retryDelay = 0, so the very next failure is the
      // `retryDelay === 0` branch and schedules at `base` -- NOT 2 * base.
      //
      // That the pre-kill value is the CLIMBED one is what makes the observation
      // mean something: if the streak had reset earlier, beforeKill would already
      // be `base` and this could not distinguish a reset from a continuation.
      // So the value that changes is the proof, and the value it changes TO is
      // asserted exactly.
      //
      // The previous poll was `lastDelayMs <= 1_000` -- which is this spec's own
      // baseDelayMs. The condition was already true before the kill and stayed
      // true after it, so it could not distinguish a reschedule from a no-op, and
      // the only reason it ever failed was the exit event being slow under load.
      //
      // `climbed` -- captured at line 376, BEFORE the explicit start -- is the
      // value that proves the streak really climbed. Re-reading `lastDelayMs`
      // here is wrong: this spec's child exits immediately, so the explicit
      // start()'s own exit lands within the settle window above and has already
      // rescheduled the delay back to the base. Reading it here therefore
      // returned the BASE value and the assertion could never pass under load,
      // which is exactly the intermittent failure this comment replaced.
      //
      // The original source of the error: this block asserted a property of the
      // state at a point in time where that state had legitimately changed.
      // Capture the evidence when it is true, and assert on the capture.
      const beforeKill = climbed;
      if (beforeKill > baseDelayMs) {
        ok(`the streak really had climbed before recovery (${beforeKill} ms > ${baseDelayMs} ms base)`);
      } else {
        bad(
          "the streak really had climbed before recovery",
          `climbed delay was only ${beforeKill} ms, so the post-kill reading proves nothing`,
        );
      }
      const pid = await handle.pid();
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already exited */
        }
      }
      // The exit handler is ASYNCHRONOUS: SIGKILL returns immediately and the
      // 'exit' event lands on a later tick, so a single read races it.
      //
      // Poll for the STATE WE WANT, not for a transition. The earlier version
      // polled `lastDelayMs !== beforeKill` -- i.e. "it changed" -- which is
      // wrong now that beforeKill is the climbed capture: this spec's child exits
      // immediately, so the explicit start()'s own exit may already have moved the
      // delay to the base BEFORE the kill, and the poll would then wait for a
      // change that never comes. Waiting for a difference to observe a value is
      // the inverse of what is being asserted; waiting for the value itself is
      // correct whether it arrived early or late.
      const settled = await waitFor(
        () => handle.retryState().lastDelayMs === baseDelayMs,
        "the next failure to schedule at the base delay",
      );
      const rescheduled = handle.retryState().lastDelayMs;
      if (!settled) {
        bad(
          "after recovery the next failure restarts at the base delay",
          `still ${rescheduled} ms after the kill, expected ${baseDelayMs} ms (climbed to ${climbed})`,
        );
      } else if (rescheduled !== baseDelayMs) {
        bad(
          "after recovery the next failure restarts at the base delay",
          `rescheduled at ${rescheduled} ms, expected the ${baseDelayMs} ms base (climbed to ${climbed})`,
        );
      } else {
        ok(`after recovery the next failure restarts at the base delay (${rescheduled} ms, not ${climbed})`);
      }
      await handle.dispose();
    }

    // ---------------------------------------------------------------------
    // 8. The real spawn path still works and the retry is a genuine process.
    // ---------------------------------------------------------------------
    {
      const dir = path.join(work, "real");
      const handle = new ChildProcessHandle(
        {
          id: "real",
          name: "real",
          command: [process.execPath, "-e", "setTimeout(() => process.exit(0), 10)"],
          dataDir: dir,
          unitName: "xt-real",
          autorestart: false,
        },
        new FakeClock(),
      );
      await handle.start();
      const running = await handle.isRunning();
      await handle.dispose();
      if (running) ok("a real child process is tracked as running");
      else bad("a real child process is tracked as running", "isRunning() was false");
    }

    console.log(`\n--- ${pass} passed, ${failures.length} failed ---`);
    if (failures.length > 0) process.exitCode = 1;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

void main();
