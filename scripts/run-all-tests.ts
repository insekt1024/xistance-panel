/**
 * Aggregate local test runner — the single list of suites that must pass.
 *
 * WHY THIS EXISTS
 *
 * This repository had 63 test suites on disk and no way to run them all. CI's
 * `verify` job executed exactly one of them (`test-optimizations.ts`); the
 * `browser` job ran 12 more, but only because they were bundled into
 * `run-browser-gate.ts` to share a server. The remaining 50 — the SSRF guard, the
 * SSH option-injection suite, the nine tunnel-method suites, the installer and
 * supply-chain checks, the release-manifest and workflow tests, the Persian
 * parity checker — ran only when a person typed them by hand.
 *
 * That is a real and demonstrated failure mode, not a hypothetical one. A
 * critical SSH argument-injection fix (a leading `-` in a username being handed
 * to OpenSSH as `ProxyCommand`) passed every suite CI was executing. The suite
 * that caught it existed, ran green locally, and was never in CI.
 *
 * So "the tests pass" was never a claim that could be checked by anyone other
 * than the person who remembered the commands. This file makes the list
 * explicit and executable, and CI runs the same list.
 *
 * DESIGN
 *
 *  * Every suite is listed here. A new `test-*.ts` that is not registered below
 *    fails this runner, so the list cannot silently go stale — that check is
 *    itself asserted, and it is the reason to keep suites out of a hardcoded
 *    array in the first place.
 *  * Suites run sequentially and a failure does not stop the run: the point of a
 *    gate is to report everything that is broken, not the first thing.
 *  * Exit code is non-zero if ANY suite failed, with a summary naming each one.
 *  * A suite that cannot run is a FAILURE, not a skip. Silent skips are how
 *    coverage gets claimed when nothing executed.
 *
 * The browser suites are NOT in this list: they need a live server and a staged
 * artifact, and they are run by `run-browser-gate.ts`, which CI also runs. This
 * runner asserts that the two sets are disjoint, so a suite cannot be counted
 * twice or claimed by neither.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const scriptsDir = path.join(repoRoot, "scripts");

interface Suite {
  /** Command to run. */
  cmd: string;
  /** Args. */
  args: string[];
  /** Label for output. */
  label: string;
}

const TS = (name: string): Suite => ({ cmd: "npx", args: ["tsx", `scripts/${name}`], label: name });
const SH = (name: string): Suite => ({ cmd: "bash", args: [`scripts/${name}`], label: name });
/** Python suite. Uses the `python` launcher, which is what the host provides. */
const PY = (name: string, ...extra: string[]): Suite => ({
  cmd: "python",
  args: [`scripts/${name}`, ...extra],
  label: name,
});

/**
 * Suites that must pass before anything is considered releasable.
 *
 * Grouped by what they protect, because "run the tests" is not a reviewable
 * statement — a reviewer needs to know WHICH claim each suite is evidence for.
 */
/**
 * Decode a child-process buffer that may be UTF-8 or UTF-16.
 *
 * WSL on a Windows host intermittently emits UTF-16LE. Decoding that as UTF-8
 * yields NUL-interleaved text, and a log full of NULs is a BINARY file to grep,
 * tail and diff -- which destroys the very output used to diagnose a failure.
 * A UTF-16LE buffer has a BOM, and even without one the NUL pattern is
 * unambiguous, so detect rather than assume.
 */
function decodeMaybeUtf16(buf: Buffer | string | null | undefined): string {
  if (buf === null || buf === undefined) return "";
  if (typeof buf === "string") return buf;
  if (buf.length >= 2) {
    // BOM-led UTF-16 (LE or BE).
    if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
    if (buf[0] === 0xfe && buf[1] === 0xff) return buf.subarray(2).swap16().toString("utf16le");
    // BOM-less UTF-16LE: ASCII text carries a NUL in every odd byte.
    const probe = Math.min(buf.length, 256);
    let nulOdd = 0;
    for (let i = 1; i < probe; i += 2) if (buf[i] === 0) nulOdd++;
    if (nulOdd > probe / 4) return buf.toString("utf16le");
  }
  return buf.toString("utf8");
}

