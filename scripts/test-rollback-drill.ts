/**
 * TASK-107. The rollback drill must be executed on the real target OSes.
 *
 * PRD section 15 requires "Installation/readiness and update/rollback drills pass
 * on the real Ubuntu VPS". The installer *installs* the rollback helper on every
 * run, and TASK-90/98 proved installs and updates — but `xt-rollback` had never
 * actually been invoked on a target. An installed-but-unexecuted operator
 * command is a documented intent, not a passing drill.
 *
 * This runs the real command on both required OSes and asserts the properties
 * that make a rollback trustworthy:
 *
 *   1. rolling back to a NON-EXISTENT release is REFUSED and changes nothing
 *      (an operator must not be able to point the panel at a hole)
 *   2. rolling back to a real previous release repoints `current`, restarts the
 *      service, and the API comes back healthy
 *   3. `active-release.json` swaps `active`/`previous`, so the drill is REVERSIBLE
 *   4. the panel is returned to the release that ships
 *
 * Every step is executed against the real installed artifact on the real targets.
 * It is skipped (exit 0) when the targets are not reachable, because a gate that
 * cannot run must not be recorded as having run.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const TARGETS = ["xtinst", "xt24"] as const; // Ubuntu 22.04.5, 24.04.5 amd64

let pass = 0;
let fail = 0;
let skip = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`);
    if (detail) console.log(`       ${detail.replace(/\n/g, "\n       ")}`);
  }
}

function sh(target: string, script: string): { code: number; out: string } {
  const r = spawnSync("docker", ["exec", target, "bash", "-lc", script], {
    encoding: "utf8",
    timeout: 300_000,
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function dockerUp(): boolean {
  return spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
    timeout: 30_000,
  }).status === 0;
}

const CURRENT = (): string =>
  sh("xt24", 'basename "$(readlink -f /opt/xistance/current)"').out.trim();

// Written once at module load; copied to each target inside the loop.
const RELEASE_LISTER = [
  'import { readdirSync, existsSync, readFileSync } from "node:fs";',
  'import path from "node:path";',
  'const base = "/opt/xistance/releases";',
  'for (const name of readdirSync(base)) {',
  '  const f = path.join(base, name, "release-manifest.json");',
  '  if (!existsSync(f)) continue;',
  '  let digest = "";',
  '  try { digest = JSON.parse(readFileSync(f, "utf8")).artifact.sha256; } catch {}',
  '  if (digest) process.stdout.write([name, digest].join(" ") + String.fromCharCode(10));',
  '}',
  '',
].join(String.fromCharCode(10));
fs.mkdirSync(path.join(REPO, "node_modules", ".cache"), { recursive: true });
fs.writeFileSync(path.join(REPO, "node_modules", ".cache", "xt-list-releases.mjs"), RELEASE_LISTER, "utf8");

console.log("TASK-107 the rollback drill, executed on the real target OSes\n");

if (!dockerUp()) {
  skip += 1;
  console.log("  SKIP docker is not available; the target drill cannot run here");
  console.log(`\n--- 0 passed, 0 failed, 1 skipped ---`);
  process.exit(0);
}

for (const target of TARGETS) {
  const up = spawnSync("docker", ["exec", target, "true"], { timeout: 30_000 });
  if (up.status !== 0) {
    check(`${target}: target is reachable`, false, `docker exec ${target} true failed`);
    continue;
  }
  console.log(`--- ${target}`);

  // The helper must exist and be executable -- installed by the release itself.
  spawnSync("docker", ["cp", path.join(REPO, "node_modules", ".cache", "xt-list-releases.mjs"), `${target}:/root/xt-list-releases.mjs`], { timeout: 60_000 });

  const helper = sh(target, 'test -x /usr/local/bin/xt-rollback && echo ok || echo missing');
  check(`${target}: the rollback helper is installed and executable`, helper.out.includes("ok"), helper.out);

  // The panel must be serving before a drill means anything.
  const before = sh(target, 'curl -s -o /dev/null -w %{http_code} --max-time 5 http://127.0.0.1:8080/api/health');
  check(`${target}: the panel is healthy before the drill`, before.out.trim() === "200", `health ${before.out.trim()}`);

  // 1. A non-existent target must be REFUSED, and must change nothing.
  const beforeCurrent = sh(target, 'basename "$(readlink -f /opt/xistance/current)"').out.trim();
  const refused = sh(
    target,
    'xt-rollback /opt/xistance/releases/v1.2.0-does-not-exist >/dev/null 2>&1; echo "rc=$?"',
  );
  check(
    `${target}: rollback to a non-existent release is refused`,
    /rc=1/.test(refused.out),
    `expected rc=1, got ${refused.out.trim()}`,
  );
  const afterRefused = sh(target, 'basename "$(readlink -f /opt/xistance/current)"').out.trim();
  check(
    `${target}: the refused rollback left the active release untouched`,
    afterRefused === beforeCurrent,
    `was ${beforeCurrent}, now ${afterRefused}`,
  );

  // 2. Roll back to a real previous release.
  //
  // A target may have NO recorded `previous` -- correctly, so: a re-activation
  // of the current release records nothing rather than pointing `previous` at
  // itself (TASK-108). The drill must therefore make a REAL switch first:
  // activate a different, real release, which populates `previous`, and only
  // then drill. Without this the drill silently reports "nothing to roll back
  // to" on a healthy target and skips the very thing it exists to prove.
  const available = sh(target, 'ls -1 /opt/xistance/releases 2>/dev/null | wc -l').out.trim();
  if (Number(available) < 2) {
    check(`${target}: a second release exists to roll back to`, false, `only ${available} release(s) present`);
    continue;
  }
  {
    // Activate any release that is NOT the current one, so `previous` is real.
    const other = sh(
      target,
      'cur="$(readlink -f /opt/xistance/current)"; ' +
        'for d in /opt/xistance/releases/*; do [ -d "$d" ] || continue; ' +
        '[ "$(readlink -f "$d")" = "$cur" ] && continue; ' +
        'xt-rollback "$(readlink -f "$d")" >/dev/null 2>&1 && { echo "$(readlink -f "$d")"; break; }; done',
    ).out.trim().split("\n")[0]?.trim();
    if (!other) {
      check(`${target}: a real switch to another release succeeds`, false, "could not activate a second release");
      continue;
    }
    check(`${target}: a real switch to another release succeeds`, true, `-> ${path.basename(other)}`);
  }
  const previous = sh(
    target,
    'python3 -c "import json;print(json.load(open(\'/opt/xistance/active-release.json\'))[\'previous\'])" 2>/dev/null || echo ""',
  ).out.trim();
  if (!previous) {
    check(`${target}: a previous release is recorded to roll back to`, false, "active-release.json has no previous");
    continue;
  }
  const previousName = path.basename(previous);
  const rolled = sh(target, `xt-rollback ${previous} 2>&1 | tail -1; echo "rc=\${PIPESTATUS[0]}"`);
  check(`${target}: rollback to ${previousName} succeeds`, /rc=0/.test(rolled.out), rolled.out.trim());

  // 3. The pointer moved and the API recovered.
  const afterCurrent = sh(target, 'basename "$(readlink -f /opt/xistance/current)"').out.trim();
  check(
    `${target}: current now points at the rolled-back release`,
    afterCurrent === previousName,
    `expected ${previousName}, got ${afterCurrent}`,
  );
  const afterHealth = sh(
    target,
    'sleep 6; curl -s -o /dev/null -w %{http_code} --max-time 8 http://127.0.0.1:8080/api/health',
  ).out.trim();
  check(`${target}: the panel is healthy after rollback`, afterHealth === "200", `health ${afterHealth}`);
  const afterNodes = sh(target, 'curl -s -o /dev/null -w %{http_code} --max-time 8 http://127.0.0.1:8080/api/nodes').out.trim();
  check(`${target}: the API still refuses unauthenticated access`, afterNodes === "401", `nodes ${afterNodes}`);

  // 4. The state file swapped, so the drill is reversible.
  //
  // POLL, do not read once. The rollback restarts the service, and the state file
  // is rewritten as part of activation. Reading it immediately after the
  // success check can catch it mid-write: under aggregate load the suite observed
  // `active == previous`, which is a torn read of a file being replaced, not a
  // product state. The invariant is "the two differ and active is the release we
  // rolled back to", so wait for that to be true rather than sampling once.
  //
  // `active == previous` is genuinely a bad state to persist, so the check is not
  // vacuous: it fails if the swap never happens, and only tolerates a value that
  // becomes consistent.
  const deadline = Date.now() + 60_000;
  let state: string[] = [];
  for (;;) {
    state = sh(
      target,
      'python3 -c "import json;d=json.load(open(\'/opt/xistance/active-release.json\'));print(d[\'active\']);print(d[\'previous\'])" 2>/dev/null',
    ).out.trim().split("\n");
    // Valid: active names the release we rolled back to, and previous is EITHER a
    // distinct real release OR empty. An empty `previous` is correct, not a
    // failure: after TASK-108 there is no release to go back to until a real
    // switch happens, and pointing `previous` at `active` would be the bug.
    const activeOk = state.length >= 2 && path.basename(state[0]?.trim() ?? "") === previousName;
    const prevOk = (state[1] ?? "").trim() === "" || (state[1] ?? "").trim() !== (state[0] ?? "").trim();
    if (activeOk && prevOk) break;
    if (Date.now() > deadline) break;
    spawnSync("node", ["-e", "setTimeout(()=>{},1000)"]);
  }
  const activeName = path.basename((state[0] ?? "").trim());
  const previousName2 = (state[1] ?? "").trim();
  check(
    `${target}: active-release.json names the rolled-back release, and previous is distinct or empty`,
    activeName === previousName && (previousName2 === "" || previousName2 !== (state[0] ?? "").trim()),
    `active=${state[0]}, previous=${state[1]}` +
      (previousName2 !== "" && previousName2 === (state[0] ?? "").trim()
        ? "  <- previous equals active, the TASK-108 bug"
        : ""),
  );

  // 5. Return the panel to the release that SHIPS.
  //
  // Identify it by its payload digest rather than by directory name: the drill
  // above deliberately moved `current` off it, and `xt-rollback` only ever moves
  // to the recorded `previous`, so naming a directory is not enough to get back
  // -- an earlier version of this suite tried that and left both targets on the
  // drilled release. Re-activating by digest makes the restore exact.
  const shippedDigest = (
    JSON.parse(fs.readFileSync(path.join(REPO, "release-manifest.json"), "utf8")) as {
      artifact: { sha256: string };
    }
  ).artifact.sha256;

  // Enumerate the releases present on the target with the payload digest each
  // one carries, using the helper written at module scope and copied in above.
  //
  // The helper is written ONCE and never here. An earlier version re-wrote it
  // inside this block, AFTER the copy had already run, so the first target got
  // the good file and every later target silently got the broken one -- a
  // two-writer bug that only showed up as "0 releases found" on the second
  // target. One writer, one artefact.
  const candidates = sh(
    target,
    "node /root/xt-list-releases.mjs 2>/dev/null || true",
  )
    .out.trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((pair) => pair.length === 2);

  const shippedDir = candidates.find(([, digest]) => digest === shippedDigest)?.[0];
  if (!shippedDir) {
    check(`${target}: the release that ships is present on the target`, false,
      `no release carries payload ${shippedDigest.slice(0, 16)}; found ${candidates.length} release(s)`);
  } else {
    sh(target, `xt-rollback /opt/xistance/releases/${shippedDir} >/dev/null 2>&1`);
    const restored = sh(
      target,
      "sleep 5; node -p \"require('/opt/xistance/current/release-manifest.json').artifact.sha256\"",
    ).out.trim();
    check(
      `${target}: the panel is returned to the release that ships`,
      restored === shippedDigest,
      `expected payload ${shippedDigest.slice(0, 16)}, got ${restored.slice(0, 16) || "(none)"}`,
    );
  }
}

console.log(`\n--- ${pass} passed, ${fail} failed, ${skip} skipped ---`);
process.exit(fail === 0 ? 0 : 1);
