/**
 * TASK-78: the staged Prisma engine allowlist must name files Prisma really
 * produces, and the arm64 names must be prefixed platform ids rather than a
 * guessed `-arm64` suffix on a debian id.
 *
 * The defect this pins shut: `PRISMA_LINUX_ENGINES.arm64` listed
 * `libquery_engine-debian-openssl-3.0.x-arm64.so.node`, which Prisma neither
 * publishes nor writes, together with the arch-free
 * `libquery_engine-linux-musl-openssl-3.0.x.so.node`, which is an amd64 binary.
 * The arm64 release cell would have failed inspection forever, or shipped an
 * engine of the wrong architecture.
 *
 * Prisma names a Linux query engine deterministically. The client runtime builds
 * the name with:
 *
 *     t.includes("windows") -> query_engine[-<id>].dll.node
 *     t.includes("darwin")  -> libquery_engine[-<id>].dylib.node
 *     otherwise             -> libquery_engine-<id>.so.node
 *
 * where `<id>` is a platform id from `binaryTargets`. So the invariant is exactly:
 * every allowlist name is `libquery_engine-<declared-target>.so.node`. Deriving
 * the expectation from the *installed* packages means a future Prisma rename
 * fails here instead of breaking a release.
 *
 * Do NOT cross-check the allowlist against the literal `libquery_engine-…`
 * strings baked into the client loader table: that table only lists engines
 * pre-bundled with the package, so a perfectly valid
 * `linux-musl-arm64-openssl-3.0.x` engine (downloaded, not bundled) looks absent
 * and produces a false failure. Validate the naming RULE plus the declared
 * target set instead.
 *
 * Part 1 is offline and always runs. Part 2 (`XT_PROBE_PRISMA=1`) probes
 * binaries.prisma.sh and needs network, so it is excluded from the portable
 * aggregate runner.
 *
 * No credentials, tokens, or connection details are used or printed.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PRISMA_LINUX_ENGINES, type ReleaseArchitecture } from "./inspect-release-artifact.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed += 1;
    failures.push(name);
    console.log(`  FAIL ${name}: ${(error as Error).message.split("\n")[0]}`);
  }
}

function readInstalled(rel: string): string | null {
  const file = path.join(REPO_ROOT, "node_modules", ...rel.split("/"));
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
}

function repoFiles(dir: string, suffix: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...repoFiles(full, suffix));
    else if (entry.name.endsWith(suffix)) out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. OFFLINE: allowlist <-> installed Prisma
// ---------------------------------------------------------------------------

const binaryJs = readInstalled("@prisma/client/runtime/binary.js");
const getPlatformChunks = repoFiles(
  path.join(REPO_ROOT, "node_modules", "@prisma", "get-platform", "dist"),
  ".js",
).map((file) => fs.readFileSync(file, "utf8")).join("\n");

check("installed @prisma/client runtime and @prisma/get-platform are readable", () => {
  assert.ok(binaryJs, "@prisma/client/runtime/binary.js missing - run npm install");
  assert.ok(getPlatformChunks, "@prisma/get-platform/dist/*.js missing - run npm install");
});

/** Platform ids Prisma declares a binary target for. */
function declaredBinaryTargets(): Set<string> {
  // Scope the scan to the table itself; a whole-chunk scan also picks up
  // unrelated quoted strings and would report a target Prisma never builds.
  const block = getPlatformChunks.match(/binaryTargets\s*=\s*\[([\s\S]{0,4000}?)\]/);
  assert.ok(block, "could not locate the binaryTargets table in @prisma/get-platform");
  const targets = new Set<string>();
  for (const match of (block?.[1] ?? "").matchAll(/"([a-z0-9.-]+)"/g)) {
    if (match[1]) targets.add(match[1]);
  }
  assert.ok(targets.size > 0, "the binaryTargets table parsed to an empty set");
  return targets;
}

/** The filename Prisma writes for a Linux platform id (see the docblock rule). */
function localEngineName(platformId: string): string {
  return `libquery_engine-${platformId}.so.node`;
}

/** Platform id encoded in an allowlist name, or null if not well formed. */
function platformIdOf(name: string): string | null {
  return name.match(/^libquery_engine-([a-z0-9.-]+)\.so\.node$/)?.[1] ?? null;
}

const targets = declaredBinaryTargets();