const SUITES: Suite[] = [
  // --- release integrity: what actually ships ---------------------------
  TS("test-release-manifest.ts"),
  TS("test-release-artifact.ts"),
  // Pins the staged Prisma engine allowlist to the platform ids the installed
  // Prisma actually builds, so a second-architecture release cell cannot pass
  // inspection with an engine Prisma never publishes. Offline; the network
  // probe is opt-in via XT_PROBE_PRISMA=1.
  TS("test-prisma-engine-targets.ts"),
  // A Linux release must not carry a native binary built for another OS. Staging
  // on Windows leaked @img/sharp-win32-x64 into the amd64 payload (TASK-79);
  // the check reads sharp's real platform matrix rather than a hardcoded list.
  TS("test-foreign-native-bins.ts"),
  // Staging must take the Prisma engines from the build it is staging, not from
  // whatever is in the local checkout. The first arm64 artifact was unstaggable
  // because both roots were hardcoded to this machine (TASK-81).
  TS("test-stage-source-architecture.ts"),
  // The stager's argv parser dropped the repo root whenever any single flag was
  // omitted, because `findIndex(...) + 1` is 0 for an absent flag. Every release
  // call passed all three flags, so the defect was invisible until a local
  // two-flag call printed usage and exited 2 (TASK-87).
  TS("test-stage-arg-parsing.ts"),
  // The port allocator must dodge the pool Windows reserves. Two suites died
  // intermittently on `bind EACCES 0.0.0.0:<5xxxx>` with no code change, which
  // was blamed on load twice before the excluded-port ranges were found. The
  // property test asserts the allocator's contract directly; the consuming
  // suites sample ~15 ports and cannot see a 3% failure rate (TASK-84).
  TS("test-pick-port.ts"),
  // The root release-manifest.json must describe a payload tree that still
  // exists. It held a digest matching NEITHER the staged tree nor the
  // standalone tree, so a verifier recomputing it before extraction would have
  // rejected the release. Nothing compared it to anything (TASK-85).
  TS("test-release-manifest-freshness.ts"),
  TS("test-release-assets.ts"),
  TS("test-release-attestation.ts"),
  TS("test-audit-gate.ts"),
  TS("test-chromium-path.ts"),
  TS("test-release-audit.ts"),
  TS("test-release-workflow.ts"),
  // TASK-101: the release workflow built the manifest from apps/web/.next/standalone
  // BEFORE staging, so CI published a digest of a tree that never shipped -- the
  // TASK-96 bug, still live in the workflow. Also asserts the CI verifies manifest
  // provenance against the extracted archive, which nothing did.
  TS("test-release-workflow-manifest-order.ts"),
  // TASK-102: the release workflow reads the version from the COMMIT, but every
  // artifact is built from the worktree. Reports a readiness finding when they
  // disagree (the bump is uncommitted) and hard-fails on a mis-named archive.
  TS("test-release-version-commit-parity.ts"),
  // TASK-110: a release must ship an installer the documented one-line command
  // can actually use. The tarballs alone are not installable, and the publish job
  // must fail closed rather than ship a release nobody can install.
  TS("test-release-installer-assets.ts"),
  // TASK-111: the READMEs are the user-facing install contract, and prose cannot
  // drift-test itself. This extracts the documented commands and proves every file
  // they fetch is reachable at the pinned tag and in a layout the installer
  // actually resolves. The documented install was executed for real (TASK-110).
  TS("test-documented-install-command.ts"),
  // TASK-114: dashboard TEXT LEGIBILITY, measured in a real browser in both
  // locales at 320/390/768px. The a11y suites had 1 scrollWidth assertion in
  // total and NO viewport matrix, so unreadable or badly-wrapped text could ship
  // with every suite green. Non-vacuity: an injected clamped 9px label is caught,
  // and reverting the dashboard-stats fix drops this from 36 to 24.
  TS("test-dashboard-legibility.ts"),
  // TASK-103: the docker job ran on ubuntu-latest with no `platforms:`, so it
  // built an amd64-only image and tagged it with the release semver AND `latest`
  // -- a narrower image than the release it belongs to.
  TS("test-docker-image-architecture.ts"),
  // TASK-104: the ledger proves 73/73 TASKS have evidence, which is not the same
  // as every PRD success METRIC being enforced. Maps each section-15 metric to the
  // suite that actually executes it, across all three runners.
  TS("test-prd-success-metrics.ts"),
  // TASK-106: the manifest's runtime.node was the BUILD HOST's version
  // (v26.7.0, v-prefixed) in a field describing the release's runtime contract,
  // shipped to targets running Node 22. Now the installers' own NODE_MIN_MAJOR.
  TS("test-manifest-runtime-node.ts"),
  TS("test-verify-artifact.ts"),
  // test-verify-artifact.ts builds its fixtures FROM the allowlist it validates,
  // so it cannot detect the allowlist disagreeing with a real release. This runs
  // the installer's own verification command against the actual staged archive,
  // with a negative control proving the check can still fail (TASK-89).
  TS("test-real-archive-verify.ts"),
  // TASK-92: a real partial extraction (QEMU tar writes 5 of 1990 files and exits
  // non-zero) is the only way to exercise the installer's failure path on a host
  // where the install cannot succeed. Asserts it refuses rather than half-activates.
  TS("test-partial-extraction-safety.ts"),
  // TASK-96: the embedded manifest's payload digest must describe the tree the
  // ARCHIVE extracts to. It was computed from a subdirectory of the BUILD
  // output, so it described a tree that never shipped. Recomputes the digest
  // from the real extracted archive for both architectures.
  TS("test-embedded-manifest-provenance.ts"),
  // TASK-98: a target must run the payload that SHIPS. The TASK-96 rebuild meant
  // the last install proof no longer described the published artifact. Compares
  // every installed file against the staged tree on both amd64 targets.
  TS("test-target-runs-shipped-payload.ts"),
  // TASK-107: the rollback helper is installed by every release, but xt-rollback
  // had never been EXECUTED on a target. PRD section 15 requires update/rollback
  // drills on the real target OSes. Runs the real command: refusal case, real
  // rollback, health recovery, state swap, and restore to the shipping release.
  TS("test-rollback-drill.ts"),
  TS("test-rewrite-build-paths.ts"),
  SH("test-release-layout.sh"),
  SH("test-release-cutover.sh"),
  // Asset and localization coverage for the payload that actually SHIPS
  // (TASK-83). The browser gate's only artifact suite prefers
  // dist/artifact-local, because that is the only tree a Windows host can boot,
  // so dist/artifact was untested. This runs the same suite under Linux, where
  // the Debian engine it ships is loadable. See LINUX_SUITES below.
  SH("test-release-payload-linux.sh"),

  // --- credential redaction in gate output ------------------------------
  // Was an unreferenced `.probe-scrub.ts`: real assertions that nothing ever
  // ran, because the orphan check only scans `test-*.ts|sh`. A dot-prefix hid
  // it from the very check meant to catch unwired tests.
  TS("test-browser-scrub.ts"),

  // --- ledger: the task JSONs must agree with the evidence on disk -------
  // Read-only. This is a drift detector, not a writer: it exits non-zero when
  // a task's step flags disagree with the evidence files that back it, so the
  // 60/303 stale-flag condition cannot silently return. Reconciling the ledger
  // is a deliberate act (`--write`), never something a test run does for you.
  PY("reconcile-task-ledger.py", "--check"),

  // --- installer: the one path a real user takes -------------------------
  SH("test-release-installer.sh"),
  TS("test-supply-chain.ts"),
  TS("test-release-docs.ts"),
  SH("test-line-endings.sh"),

  // --- security ---------------------------------------------------------
  // test-ssh-destination-injection.ts covers the three-layer SSH destination
  // defence (schema, API route, process spawn sink). It is first here because
  // its absence from CI is what let a critical finding ship.
  TS("test-ssh-destination-injection.ts"),
  TS("test-ssrf-guard.ts"),
  TS("test-auth-security.ts"),
  TS("test-origin-csrf.ts"),
  TS("test-secret-redaction.ts"),
  TS("test-rate-limit.ts"),
  TS("test-protected-routes.ts"),

  // --- the nine tunnel methods ------------------------------------------
  TS("test-method-matrix.ts"),
  // Real-binary evidence lives outside the matrix harness, which uses an
  // injected process handle and so reports realBinary:false by construction.
  // Without this the matrix would keep claiming no method was ever proved with
  // a real binary, after TASK-65 carried real bytes through GOST/FRP/XRAY on
  // the target OS. It also records the six methods that remain unproved.
  TS("test-real-traffic-target-os.ts"),
  SH("test-real-traffic-target-os.sh"),
  // The ICMP data path needs two network namespaces and a raw ICMP socket, so
  // it lives in its own suite rather than as a case above. It SKIPs itself
  // with a reason on any host that lacks root/CAP_NET_RAW, iproute2, or the
  // pingtunnel binary -- a skip is never widened into an allowlist to look green.
  SH("test-real-icmp-tunnel.sh"),
  // The systemd half: `User=root` in the generated unit is what lets
  // pingtunnel open its raw ICMP socket. The two-node suite starts both
  // halves from a shell and never touches the unit, so without this a unit
  // that lost the privilege would fail at runtime with every test green.
  SH("test-icmp-systemd-unit.sh"),
  // The two transport modes the forward-mode suite does not claim:
  // SOCKS5 (reaches ANY target the proxy can see) and UDP (a real
  // datagram round trip, not a TCP payload on a UDP socket).
  SH("test-real-icmp-modes.sh"),
  TS("test-real-binary-evidence.ts"),
  TS("test-backhaul.ts"),
  TS("test-frp.ts"),
  TS("test-gost.ts"),
  TS("test-icmp.ts"),
  TS("test-icmp-wizard-contract.ts"),
  TS("test-ssh.ts"),
  TS("test-port-forward.ts"),
  TS("test-port-forward-datapath.ts"),
  TS("test-direct.ts"),
  TS("test-reverse.ts"),
  TS("test-xray.ts"),
  TS("test-xui.ts"),

  // --- process lifecycle and resilience ----------------------------------
  TS("test-tunnel-lifecycle.ts"),
  TS("test-diagnostics.ts"),
  TS("test-retry-bounds.ts"),
  TS("test-bounded-caches.ts"),
  TS("test-disposal-cleanup.ts"),
  TS("test-forward-reconcile.ts"),
  TS("test-port-allocation.ts"),

  // CI already runs this one as a named step; it is registered here too so the
  // aggregate list is the whole story rather than "most of it".
  TS("test-optimizations.ts"),

  // --- database, health, resources --------------------------------------
  TS("test-apply-migrations.ts"),
  TS("test-create-admin.ts"),
  TS("test-health-telemetry.ts"),
  TS("test-resource-budgets.ts"),
  SH("test-backup-restore.sh"),

  // --- documentation and localization -----------------------------------
  TS("test-readme-fa-parity.ts"),
  TS("test-locale-parity.ts"),
  SH("test-service-contract.sh"),
  SH("test-cli-regression.sh"),
  SH("test-update-flow.sh"),

];

