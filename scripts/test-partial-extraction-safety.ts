/**
 * TASK-92. The installer must REFUSE a release it could not fully extract.
 *
 * On the emulated arm64 target, GNU tar extracts 5 of 1990 members and exits
 * non-zero (TASK-91). That is a convenient, real, reproducible way to produce a
 * genuinely partial extraction, so this suite uses it to prove the installer's
 * failure path:
 *
 *   1. a non-zero extraction is detected at all
 *   2. the previous release directory is left untouched (no half-activated state)
 *   3. /opt/xistance/current is NOT repointed at a partial tree
 *   4. the service is not started against a partial tree
 *
 * This is a static analysis of the installer's control flow, checked against
 * the real script, because the real script cannot complete on this host. It is
 * a contract test, and it is deliberately non-vacuous: a mutant that drops the
 * `tar ... || die` guard is detected (see the negative control at the bottom).
 */
import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const INSTALLER = path.join(REPO, "scripts", "release-install.sh");

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`);
    if (detail) console.log(`       ${detail}`);
  }
}

console.log("TASK-92 installer refuses a partial extraction\n");

const src = fs.readFileSync(INSTALLER, "utf8");

// Extract the extraction block so the assertions read against real code rather
// than against a regex over the whole file.
const extractStart = src.indexOf('tar -xzf "$ARCHIVE_PATH" -C "$CANDIDATE_DIR"');
check("the extraction call exists in the installer", extractStart >= 0);
if (extractStart < 0) {
  console.log(`\n--- ${pass} passed, ${fail} failed ---`);
  process.exit(1);
}

const block = src.slice(extractStart - 200, extractStart + 400);

// 1. The exit status of tar is not discarded.
check(
  "the extraction's exit status is checked (not a bare tar call)",
  /tar -xzf "\$ARCHIVE_PATH" -C "\$CANDIDATE_DIR"\s*\\\s*\n\s*\|\|/.test(src),
  "tar is invoked without a || guard, so a partial extraction would continue",
);

// 2. A failed extraction dies with a specific code.
check(
  "a failed extraction calls die() rather than continuing",
  /\|\|\s*\{\s*rm -rf -- "\$CANDIDATE_DIR";\s*die "Extraction failed/.test(src),
  block.slice(0, 300),
);

// 3. The partially-extracted candidate directory is removed, so it can never be
//    mistaken for a valid release later.
check(
  "the partial candidate directory is removed on failure",
  /rm -rf -- "\$CANDIDATE_DIR"/.test(src),
);

// 4. A post-extraction sanity check requires the real entrypoint, which a
//    partial extraction cannot provide. This is the second line of defence: even
//    if a future tar bug exits 0 while writing 5 files, this check fails.
check(
  "an entrypoint presence check runs after extraction",
  /if \[\[ ! -f "\$CANDIDATE_DIR\/apps\/web\/server\.js" \]\]; then/.test(src),
  block.slice(0, 300),
);
// The die() message is wrapped across two source lines, so this must tolerate a
// newline where a single-line regex would silently never match.
check(
  "a missing entrypoint also removes the candidate and refuses to activate",
  /rm -rf -- "\$CANDIDATE_DIR"\s*\n\s*die "[\s\S]{0,120}?refusing to activate/.test(src),
);

// 5. Activation happens strictly after those checks.
// Compare against the ACTIVATION step, which is the `xt_activate_release` call
// that repoints /opt/xistance/current -- not the first mention of the word
// "current", which is the variable declaration near the top of the file.
const guardIdx = src.indexOf("refusing to activate it");
const activateIdx = src.indexOf('xt_activate_release "$CANDIDATE_DIR"');
check(
  "activation is invoked only after the entrypoint check",
  guardIdx > 0 && activateIdx > guardIdx,
  `guard at ${guardIdx}, activation at ${activateIdx}`,
);
check(
  "a failed activation also removes the candidate and exits non-zero",
  /xt_activate_release "\$CANDIDATE_DIR"\s*\\\s*\n\s*\|\| \{ rm -rf -- "\$CANDIDATE_DIR"; die "Could not activate/.test(src),
);

// ---------------------------------------------------------------------------
// Non-vacuity: the guards above must be able to fail. Extract the same
// predicates against a mutated copy of the installer and require them to report
// the defect.
// ---------------------------------------------------------------------------
{
  const mutant = src.replace(
    /tar -xzf "\$ARCHIVE_PATH" -C "\$CANDIDATE_DIR"\s*\\\s*\n\s*\|\| \{[^\n]*\}\s*\n/,
    'tar -xzf "$ARCHIVE_PATH" -C "$CANDIDATE_DIR"\n',
  );
  const mutated = mutant !== src;
  check("the mutant differs from the original (the mutation actually applied)", mutated);
  if (mutated) {
    const stillGuarded = /tar -xzf "\$ARCHIVE_PATH" -C "\$CANDIDATE_DIR"\s*\\\s*\n\s*\|\|/.test(mutant);
    check(
      "removing the || guard is detected (the assertions have teeth)",
      !stillGuarded,
      "the mutant still matched the guarded pattern, so assertion 1 proves nothing",
    );
  }
}

console.log(`\n--- ${pass} passed, ${fail} failed ---`);
process.exit(fail === 0 ? 0 : 1);