check("the installed client builds Linux engine names as libquery_engine-<id>.so.node", () => {
  // The rule the whole allowlist depends on, read back out of the minified
  // client. The base is a constant and the suffix is a template, so neither
  // half appears as a literal `libquery_engine-<id>.so.node` string.
  const source = binaryJs ?? "";
  const builder = source.match(/function \w+\(t,e\)\{let \w+=e==="url";return t\.includes\("windows"\)\?/);
  assert.ok(
    builder,
    "the client no longer builds engine filenames from a platform id and a url/local flag",
  );
  assert.match(
    source,
    /"libquery_engine"/,
    "the client no longer has libquery_engine as the engine name base",
  );
  assert.match(
    source,
    /\.so\.node/,
    "the client no longer produces .so.node engine filenames for Linux",
  );
  assert.match(
    source,
    /linux-musl-arm64/,
    "the installed client does not know the linux-musl-arm64 target",
  );
});

check("the pinned target set contains the arm64 ids the release depends on", () => {
  for (const id of ["linux-arm64-openssl-3.0.x", "linux-musl-arm64-openssl-3.0.x"]) {
    assert.ok(targets.has(id), `precondition: ${id} must be a declared binary target`);
  }
});

for (const arch of ["amd64", "arm64"] as ReleaseArchitecture[]) {
  check(`every ${arch} allowlist name is a well-formed Linux engine filename`, () => {
    const malformed = PRISMA_LINUX_ENGINES[arch].filter((n) => platformIdOf(n) === null);
    assert.deepEqual(
      malformed,
      [],
      `not of the form libquery_engine-<id>.so.node: ${malformed.join(", ")}`,
    );
  });

  check(`every ${arch} allowlist platform id is a declared Prisma binary target`, () => {
    for (const name of PRISMA_LINUX_ENGINES[arch]) {
      const id = platformIdOf(name);
      assert.ok(id, `${name} is not a well-formed engine filename`);
      assert.ok(
        targets.has(id),
        `${arch} name ${name} implies platform id "${id}", which Prisma does not declare as a binary target`,
      );
    }
  });

  check(`the ${arch} allowlist is free of cross-architecture names`, () => {
    const foreign = PRISMA_LINUX_ENGINES[arch].filter((name) => {
      const isArm = /arm64/.test(name);
      return arch === "arm64" ? !isArm : isArm;
    });
    assert.deepEqual(
      foreign,
      [],
      `${arch} allowlist admits a ${arch === "arm64" ? "non-arm64" : "non-amd64"} engine: ${foreign.join(", ")}`,
    );
  });
}

check("arm64 accepts the prefixed linux-arm64 id, not an -arm64 debian suffix", () => {
  const arm = PRISMA_LINUX_ENGINES.arm64;
  assert.ok(
    arm.includes(localEngineName("linux-arm64-openssl-3.0.x")),
    "arm64 must accept libquery_engine-linux-arm64-openssl-3.0.x.so.node",
  );
  assert.deepEqual(
    arm.filter((n) => /-openssl-[0-9.]+x-arm64\.so\.node$/.test(n)),
    [],
    "arm64 must not use a guessed -arm64 suffix on a debian/rhel id",
  );
});

check("arm64 musl is arch-specific (the arch-free linux-musl engine is amd64)", () => {
  const arm = PRISMA_LINUX_ENGINES.arm64;
  assert.ok(
    !arm.includes(localEngineName("linux-musl-openssl-3.0.x")),
    "the arch-free linux-musl engine is an amd64 binary and must not satisfy arm64",
  );
  assert.ok(
    arm.includes(localEngineName("linux-musl-arm64-openssl-3.0.x")),
    "arm64 musl must use the linux-musl-arm64 id",
  );
});

check("amd64 keeps its proven engine set unchanged", () => {
  assert.deepEqual([...PRISMA_LINUX_ENGINES.amd64], [
    "libquery_engine-debian-openssl-3.0.x.so.node",
    "libquery_engine-debian-openssl-1.1.x.so.node",
    "libquery_engine-linux-musl-openssl-3.0.x.so.node",
  ]);
});

check("linux-static-arm64 is not used as a query engine (target exists, binary does not)", () => {
  assert.ok(targets.has("linux-static-arm64"), "precondition: linux-static-arm64 is a declared target");
  const used = [...PRISMA_LINUX_ENGINES.amd64, ...PRISMA_LINUX_ENGINES.arm64].map(platformIdOf);
  assert.ok(
    !used.includes("linux-static-arm64"),
    "linux-static-arm64 has no published query engine and must not be in the allowlist",
  );
});

// ---------------------------------------------------------------------------
// 2. ONLINE (opt-in): probe the pinned engines commit
// ---------------------------------------------------------------------------

async function probePublished(): Promise<void> {
  const versionJson = readInstalled("@prisma/engines-version/package.json");
  const commit: unknown = versionJson ? JSON.parse(versionJson).prisma?.enginesVersion : undefined;

  check("pinned engines commit is a real 40-char sha", () => {
    assert.equal(
      typeof commit,
      "string",
      "could not read @prisma/engines-version -> prisma.enginesVersion",
    );
    assert.match(commit as string, /^[0-9a-f]{40}$/);
  });

  const sha = typeof commit === "string" ? commit : "";
  if (!/^[0-9a-f]{40}$/.test(sha)) return;

  const probe = async (platform: string): Promise<number> => {
    const url = `https://binaries.prisma.sh/all_commits/${sha}/${platform}/libquery_engine.so.node.gz`;
    const response = await fetch(url, { method: "HEAD", redirect: "follow" });
    return response.status;
  };

  let control = 0;
  try {
    control = await probe("debian-openssl-3.0.x");
  } catch (error) {
    check("x64 control probe reachable", () => {
      throw new Error(`network probe failed: ${(error as Error).message}`);
    });
    return;
  }

  check("x64 control answers 200 (without it every 404 is uninterpretable)", () => {
    assert.equal(control, 200, `debian-openssl-3.0.x returned ${control}, not 200`);
  });

  if (control !== 200) return;

  for (const name of PRISMA_LINUX_ENGINES.arm64) {
    const id = platformIdOf(name);
    if (!id) continue;
    const status = await probe(id);
    check(`published: ${id}`, () => {
      assert.equal(status, 200, `${id} returned ${status}, not 200`);
    });
  }
}

if (process.env.XT_PROBE_PRISMA === "1") {
  probePublished().catch((error: unknown) => {
    failed += 1;
    failures.push("online probe");
    console.error(`  FAIL online probe: ${(error as Error).message}`);
  }).then(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) {
      console.error(`failed: ${failures.join(", ")}`);
      process.exit(1);
    }
  });
} else {
  console.log("  skip online binaries.prisma.sh probe (set XT_PROBE_PRISMA=1 to enable)");
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error(`failed: ${failures.join(", ")}`);
    process.exit(1);
  }
}