// ---------------------------------------------------------------------------
// 1. The list may not be stale. Every test-* on disk must be either in this
//    list or owned by the browser gate. A suite that is neither has never been
//    run by anyone, and that is exactly how the SSH fix shipped.

const gateRunner = readFileSync(path.join(scriptsDir, "run-browser-gate.ts"), "utf8");
const browserOwned = new Set(
  [...readFileSync(path.join(scriptsDir, "run-browser-gate.ts"), "utf8").matchAll(/test-[a-z0-9-]+\.ts/g)].map(
    (m) => m[0],
  ),
);

// Suites that take an argument and therefore cannot be run by a bare `npx tsx`
// invocation. They are not orphans: they are invoked deliberately, with real
// inputs, by the task that owns them. Listing them here keeps the orphan check
//    from firing while still naming the owner.
//
//    test-target-write-path.sh belongs here: it takes CONTAINER names and
//    asserts the unprivileged service user can really write to the app database
//    on a booted target OS. It cannot run in the portable aggregate (no
//    containers, no systemd) and would be a false green if it tried — the
//    TASK-74 root-owned database passed unit=active, /api/health=200 and
//    /api/nodes=401 on such a host. Owner: the target-OS verification task,
//    which runs it against a real container.
//    test-lowram-cgroup-gate.sh belongs here: it takes the artifact root and the
//    server dir as POSITIONAL arguments, and it creates a real cgroup, so it
//    needs root and a writable cgroup hierarchy. On a GitHub runner it fails
//    with "FAIL: cannot create cgroup" even when every argument is correct --
//    and if it were invoked here with no arguments it would fail on its own
//    usage line instead, which is what happened before.
//
//    It is NOT skipped. Owner: scripts/create-target-os.sh, which creates the
//    target OSes and then runs the gate inside one, where root and a writable
//    cgroup both exist (verified: each created target can create a child
//    cgroup). The gate still asserts the limits actually reached the process
//    under test, and still fails the build when they do not.
const ARGUMENT_TAKING = new Set([
  "test-bench-sanitized.ts",
  "test-target-write-path.sh",
  "test-lowram-cgroup-gate.sh",
]);

