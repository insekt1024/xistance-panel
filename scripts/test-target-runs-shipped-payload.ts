/**
 * TASK-98. A target must run the payload that SHIPS.
 *
 * TASK-96 rebuilt the staged tree and the archive. The install on both targets
 * had been proven against the PREVIOUS artifact, so "the installer works" and
 * "this artifact installs" were two separate claims that happened to sit in the
 * same evidence file. Nothing compared the running tree to the published one.
 *
 * This suite closes that. It compares, per file, the local staged tree against
 * each running target's release directory, and requires the embedded manifest
 * digest to agree on all three sides.
 *
 * Per-file comparison, not a recomputed tree digest, for two reasons:
 *
 *   1. `stagedPayloadDigest` sorts entries per directory during a depth-first
 *      walk; a shell `find | sort` sorts globally. Same tree, different order,
 *      different digest -- a shell reimplementation is a NEW algorithm, not a
 *      check of the original. Per-file hashes are order-independent.
 *   2. The target runs Node 22, which cannot `node --experimental-strip-types` a
 *      .ts file, so shipping the helper is not available anyway.
 *
 * Both comparisons are locale-independent (LC_ALL=C): `sort` under a different
 * collation manufactures differences that do not exist.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const TARGETS = ["xtinst", "xt24"] as const;
const RELEASE = "/opt/xistance/current";

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

function dockerAvailable(): boolean {
  const r = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
    timeout: 30_000,
  });
  return r.status === 0;
}

if (!dockerAvailable()) {
  console.log("  SKIP docker is not available; target identity cannot be checked here");
  skip += 1;
}

/** Per-file "sha256  relative/path" listing of a directory, sorted bytewise. */
function treeHashes(root: string, via?: string): string | null {
  const script = `
    cd ${JSON.stringify(root)} || exit 1
    find . -type f ! -name release-manifest.json -printf '%P\\n' | LC_ALL=C sort | while IFS= read -r f; do
      printf '%s  %s\\n' "$(sha256sum "$f" | cut -d' ' -f1)" "$f"
    done
  `;
  const r = via
    ? spawnSync("docker", ["exec", via, "bash", "-lc", script], { encoding: "utf8", timeout: 300_000 })
    : spawnSync("bash", ["-lc", script], { encoding: "utf8", timeout: 300_000 });
  if (r.status !== 0 || !r.stdout) return null;
  return r.stdout;
}

function compareSets(a: string, b: string): { onlyA: string[]; onlyB: string[]; changed: string[] } {
  const parse = (s: string): Map<string, string> => {
    const m = new Map<string, string>();
    for (const line of s.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      const [hash, ...rest] = t.split(/\s+/);
      m.set(rest.join(" "), hash);
    }
    return m;
  };
  const ma = parse(a);
  const mb = parse(b);
  const onlyA: string[] = [];
  const onlyB: string[] = [];
  const changed: string[] = [];
  for (const [f, h] of ma) {
    if (!mb.has(f)) onlyA.push(f);
    else if (mb.get(f) !== h) changed.push(f);
  }
  for (const f of mb.keys()) if (!ma.has(f)) onlyB.push(f);
  return { onlyA, onlyB, changed };
}

function main(): void {
  console.log("TASK-98 a target must run the payload that ships\n");

  if (pass === 0 && skip === 0 && !dockerAvailable()) {
    console.log("\n--- 0 passed, 0 failed, 1 skipped ---");
    return;
  }

  const stagedDir = path.join(REPO, "dist", "artifact");
  if (!fs.existsSync(stagedDir)) {
    check("the local staged tree exists", false, `missing ${stagedDir}`);
    console.log(`\n--- ${pass} passed, ${fail} failed ---`);
    process.exit(1);
  }

  const local = treeHashes(stagedDir);
  if (local === null) {
    check("the local staged tree could be hashed", false);
    console.log(`\n--- ${pass} passed, ${fail} failed ---`);
    process.exit(1);
  }
  const localCount = local.split("\n").filter((l) => l.trim()).length;
  console.log(`  local staged tree: ${localCount} files`);

  const shippedDigest = (
    JSON.parse(fs.readFileSync(path.join(REPO, "release-manifest.json"), "utf8")) as {
      artifact: { sha256: string };
    }
  ).artifact.sha256;
  console.log(`  shipped digest   : ${shippedDigest.slice(0, 24)}...\n`);

  for (const target of TARGETS) {
    const running = spawnSync("docker", ["exec", target, "readlink", "-f", RELEASE], {
      encoding: "utf8",
      timeout: 60_000,
    });
    if (running.status !== 0) {
      check(`${target}: a release is installed`, false, `cannot read ${RELEASE}`);
      continue;
    }
    console.log(`--- ${target} : ${running.stdout.trim()}`);

    const remote = treeHashes(RELEASE, target);
    if (remote === null) {
      check(`${target}: the release tree could be hashed`, false);
      continue;
    }

    const { onlyA, onlyB, changed } = compareSets(local, remote);
    check(
      `${target}: every installed file matches the shipped tree`,
      onlyA.length === 0 && onlyB.length === 0 && changed.length === 0,
      [
        onlyA.length ? `only in the shipped tree: ${onlyA.slice(0, 3).join(", ")}` : "",
        onlyB.length ? `only on the target     : ${onlyB.slice(0, 3).join(", ")}` : "",
        changed.length ? `content differs        : ${changed.slice(0, 3).join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );

    const manifest = spawnSync(
      "docker",
      [
        "exec",
        target,
        "node",
        "-e",
        `process.stdout.write(require("${RELEASE}/release-manifest.json").artifact.sha256)`,
      ],
      { encoding: "utf8", timeout: 120_000 },
    );
    const installedDigest = (manifest.stdout ?? "").trim();
    check(
      `${target}: the embedded manifest digest is the shipped digest`,
      installedDigest === shippedDigest,
      `installed ${installedDigest.slice(0, 24) || "(none)"}… vs shipped ${shippedDigest.slice(0, 24)}…`,
    );
  }

  // ---------------------------------------------------------------------
  // Non-vacuity: the comparison must be able to report a difference. Compare
  // the shipped tree against itself with one entry removed, and require the
  // comparison to notice.
  // ---------------------------------------------------------------------
  {
    const first = local.split("\n").filter((l) => l.trim())[0];
    if (!first) {
      check("the non-vacuity control has an entry to remove", false);
    } else {
      const { onlyA } = compareSets(local, local.split("\n").filter((l) => l !== first).join("\n") + "\n");
      check(
        "a tree missing one file IS reported as a difference",
        onlyA.length === 1,
        "removing an entry produced no difference, so the per-file comparison cannot fail",
      );
    }
  }

  console.log(`\n--- ${pass} passed, ${fail} failed, ${skip} skipped ---`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
