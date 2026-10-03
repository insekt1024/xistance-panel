/**
 * Run scripts/test-real-traffic-target-os.sh inside a running target-OS container.
 *
 * TASK-127 built the shell suite; this is the adapter so `run-all-tests.ts` owns it
 * like every other gate. It:
 *   1. generates the fixtures with the product's own builders (gen-traffic-fixtures),
 *   2. copies the fixtures and the suite into the container,
 *   3. runs it and fails on a non-zero RESULT.
 *
 * SKIPS -- loudly, with a reason -- when there is no target container or the
 * binaries are not installed. A skip is never reported as a pass: this suite's whole
 * value is that it moves real bytes through real binaries, and "no container" is not
 * evidence of anything.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const CONTAINER = process.env.XT_TRAFFIC_CONTAINER ?? "xt24";
const BIN_DIR = "/var/lib/xistance/bin";

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
const skip = (why: string): void => {
  console.log(`  SKIP real-binary traffic on the target OS: ${why}`);
  console.log(`\n--- 0 passed, 0 failed, 1 skipped ---`);
  process.exit(0);
};

function docker(args: string[]): { code: number; out: string } {
  try {
    return {
      code: 0,
      out: execFileSync("docker", args, { encoding: "utf8", timeout: 600_000 }),
    };
  } catch (e) {
    const err = e as { stdout?: string; status?: number };
    return { code: err.status ?? 1, out: err.stdout ?? "" };
  }
}

const up = docker(["exec", CONTAINER, "true"]);
if (up.code !== 0) skip(`container ${CONTAINER} is not running`);

const bins = docker(["exec", CONTAINER, "ls", BIN_DIR]);
if (!/backhaul/.test(bins.out) || !/gost/.test(bins.out)) {
  skip(`${BIN_DIR} on ${CONTAINER} has no backhaul/gost; run scripts/install.sh --yes on it first`);
}

// 1. Fixtures from the product's builders.
const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), "xt-traffic-"));
try {
  // Spawning `npx` from Node fails with ENOENT here -- it is a shell shim, not an
  // executable on this PATH. Resolve the repo's own tsx loader instead.
  const tsxCli = path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs");
  const gen = [process.execPath, tsxCli, "scripts/gen-traffic-fixtures.ts", fixtures];
  execFileSync(gen[0], gen.slice(1), {
    cwd: REPO,
    encoding: "utf8",
    stdio: ["ignore", "ignore", "inherit"],
  });
  const files = fs.readdirSync(fixtures);
  ok(`gen-traffic-fixtures produced ${files.length} configs from the product's builders`);

  // 2. Ship them, plus the suite, into the container.
  docker(["exec", CONTAINER, "mkdir", "-p", "/tmp/traffic-fx"]);
  for (const f of files) {
    docker(["cp", path.join(fixtures, f), `${CONTAINER}:/tmp/traffic-fx/${f}`]);
  }
  docker([
    "cp",
    path.join(REPO, "scripts", "test-real-traffic-target-os.sh"),
    `${CONTAINER}:/tmp/traffic-fx/suite.sh`,
  ]);

  // 3. Run it. A non-zero RESULT is a failure, and the suite's own output says which
  //    method and why, so surface it rather than summarising.
  const run = docker([
    "exec",
    CONTAINER,
    "bash",
    "/tmp/traffic-fx/suite.sh",
    "/tmp/traffic-fx",
    BIN_DIR,
  ]);
  for (const line of run.out.split(/\r?\n/).filter((l) => /^(  ok|  FAIL|  SKIP|RESULT)/.test(l))) {
    console.log(line);
  }
  docker(["exec", CONTAINER, "rm", "-rf", "/tmp/traffic-fx"]);

  if (run.code === 0 && /RESULT: pass=\d+ fail=0/.test(run.out)) ok("the target-OS traffic suite reports pass=N fail=0");
  else
    bad(
      "the target-OS traffic suite reports pass=N fail=0",
      `exit ${run.code}; see the per-method lines above`,
    );
} catch (e) {
  bad("the target-OS traffic suite runs", (e as Error).message);
} finally {
  fs.rmSync(fixtures, { recursive: true, force: true });
}

console.log(`\n--- ${pass} passed, ${failures.length} failed ---`);
process.exit(failures.length === 0 ? 0 : 1);