const onDisk = readdirSync(scriptsDir)
  .filter((f) => /^test-.*\.(ts|sh)$/.test(f))
  .sort();

const registered = new Set(SUITES.map((s) => s.label));
const orphans: string[] = [];
const failures: string[] = [];
/**
 * Per-suite failure detail kept alongside `failures`. An exit code alone cannot
 * say which assertion broke, so the record would not be self-sufficient.
 */
const failureDetail: { suite: string; exit: number; lines: string[] }[] = [];
const skipped: string[] = [];
const blocked: string[] = [];

for (const file of onDisk) {
  if (registered.has(file)) continue;
  if (browserOwned.has(file)) continue;
  if (ARGUMENT_TAKING.has(file)) continue;
  orphans.push(file);
}
if (orphans.length > 0) {
  failures.push(
    `test suites on disk that no gate runs (${orphans.length}): ${orphans.join(", ")}. ` +
      `Register each in scripts/run-all-tests.ts or in run-browser-gate.ts.`,
  );
}

// A registered suite that no longer exists is a typo, not a skip.
for (const s of SUITES) {
  if (!existsSync(path.join(scriptsDir, s.label))) {
    failures.push(`registered suite does not exist: scripts/${s.label}`);
  }
}

// A suite claimed by both gates is double-counted and should be resolved.
for (const s of SUITES) {
  if (browserOwned.has(s.label)) {
    failures.push(
      `${s.label} is registered in both run-all-tests.ts and run-browser-gate.ts; ` +
        `it needs a live server, so it belongs to exactly one`,
    );
  }
}

// ---------------------------------------------------------------------------
// 2. Run them.

// Suites that need Linux. They are not "blocked on a VPS" -- they need a
// *platform*, and WSL provides one. This distinction cost several turns of
// wrong reporting: both of these were listed as target-host-blocked, and both
// run here in about a minute.
//
// test-release-payload-linux.sh (TASK-83) is the third. The browser gate's only
// artifact suite prefers dist/artifact-local, because that is the only tree a
// Windows host can boot, so the payload that actually SHIPS had no asset or
// localization coverage. This one runs the same suite against dist/artifact on
// the Linux host, where the Debian engine it ships is loadable.
const LINUX_SUITES = new Set([
  "test-lowram-cgroup-gate.sh",
  "test-protected-routes.ts",
  "test-release-payload-linux.sh",
]);

