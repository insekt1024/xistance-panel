/**
 * TASK-106. The manifest's `runtime.node` must state the release's RUNTIME
 * contract, not the build host's version.
 *
 * The `build` CLI filled it with `process.version`, which on a build host
 * produced `v26.7.0` -- a v-prefixed BUILD-MACHINE version, in a field that
 * describes what the release runs on, in a manifest shipped to a target running
 * Node 22. Verified on a real target: the installed manifest read
 * `"node":"v26.7.0"` while the target reported `v22.23.3`.
 *
 * Two independent defects in one field:
 *   1. it named the wrong machine, and
 *   2. the `v` prefix is inconsistent with the plain semver `next`/`prisma` use.
 *
 * The fix records the installer's own floor. This suite pins that constant to
 * what the installers actually enforce, so it cannot drift.
 */
import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");

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

console.log("TASK-106 runtime.node states the release contract, not the build host\n");

// 1. The manifest builder must not embed the build host's own version.
const manifestSrc = fs.readFileSync(path.join(REPO, "scripts", "release-manifest.ts"), "utf8");
const cliBlock = manifestSrc.slice(manifestSrc.indexOf('command === "build"'));
check(
  "the build CLI does not use process.version for runtime.node",
  !/node:\s*process\.version/.test(cliBlock),
  "runtime.node is still the BUILD HOST's Node version",
);

// 2. The declared constant must equal what the installers enforce.
const declared = /RELEASE_NODE_MIN_MAJOR\s*=\s*"(\d+)"/.exec(manifestSrc)?.[1];
check("the manifest declares a Node minimum", declared !== undefined);

for (const installer of ["release-install.sh", "install.sh"]) {
  const file = path.join(REPO, "scripts", installer);
  if (!fs.existsSync(file)) {
    check(`${installer} exists`, false);
    continue;
  }
  const src = fs.readFileSync(file, "utf8");
  const enforced = /NODE_MIN_MAJOR=(\d+)/.exec(src)?.[1];
  check(
    `${installer} enforces the same Node minimum the manifest records`,
    enforced !== undefined && enforced === declared,
    `installer says ${enforced}, manifest says ${declared}`,
  );
  // The two installers gate differently and BOTH are correct:
  //   release-install.sh  node_major="$(node -p 'process.versions.node…')"  -lt $NODE_MIN_MAJOR
  //   install.sh           BASH_REMATCH[1] >= NODE_MIN_MAJOR  (deliberately not
  //                        `node -v | grep -q`, which SIGPIPEs under pipefail)
  // so accept either shape rather than one installer's idiom.
  const gatesOnMajor =
    /node_major[\s\S]{0,120}-lt[\s\S]{0,40}NODE_MIN_MAJOR/.test(src) ||
    /BASH_REMATCH\[1\][\s\S]{0,40}>=[\s\S]{0,20}NODE_MIN_MAJOR/.test(src);
  check(
    `${installer} gates on a major-version comparison (so a bare major is the right shape)`,
    gatesOnMajor,
    "the installer does not compare the major version against NODE_MIN_MAJOR",
  );
}

// 3. A shipped manifest must not carry a v-prefixed or build-host node value.
const shipped = path.join(REPO, "dist", "amd64", "release-manifest.json");
if (fs.existsSync(shipped)) {
  const m = JSON.parse(fs.readFileSync(shipped, "utf8")) as { runtime: { node: string } };
  check(
    "a shipped manifest records a bare major, not a v-prefixed build-host version",
    !m.runtime.node.startsWith("v") && !/\d+\.\d+\.\d+/.test(m.runtime.node),
    `runtime.node is "${m.runtime.node}"; expected the bare major "${declared}"`,
  );
  check(
    "a shipped manifest's runtime.node matches the installers",
    m.runtime.node === declared,
    `manifest ${m.runtime.node} vs installers ${declared}`,
  );
} else {
  check("a shipped manifest is available to inspect", false, "dist/amd64/release-manifest.json missing");
}

// 4. Non-vacuity: the comparison must be able to fail. A v-prefixed value and a
// wrong major are both rejected.
{
  const accept = (v: string): boolean => !v.startsWith("v") && !/\d+\.\d+\.\d+/.test(v) && v === declared;
  check("a v-prefixed value is rejected", !accept("v26.7.0"));
  check("a full build-host version is rejected", !accept("26.7.0"));
  check("a wrong major is rejected", !accept("20"));
  check("the correct value is accepted", accept(declared ?? ""));
}

console.log(`\n--- ${pass} passed, ${fail} failed ---`);
process.exit(fail === 0 ? 0 : 1);
