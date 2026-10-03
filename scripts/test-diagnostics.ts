/**
 * Diagnostics contract tests (TASK-22).
 *
 * The task's technical note is the real constraint here: diagnostics must
 * never include command lines containing passwords, tokens, or private keys.
 * The engine's own plan holds the full argv for every process, so any helper
 * that reports "what failed" is one careless string join away from leaking a
 * decrypted secret into an API response, a log line, and the browser.
 *
 * These tests assert the sanitised payload directly, including against inputs
 * built to look like real secrets.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  DIAGNOSTIC_ERROR_CATEGORIES,
  DiagnosticErrorCategory,
  RecoveryAction,
  buildDiagnostic,
  classifyError,
  diagnosticStore,
  nextRecoveryAction,
  sanitizeForDiagnostics,
} from "../packages/tunnel-core/src/diagnostics.ts";

let pass = 0;
const failures: string[] = [];
const ok = (n: string): void => {
  pass += 1;
  console.log(`  ok   ${n}`);
};
const bad = (n: string, d: string): void => {
  failures.push(n);
  console.log(`  FAIL ${n}\n       ${d}`);
};

async function main(): Promise<void> {
  try {
    // ---------------------------------------------------------------------
    // 0. A representative secret must not survive sanitisation.
    // ---------------------------------------------------------------------
    {
      const nasty = [
        "gost -L relay://:443 -F node.example.com:7000",
        "ssh -i /etc/xistance/id_ed25519 root@10.0.0.5",
        "autossh -M 0 -N -o PasswordAuthentication=no user@h",
        "frpc --token s3cr3t-token-value --server_addr x",
        "xray run -c /etc/xistance/config.json",
        "-p hunter2",
        "--password hunter2",
        "password=hunter2",
        "token: abc123DEF",
        "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----",
      ];
      for (const s of nasty) {
        const out = sanitizeForDiagnostics(s);
        assert.ok(typeof out === "string");
        for (const leak of ["hunter2", "s3cr3t-token-value", "abc123DEF", "id_ed25519", "b3BlbnNzaC1rZXktdjEAAAAA"]) {
          if (out.includes(leak)) {
            bad(`sanitising ${JSON.stringify(s.slice(0, 30))}`, `leaked ${leak}: ${out}`);
          }
        }
      }
      ok("secrets and key material are redacted from command text");
    }

    // ---------------------------------------------------------------------
    // 1. Non-secret identifying detail survives (diagnostics must stay useful).
    // ---------------------------------------------------------------------
    {
      const out = sanitizeForDiagnostics("gost -L relay://:443 -F node.example.com:7000");
      if (out.includes("gost") && out.includes("443")) {
        ok("the program name and ports are preserved so diagnostics stay actionable");
      } else {
        bad("the program name and ports are preserved", out);
      }
    }

    // ---------------------------------------------------------------------
    // 2. Classification buckets errors into a fixed, known set.
    // ---------------------------------------------------------------------
    {
      const cases: Array<[string, DiagnosticErrorCategory]> = [
        ["ssh: connect to host 10.0.0.5 port 22: Connection refused", "unreachable"],
        ["EACCES: permission denied, open '/var/lib/xistance/x.db'", "permission"],
        ["no space left on device", "resource"],
        ["tunnel binary not found: gost", "missing_binary"],
        ["config parse failed at line 3", "configuration"],
        // Authentication must win over the generic permission match, or an
        // operator is told to chmod their way out of a bad key.
        ["Permission denied (publickey).", "authentication"],
        ["Host key verification failed.", "authentication"],
        ["ssh: connect to host 10.0.0.5 port 22: Operation timed out", "timeout"],
        ["something entirely unexpected happened", "unknown"],
      ];
      let mismatches = 0;
      for (const [input, expected] of cases) {
        const got = classifyError(input);
        if (got !== expected) {
          mismatches += 1;
          bad(`classify ${JSON.stringify(input.slice(0, 32))}`, `expected ${expected}, got ${got}`);
        }
      }
      if (mismatches === 0) ok(`all ${cases.length} error shapes classify into the known set`);
      for (const c of DIAGNOSTIC_ERROR_CATEGORIES) {
        if (!cases.some(([, e]) => e === c) && c !== "unknown") {
          bad("every declared category is reachable from a real message", `${c} is never produced`);
        }
      }
    }

    // ---------------------------------------------------------------------
    // 3. A failed runtime produces the full contract, with no secrets.
    // ---------------------------------------------------------------------
    {
      const d = buildDiagnostic({
        status: "error",
        error: "ssh: connect to host 10.0.0.5 port 22: Connection refused -- -p hunter2",
        retryCount: 3,
        now: 1_700_000_000_000,
      });
      const payload = JSON.stringify(d);
      if (payload.includes("hunter2")) bad("the diagnostic payload hides the password", payload);
      else ok("the diagnostic payload hides the password");

      for (const field of ["state", "lastTransitionAt", "errorCategory", "retryCount", "nextAction", "summary"]) {
        if (!(field in d)) bad(`the diagnostic exposes ${field}`, Object.keys(d).join(","));
      }
      ok("the diagnostic exposes state, transition, category, retries, action and summary");
      if (d.retryCount === 3) ok("the retry count is reported");
      else bad("the retry count is reported", String(d.retryCount));
      if (d.errorCategory === "unreachable") ok("the error category is derived from the message");
      else bad("the error category is derived", String(d.errorCategory));
      if (typeof d.nextAction === "string" && (d.nextAction as string).length > 0) {
        ok("a recovery action is offered");
      } else {
        bad("a recovery action is offered", String(d.nextAction));
      }
      if (d.lastTransitionAt === 1_700_000_000_000) ok("the last transition time is recorded");
      else bad("the last transition time is recorded", String(d.lastTransitionAt));
    }

    // ---------------------------------------------------------------------
    // 4. A healthy runtime has no error category and no retry noise.
    // ---------------------------------------------------------------------
    {
      const d = buildDiagnostic({ status: "running", now: 1 });
      if (d.errorCategory === null) ok("a running tunnel reports no error category");
      else bad("a running tunnel reports no error category", String(d.errorCategory));
      if (d.retryCount === 0) ok("a running tunnel reports no retries");
      else bad("a running tunnel reports no retries", String(d.retryCount));
    }

    // ---------------------------------------------------------------------
    // 5. Recovery actions are bounded and state-appropriate.
    // ---------------------------------------------------------------------
    {
      const exhausted = nextRecoveryAction({ errorCategory: "unreachable", retryCount: 50, exhausted: true });
      if (exhausted !== RecoveryAction.RESTART) {
        bad("an exhausted tunnel is told to restart", String(exhausted));
      } else {
        ok("an exhausted tunnel is told to restart");
      }
      const retrying = nextRecoveryAction({ errorCategory: "unreachable", retryCount: 1, exhausted: false });
      if (retrying === RecoveryAction.RETRY || retrying === RecoveryAction.WAIT) {
        ok("a retrying tunnel is told to wait or retry");
      } else {
        bad("a retrying tunnel is told to wait or retry", String(retrying));
      }
      const healthy = nextRecoveryAction({ errorCategory: null, retryCount: 0, exhausted: false });
      if (healthy === RecoveryAction.NONE) ok("a healthy tunnel needs no action");
      else bad("a healthy tunnel needs no action", String(healthy));
    }

    // ---------------------------------------------------------------------
    // 6. Retention is bounded: a long-running engine must not grow forever.
    // ---------------------------------------------------------------------
    {
      const store = diagnosticStore(5);
      for (let i = 0; i < 50; i += 1) {
        store.record("t1", buildDiagnostic({ status: "error", error: "no space left on device", retryCount: i, now: i }));
      }
      const all = store.list("t1");
      if (all.length <= 5) ok(`retention is bounded (${all.length} kept of 50 recorded)`);
      else bad("retention is bounded", `${all.length} retained`);
      if (all.length > 0) {
        // The newest must survive, not the oldest.
        if (all[all.length - 1].retryCount === 49) ok("the newest diagnostic is the one retained");
        else bad("the newest diagnostic is the one retained", `newest retryCount=${all[all.length - 1].retryCount}`);
      }
      if (store.list("t1").length <= 5) ok("repeat reads do not grow the store");
      else bad("repeat reads do not grow the store", String(store.list("t1").length));
    }

    // ---------------------------------------------------------------------
    // 7. Per-tunnel isolation.
    // ---------------------------------------------------------------------
    {
      const store = diagnosticStore(3);
      store.record("a", buildDiagnostic({ status: "error", error: "no space left on device", now: 1 }));
      store.record("b", buildDiagnostic({ status: "error", error: "no space left on device", now: 2 }));
      if (store.list("a").length === 1 && store.list("b").length === 1) ok("diagnostics are isolated per tunnel");
      else bad("diagnostics are isolated per tunnel", `a=${store.list("a").length} b=${store.list("b").length}`);
      store.clear("a");
      if (store.list("a").length === 0 && store.list("b").length === 1) ok("clearing one tunnel keeps the other");
      else bad("clearing one tunnel keeps the other", `a=${store.list("a").length} b=${store.list("b").length}`);
    }

    // ---------------------------------------------------------------------
    // 8. Both locale catalogs cover the closed sets exhaustively.
    //
    // A new error category that has no translation renders as a raw key in the
    // UI, which is exactly the "not localized" failure the task forbids. This
    // asserts exhaustiveness in both directions, and that the two catalogs
    // have identical key sets.
    // ---------------------------------------------------------------------
    {
      const en = JSON.parse(readFileSync(new URL("../packages/i18n/messages/en.json", import.meta.url), "utf8"));
      const fa = JSON.parse(readFileSync(new URL("../packages/i18n/messages/fa.json", import.meta.url), "utf8"));
      const cat = en.diagnostics?.category ?? {};
      const act = en.diagnostics?.action ?? {};
      for (const c of DIAGNOSTIC_ERROR_CATEGORIES) {
        if (!cat[c]) bad(`en.json has a label for category ${c}`, "missing");
        if (!fa.diagnostics?.category?.[c]) bad(`fa.json has a label for category ${c}`, "missing");
      }
      for (const a of Object.values(RecoveryAction)) {
        if (!act[a]) bad(`en.json has a label for action ${a}`, "missing");
        if (!fa.diagnostics?.action?.[a]) bad(`fa.json has a label for action ${a}`, "missing");
      }
      const enActs = Object.keys(act).sort().join(",");
      const faActs = Object.keys(fa.diagnostics?.action ?? {}).sort().join(",");
      if (enActs === faActs) ok("both catalogs expose the same recovery actions");
      else bad("both catalogs expose the same recovery actions", `en=${enActs} fa=${faActs}`);
      const enCats = Object.keys(cat).sort().join(",");
      const faCats = Object.keys(fa.diagnostics?.category ?? {}).sort().join(",");
      if (enCats === faCats) ok("both catalogs expose the same error categories");
      else bad("both catalogs expose the same error categories", `en=${enCats} fa=${faCats}`);
      // No untranslated leftovers: a Persian value identical to its English
      // counterpart is almost always a copy/paste miss.
      let untranslated = 0;
      for (const k of Object.keys(cat)) {
        if (fa.diagnostics.category[k] === cat[k]) untranslated += 1;
      }
      if (untranslated === 0) ok("no Persian category label is left as the English string");
      else bad("no Persian category label is left as the English string", `${untranslated} identical`);
    }

    console.log(`\n--- ${pass} passed, ${failures.length} failed ---`);
    if (failures.length > 0) process.exitCode = 1;
  } finally {
    /* nothing to clean */
  }
}

void main();