/** Is there a usable WSL distribution? Probed, not assumed. */
function wslDistro(): string | null {
  const probe = spawnSync("wsl", ["-l", "-q"], { encoding: "utf8", shell: true });
  if (probe.status !== 0) return null;
  // wsl -l -q emits UTF-16LE on Windows; strip NULs rather than trusting encoding.
  const names = (probe.stdout ?? "").replace(/\u0000/g, "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return names[0] ?? null;
}

const distro = process.platform === "win32" ? wslDistro() : (process.env.LINUX_DISTRO ?? "any");
if (distro) {
  console.log(`Linux suites will run under WSL distribution: ${distro}\n`);
}

// A suite that needs Linux, and the aggregate is running on Windows without
// WSL, is reported rather than silently dropped.
const TARGET_ONLY = new Set<string>();
for (const s of SUITES) {
  if (!LINUX_SUITES.has(s.label)) continue;
  if (process.platform !== "win32" || distro) continue;
  TARGET_ONLY.add(s.label);
  blocked.push(s.label);
}
if (TARGET_ONLY.size > 0) {
  console.log(
    `NOTE: no WSL distribution found; ${[...TARGET_ONLY].join(", ")} need Linux and are unverified here.\n`,
  );
}

const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const LOCAL = SUITES.filter((s) => !TARGET_ONLY.has(s.label));
const toRun = only.length > 0 ? LOCAL.filter((s) => only.some((o) => s.label.includes(o))) : LOCAL;
if (only.length > 0 && toRun.length === 0) {
  console.error(`no suite matches ${JSON.stringify(only)}`);
  process.exit(2);
}
if (only.length === 0 && orphans.length > 0) {
  // Report the structural failure even in a filtered run — it is a fact about
  // the repository, not about this run.
  console.error("\n  UNREGISTERED SUITES:");
  for (const o of orphans) console.error(`    ${o}`);
  console.error("");
}

/**
 * Run a Linux suite under WSL, staging the artifact and a transpiled copy of
 * the suite on the Linux side.
 *
 * The suites are plain Node scripts. Two environment obstacles are handled
 * here rather than in the test files, so the test sources stay clean:
 *   1. `node_modules` on the Windows side holds a Windows-native esbuild, so
 *      `npx tsx` inside WSL cannot run. The suite is transpiled on Windows to
 *      CJS first, then the JavaScript runs on Linux.
 *   2. The suite resolves the staged artifact relative to its own directory, so
 *      it is placed under a scratch root that has `dist/artifact` in the shape
 *      it expects.
 *
 * Exits non-zero if the WSL run fails, exactly like a local failure, and prints
 * the WSL output verbatim so a real assertion failure is readable.
 */
function runUnderWsl(suite: string, distroName: string): { code: number; output: string } {
  const wslTmp = process.env.TMPDIR ?? process.env.TEMP ?? ".";
  // Map a Windows temp path to its WSL /mnt equivalent. The path must be
  // normalised to forward slashes FIRST: an earlier version replaced
  // backslashes and then matched a backslash in the regex, so the mapping never
  // matched and every Linux suite failed with "cannot map temp dir".
  const wslTmpNative = wslTmp.replace(/\\/g, "/");
  const m = /^([A-Za-z]):\/(.*)$/.exec(wslTmpNative);
  if (!m) return { code: -1, output: `cannot map temp dir to WSL path: ${wslTmp}` };
  // The leading slash is part of the mount path, not of the captured remainder:
  // `C:/Users/x` -> `/mnt/c/Users/x`. Dropping it produced `/mnt/cUsers/...`,
  // which is a path that does not exist and fails with a bare "No such file".
  const wslTmpPath = `/mnt/${m[1].toLowerCase()}/${m[2]}`;

  // A .sh suite is a different shape of thing. It is already portable, but it
  // needs ROOT (real cgroups, and it asserts its own membership) and a payload
  // it can write to, so it is copied out of the Windows mount into a scratch
  // root and invoked as root. It cannot be transpiled or run as CJS.
  //
  // The argument list is per-suite, not shared. The cgroup gate takes
  // "<artifact> <webdir> <bytes> <port>"; the release-payload gate takes
  // "[artifactRoot]" and nothing else. Hardcoding one suite's arguments for
  // every .sh file is how the payload suite ran with a cgroup gate's four
  // arguments and died on an unrecognised one -- so the two are listed here and
  // an unknown suite fails loudly instead of inheriting someone else's argv.
  const SHELL_SUITE_ARGS: Record<string, string> = {
    "test-lowram-cgroup-gate.sh": "$H/artifact $H/artifact/apps/web 268435456 39355",
    "test-release-payload-linux.sh": "$H/artifact",
  };
  if (suite.endsWith(".sh")) {
    const argv = SHELL_SUITE_ARGS[suite];
    if (argv === undefined) {
      return {
        code: -1,
        output:
          `no WSL argument list declared for shell suite ${suite}. ` +
          "Add it to SHELL_SUITE_ARGS in scripts/run-all-tests.ts -- do not " +
          "reuse another suite's argv, which fails at the far end with an " +
          "unrecognised argument.",
      };
    }
    const gateScript = path.join(wslTmp, "xt-linux-gate.sh");
    writeFileSync(gateScript, readFileSync(path.join(scriptsDir, suite), "utf8"), "utf8");
    const wslScript = [
      "set -e",
      // A scratch root unique to THIS process. The fixed name `$HOME/xt-gate`
      // made two overlapping runs fight over one directory, and the loser failed
      // with a nonsense from the winner's half-copied tree:
      //   cp: cannot create directory '/root/xt-gate/artifact/apps': File exists
      // That reads like a payload defect and is purely a collision. PID-keyed, so
      // a killed run's leftovers can never poison the next one.
      "H=$HOME/xt-gate-$$",
      "rm -rf $H && mkdir -p $H",
      "trap 'rm -rf $H' EXIT",
      `cp -a "$(wslpath -a '${path.join(repoRoot, "dist", "artifact")}')" $H/artifact`,
      `cp "${wslTmpPath}/${path.basename(gateScript)}" $H/gate.sh`,
      "chmod +x $H/gate.sh",
      // A copied script resolves its own repository root from its own location,
      // which is $H -- not the repository. Hand it the real path, or every
      // path it builds (node_modules, scripts/) points inside the scratch root.
      `export XT_REPO="$(wslpath -a '${repoRoot}')"`,
      "cd $H",
      // Creating a cgroup requires root, and `wsl.exe` is a Windows binary that
      // does not exist inside the distribution. So the whole script is invoked
      // with `-u root` from the PARENT process instead of re-entering wsl here.
      // The gate reads its limits back, asserts /proc/<pid>/cgroup membership,
      // and removes the cgroup on the way out.
      `bash $H/gate.sh ${argv}`,
    ].join("\n");
    const scriptFile = path.join(wslTmp, "xt-linux-gate-run.sh");
    writeFileSync(scriptFile, wslScript, "utf8");
    const run = spawnSync("wsl", ["-d", distroName, "-u", "root", "--", "bash", `${wslTmpPath}/${path.basename(scriptFile)}`], {
      encoding: "utf8",
    });
    return { code: run.status ?? -1, output: `${run.stdout ?? ""}${run.stderr ?? ""}` };
  }

  const translate = spawnSync(
    "npx",
    [
      "esbuild",
      path.join(scriptsDir, suite),
      "--format=cjs",
      "--platform=node",
      `--target=node${process.versions.node.split(".")[0]}`,
      `--outfile=${path.join(wslTmp, `xt-linux-${suite.replace(/\.ts$/, "")}.cjs`)}`,
    ],
    { cwd: repoRoot, encoding: "utf8", shell: true },
  );
  if (translate.status !== 0) {
    return { code: -1, output: `esbuild transpile failed for ${suite}: ${translate.stderr || translate.stdout}` };
  }
  const transpiled = path.join(wslTmp, `xt-linux-${suite.replace(/\.ts$/, "")}.cjs`);

  // The transpiled CJS `require("./lib/<helper>")`, so every helper the suite
  // pulls in has to be JavaScript too. Copying the .ts alongside it fails with
  // MODULE_NOT_FOUND. `cp -a lib/` in the WSL script below copies the .ts
  // sources, which is necessary but not sufficient -- the require needs a .js.
  //
  // The list is explicit rather than a directory sweep so a newly added helper
  // fails LOUDLY here instead of silently becoming an unresolvable require
  // inside WSL. That is how test-protected-routes.ts broke when pick-port.ts
  // was introduced: the suite transpiled fine, then died at runtime with
  // "Cannot find module './lib/pick-port'".
  const TRANSPILED_LIBS = ["asset-refs.ts", "pick-port.ts"];

  for (const lib of TRANSPILED_LIBS) {
    const libSource = path.join(scriptsDir, "lib", lib);
    if (!existsSync(libSource)) {
      return { code: -1, output: `transpile target missing: scripts/lib/${lib}` };
    }
    const libOut = path.join(wslTmp, `xt-linux-${lib.replace(/\.ts$/, ".js")}`);
    const libTranslate = spawnSync(
      "npx",
      [
        "esbuild",
        libSource,
        "--format=cjs",
        "--platform=node",
        `--target=node${process.versions.node.split(".")[0]}`,
        `--outfile=${libOut}`,
      ],
      { cwd: repoRoot, encoding: "utf8", shell: true },
    );
    if (libTranslate.status !== 0) {
      return { code: -1, output: `esbuild transpile failed for lib/${lib}: ${libTranslate.stderr || libTranslate.stdout}` };
    }
  }

  // esbuild names each output after the SOURCE file, so the emitted file is
  // `xt-linux-asset-refs.js`. It has to land in $H/scripts/lib/ under its own
  // name -- copying it to a fixed destination makes the require unresolvable,
  // and the failure surfaces as "Cannot find module './lib/asset-refs'" from
  // inside WSL rather than as anything about the copy.
  const libCopies = TRANSPILED_LIBS.map((lib) => {
    const name = lib.replace(/\.ts$/, ".js");
    return `cp "${wslTmpPath}/xt-linux-${name}" $H/scripts/lib/${name}`;
  });

  const wslScript = [
    "set -e",
    `H=$HOME/xt-suite`,
    `rm -rf $H && mkdir -p $H/scripts $H/dist`,
    `cp -a "$(wslpath -a '${path.join(repoRoot, "dist", "artifact")}')" $H/dist/artifact`,
    `cp "${wslTmpPath}/${path.basename(transpiled)}" $H/scripts/suite.cjs`,
    `cp -a "$(wslpath -a '${path.join(scriptsDir, "lib")}')" $H/scripts/lib`,
    ...libCopies,
    `cd $H`,
    `export TMPDIR=$HOME/xt-tmp && mkdir -p $TMPDIR`,
    `node scripts/suite.cjs`,
  ].join("\n");

  const scriptFile = path.join(wslTmp, `xt-linux-run.sh`);
  writeFileSync(scriptFile, wslScript, "utf8");
  // Do NOT pass `encoding: "utf8"`. WSL on this host can hand back UTF-16LE, and
  // Node then decodes it as UTF-8, so every character arrives NUL-interleaved
  // ("w\0s\0l\0:"). That does not merely look wrong: it makes the aggregate log
  // a BINARY file, so grep, tail and every other log tool stop working on the
  // output meant to explain a failure.
  //
  // So take raw Buffers and decode explicitly, detecting UTF-16 rather than
  // assuming it.
  const run = spawnSync("wsl", ["-d", distroName, "--", "bash", `${wslTmpPath}/${path.basename(scriptFile)}`]);
  return { code: run.status ?? -1, output: `${decodeMaybeUtf16(run.stdout)}${decodeMaybeUtf16(run.stderr)}` };
}

// A Linux suite needs the STAGED PAYLOAD. Failing 30 seconds in with
// "cp: cannot stat .../dist/artifact" is a confusing way to learn that a build
// and a staging step were skipped, and it costs a full suite run to find out.
// Preflight it, and name the exact commands.
if (toRun.some((s) => LINUX_SUITES.has(s.label))) {
  const artifactRoot = path.join(repoRoot, "dist", "artifact");
  if (!existsSync(artifactRoot)) {
    console.error(
      [
        "",
        "FATAL: these suites need the staged release payload, and it is missing:",
        ...toRun.filter((s) => LINUX_SUITES.has(s.label)).map((s) => `  - ${s.label}`),
        "",
        `  expected: ${artifactRoot}`,
        "",
        "  build and stage it first:",
        "    TURBO_DISABLE=true npm run build",
        "    npx tsx scripts/stage-release-artifact.ts . dist/artifact --architecture amd64",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }
}

console.log(`Running ${toRun.length} suite${toRun.length === 1 ? "" : "s"}…\n`);

const results: Array<{ label: string; code: number; seconds: number }> = [];
for (const s of toRun) {
  if (!existsSync(path.join(scriptsDir, s.label))) {
    skipped.push(s.label);
    continue;
  }
  const started = Date.now();
  // A Linux suite goes through WSL when one is available; otherwise it is not
  // run at all, and is reported as unverified rather than quietly passing.
  // Both paths return the SAME shape so nothing downstream has to branch.
  const useWsl = LINUX_SUITES.has(s.label) && Boolean(distro) && process.platform === "win32";
  let code: number;
  let procOut: string;
  if (useWsl) {
    const wsl = runUnderWsl(s.label, distro as string);
    code = wsl.code;
    procOut = wsl.output;
  } else {
    const proc = spawnSync(s.cmd, s.args, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
      encoding: "utf8",
    });
    code = proc.status ?? -1;
    procOut = `${proc.stdout ?? ""}${proc.stderr ?? ""}`;
  }
  // A suite that needs a real target platform is not a failure on the wrong
  // OS. `test-protected-routes.ts` boots the staged Linux artifact, which
  // cannot run on win32 by design — the artifact ships only Debian/musl query
  // engines. Reporting that as FAIL would train people to ignore failures, and
  // skipping it silently would let it rot. It is reported distinctly, and the
  // runner exits non-zero if any suite is platform-blocked, because a platform
  // gap is a gap in the release evidence and must be stated rather than hidden.
  const platformBlocked =
    !useWsl &&
    /needs query_engine|only run where the release targets|single-architecture by design/i.test(procOut);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  results.push({ label: s.label, code, seconds: Number(seconds) });

  const mark = code === 0 ? "  ok  " : platformBlocked ? "  n/a " : "  FAIL";
  const note = platformBlocked && code !== 0 ? "  (needs the release target platform)" : "";
  console.log(`${mark} ${s.label.padEnd(42)} ${seconds.padStart(6)}s${note}`);
  if (code !== 0 && platformBlocked) {
    blocked.push(s.label);
  } else if (code !== 0) {
    const detail = procOut.trim();
    // Persist the failing lines, not just the exit code. A record saying
    // "test-x.ts (exit 1)" sends you to re-run the suite to find out which
    // assertion broke; recording the lines makes the record self-sufficient.
    const lines = detail ? detail.split("\n") : [];
    // A failed assertion prints a "FAIL <name>" line. A suite that DIES instead
    // (an uncaught throw) prints no such line, so fall back to the error text --
    // otherwise the record shows a suite and an exit code and nothing in between.
    // Match the whole constructor name: "ReferenceError:" has no word boundary
    // before "Error", so a bare \bError: pattern misses every subclass.
    const badLines = lines.filter((l) => /^\s*(FAIL|not ok|\u2717|\u2715)/.test(l));
    if (badLines.length === 0) {
      const errLine = lines.find((l) => /^\s*(?:\w*Error|AssertionError)\b/.test(l.trim()));
      if (errLine) badLines.push(errLine.trim());
    }
    failures.push(`${s.label} (exit ${code})`);
    // Keep MORE than the tail. A suite that captures a subprocess's output and
    // only prints it on failure (test-cli-regression.sh does exactly this with
    // INSTALL_OUT) puts the actual reason far from the end of its output, so a
    // 14-line tail shows the summary and drops the cause -- which is what makes
    // such a failure undiagnosable from CI.
    failureDetail.push({ suite: s.label, exit: code, lines: badLines.slice(0, 12) });
    if (detail) {
      // A suite prints every assertion; the FAILING one can be far above the
      // tail, and a truncated report sends you hunting for a failure that is
      // not in it. Print the failure lines explicitly, then the tail.
      for (const line of badLines) console.log(`        > ${line}`);
      const tail = lines.slice(-14);
      for (const line of tail) console.log(`        | ${line}`);
      // Then the lines immediately AFTER each failing assertion, which is where
      // a suite that explains itself puts the reason.
      for (const line of badLines) {
        const idx = lines.indexOf(line);
        if (idx < 0) continue;
        for (const after of lines.slice(idx + 1, idx + 9)) {
          if (/^\s*(ok|FAIL)/.test(after)) break;
          if (after.trim()) console.log(`        : ${after}`);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Report.

/**
 * Record the run as machine-readable evidence.
 *
 * Without this, "the aggregate passed" exists only in a scrollback buffer, and
 * any tool that wants to reason about the ledger has to re-run 51 suites to
 * learn it. Writing a record on BOTH the pass and fail paths is what makes
 * "51/51, RESULT: PASS" checkable later, and makes a stale green claim
 * detectable instead of merely unlikely.
 */
function writeRunRecord(
  verdict: "PASS" | "FAIL",
  passed: number,
  total: number,
  seconds: string,
  failures: string[],
  skipped: string[],
  blocked: string[],
  results: Array<{ label: string; code: number; seconds: number }>,
): void {
  const evidenceDir = path.join(repoRoot, ".agent", "evidence");
  if (!existsSync(evidenceDir)) return;
  const record = {
    verdict,
    passed,
    total,
    seconds: Number(seconds),
    recordedAt: new Date().toISOString(),
    head: safeGitHead(),
    failures,
    failureDetail,
    skipped,
    blocked,
    suites: results.map((r) => ({ label: r.label, code: r.code })),
  };
  try {
    writeFileSync(
      path.join(evidenceDir, "last-aggregate-run.json"),
      JSON.stringify(record, null, 2) + "\n",
      "utf8",
    );
  } catch {
    // Never let evidence bookkeeping change the run's exit code.
  }
}

function safeGitHead(): string | null {
  // spawnSync only: this file imports spawnSync and not execFileSync, and
  // adding a second child_process import just to read a ref is not worth the
  // unused-import churn.
  try {
    const r = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    return r.status === 0 && r.stdout ? r.stdout.trim() : null;
  } catch {
    return null;
  }
}

const passed = results.filter((r) => r.code === 0).length;
const totalSeconds = results.reduce((a, r) => a + r.seconds, 0).toFixed(1);

console.log(`\n${"=".repeat(66)}`);
console.log(`  ${passed}/${results.length} suites passed in ${totalSeconds}s`);
if (skipped.length > 0) console.log(`  ${skipped.length} skipped (registered but missing on disk): ${skipped.join(", ")}`);
if (blocked.length > 0)
  console.log(`  ${blocked.length} need the release target platform (Ubuntu 22.04/24.04 amd64): ${blocked.join(", ")}`);

if (blocked.length > 0) {
  failures.push(
    `${blocked.length} suite(s) could not run on this platform and are unverified here: ${blocked.join(", ")}`,
  );
}

if (failures.length > 0) {
  console.log(`\n  FAILURES (${failures.length}):`);
  for (const f of failures) console.log(`    - ${f}`);
  console.log("");
  writeRunRecord("FAIL", passed, results.length, totalSeconds, failures, skipped, blocked, results);
  process.exit(1);
}

console.log("  RESULT: PASS");
console.log("");
writeRunRecord("PASS", passed, results.length, totalSeconds, failures, skipped, blocked, results);
