/**
 * TASK-87. Argument parsing for scripts/stage-release-artifact.ts.
 *
 * The stager had never been invoked without `--prisma-client` since that flag
 * was added, and omitting it silently ate the first positional argument:
 *
 *     const clientIndex = args.findIndex((arg) => arg === "--prisma-client");  // -1
 *     index !== clientIndex + 1     //  index !== 0    -- drops the repo root
 *
 * `-1 + 1 === 0`, so with the flag absent the filter excluded argv[0]. The
 * stager then destructured `destination` from a one-element array, found it
 * undefined, and printed its usage line and exited 2 -- for an invocation that
 * was entirely correct. Every call passing all three flags worked, which is why
 * it survived: the release workflow always passes them together.
 *
 * Asserted through the real process boundary, not by importing the parser: the
 * module performs its work at import time, so the only faithful check is what
 * the binary does with a real argv.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const script = path.join(REPO, "scripts", "stage-release-artifact.ts");
const tsxCli = path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs");

let pass = 0;
let fail = 0;

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

/**
 * Run the stager with a real argv. The stager stages into a destination it then
 * rmdir's, so the destination is always a throwaway path under
 * node_modules/.cache; these assert argv handling, and the staging itself is
 * covered by test-verify-artifact.ts.
 */
function runWith(args: string[]): { status: number | null; output: string } {
  const res = spawnSync(process.execPath, [tsxCli, script, ...args], {
    encoding: "utf8",
    cwd: REPO,
    timeout: 180_000,
  });
  return { status: res.status, output: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

/**
 * The old bug printed the usage line and exited 2. That pair is what separates
 * a rejected invocation from an accepted one without paying for a full build,
 * so both are asserted.
 */
function wasRejected(output: string): boolean {
  return output.includes("Usage: stage-release-artifact.ts");
}

const destination = path.join(REPO, "node_modules", ".cache", "xt-stagedest");
const artifact = path.join(REPO, "dist", "artifact");
const prismaClient = path.join(REPO, "node_modules", ".prisma", "client");

console.log("TASK-87 stage-release-artifact argument parsing\n");

assert.ok(REPO.length > 0, "REPO must resolve");

// --- the defect: --prisma-client omitted eats the repo root -----------------
// This is the exact call the release work uses for amd64.
{
  const { status, output } = runWith([REPO, destination, "--architecture", "amd64", "--standalone", artifact]);
  check(
    "omitting --prisma-client still passes the repo root as positional[0]",
    !wasRejected(output),
    `the stager printed usage for a valid invocation.\n${output.slice(0, 400)}`,
  );
  check("omitting --prisma-client is not an argument error", status !== 2, `exit ${status} means the guard rejected it.`);
}

// --- each flag independently, to catch the same class in every combination --
for (const omitted of ["--architecture", "--standalone", "--prisma-client"]) {
  const args = [REPO, destination];
  if (omitted !== "--architecture") args.push("--architecture", "amd64");
  if (omitted !== "--standalone") args.push("--standalone", artifact);
  if (omitted !== "--prisma-client") args.push("--prisma-client", prismaClient);
  const { status, output } = runWith(args);
  check(
    `omitting ${omitted} alone does not consume the repo root`,
    !wasRejected(output),
    `usage printed with only ${omitted} absent.\n${output.slice(0, 400)}`,
  );
  check(`omitting ${omitted} alone is not exit 2`, status !== 2, `got exit ${status}.`);
}

// --- all three flags, the shape every working caller used -------------------
// Guards against the fix over-correcting and breaking the original path.
{
  const { output } = runWith([
    REPO,
    destination,
    "--architecture",
    "amd64",
    "--standalone",
    artifact,
    "--prisma-client",
    prismaClient,
  ]);
  check("all three flags together are still accepted", !wasRejected(output), `usage printed.\n${output.slice(0, 400)}`);
}

// --- a genuinely invalid invocation must still be rejected ------------------
// The relaxation must not turn the guard into a no-op.
{
  const { status, output } = runWith([REPO, destination, "--architecture", "sparc", "--standalone", artifact]);
  check("an unknown --architecture is still rejected", wasRejected(output), "expected the usage line.");
  check("an unknown --architecture still exits 2", status === 2, `got exit ${status}.`);
}
{
  const { output } = runWith([REPO]);
  check("a missing destination is still rejected", wasRejected(output), "expected the usage line.");
}

console.log(`\n--- ${pass} passed, ${fail} failed ---`);
process.exit(fail === 0 ? 0 : 1);
