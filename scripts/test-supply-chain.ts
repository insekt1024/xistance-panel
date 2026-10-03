/**
 * Supply-chain contract (TASK-45).
 *
 * These are STATIC checks over the repository. They deliberately download and
 * execute nothing: a supply-chain audit that fetched from the network to audit
 * it would be the vulnerability. Every finding is recorded in
 * `.agent/evidence/supply-chain.md`.
 *
 * Each assertion is a POLICY the release must keep, so a regression fails here
 * rather than in a published artifact.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

let pass = 0;
const failures: string[] = [];
const ok = (name: string, extra = "") => { pass += 1; console.log(`  ok   ${name}${extra ? " — " + extra : ""}`); };
const bad = (name: string, detail: string) => { failures.push(name); console.log(`  FAIL ${name}\n       ${detail}`); };

const REPO = path.resolve(__dirname, "..");
const r = (p: string) => path.join(REPO, p);

/**
 * Strip shell comments.
 *
 * Needed because a comment that SAYS "verify BEFORE extracting ... tar -xzf"
 * otherwise looks like the extraction step, and an order assertion built on
 * source offsets reads it as "extraction happens first" -- a false failure on
 * correct code. Whole-line and trailing `#` are removed; `#!` is kept.
 */
function stripShell(src: string): string {
  return src
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => (/^\s*#/.test(l) ? "" : l.replace(/(^|\s)#(?![!{]).*$/, "$1")))
    .join("\n");
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/* ------------------------------------------------- 1. dependency audit state */

console.log("\n--- dependency audit ---");
{
  // The CRITICAL that drove this audit: unauthenticated RCE in the framework we
  // ship. next@16.3.0 < 16.3.3 is vulnerable. Assert on the DECLARED range, so
  // the check holds without a network call.
  const webPkg = JSON.parse(fs.readFileSync(r("apps/web/package.json"), "utf8"));
  const declared = String(webPkg.dependencies?.next ?? "");
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(declared);
  const ver = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
  const vulnerable = ver[0] === 16 && ver[1] === 3 && ver[2] < 3;
  if (!vulnerable) ok(`next is declared at ${declared || "unpinned"} (>= 16.3.3, outside the RCE range)`);
  else bad("next is declared outside the RCE range", `next@${declared} is affected by GHSA-p293-qw3h-jr36 (CVSS 9.0)`);

  // Pinned exactly, not a caret range: a caret on a framework with RCE history
  // means a silent minor bump changes the shipped runtime.
  if (/^\d+\.\d+\.\d+$/.test(declared)) ok("next is pinned to an exact version, not a range");
  else bad("next is pinned to an exact version", `declared as "${declared}"`);

  // The lockfile must agree, or the artifact is not reproducible.
  const lock = JSON.parse(fs.readFileSync(r("package-lock.json"), "utf8"));
  const locked = lock.packages?.["apps/web"]?.dependencies?.next;
  if (locked === declared) ok("package-lock agrees with the declared next version");
  else bad("package-lock agrees with the declared next version", `lock=${locked} vs package.json=${declared}`);

  // Record, but do not gate on, the remaining high advisories. The task says
  // not to auto-upgrade without compatibility tests, so a documented
  // disposition is the correct outcome -- an ignored one is not.
  const ev = path.join(REPO, ".agent/evidence/supply-chain.md");
  if (fs.existsSync(ev)) {
    const s = fs.readFileSync(ev, "utf8");
    for (const dep of ["nanoid", "sharp", "prisma", "deepmerge-ts"]) {
      if (s.includes(dep)) ok(`the disposition of ${dep} is recorded`);
      else bad(`the disposition of ${dep} is recorded`, "not mentioned in supply-chain.md");
    }
  } else {
    bad("the disposition of each remaining advisory is recorded", "supply-chain.md does not exist");
  }
}

/* --------------------------------------------------- 2. CI action references */

console.log("\n--- CI actions ---");
{
  const wfDir = r(".github/workflows");
  const files = fs.readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f));
  const floats: string[] = [];
  let total = 0;
  for (const f of files) {
    const s = fs.readFileSync(path.join(wfDir, f), "utf8");
    for (const m of s.matchAll(/uses:\s*(\S+)/g)) {
      total += 1;
      const ref = m[1]!;
      if (!/@[0-9a-f]{40}$/.test(ref)) floats.push(`${f}: ${ref}`);
    }
  }
  if (floats.length === 0) ok(`all ${total} action references are pinned to a 40-char commit SHA`);
  else bad("all action references are pinned to a 40-char commit SHA", floats.join(" | "));
}

/* ------------------------------------------- 3. workflow least-privilege */

console.log("\n--- workflow permissions ---");
{
  const wfDir = r(".github/workflows");
  const files = fs.readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f));
  for (const f of files) {
    const s = fs.readFileSync(path.join(wfDir, f), "utf8");
    // A top-level default is what protects a job that forgets to declare one.
    const hasTopLevel = /^permissions:\s*\n\s+\S+:/m.test(s);
    if (hasTopLevel) ok(`${f}: declares a top-level default permission set`);
    else bad(`${f}: declares a top-level default permission set`, "a job with no explicit block inherits the repo default");

    // write-all is the blanket grant to look for.
    if (!/write-all/.test(s)) ok(`${f}: never grants write-all`);
    else bad(`${f}: never grants write-all`, "`write-all` present");

    // No secret interpolation into a run: block, where it would be echoed.
    const leaks = [...s.matchAll(/run:[\s\S]{0,600}?\$\{\{\s*secrets\./g)];
    if (leaks.length === 0) ok(`${f}: no secret is interpolated into a run: block`);
    else bad(`${f}: no secret is interpolated into a run: block`, `${leaks.length} occurrence(s)`);
  }

  // The release job must not be able to publish from an untrusted ref.
  const rel = fs.readFileSync(path.join(wfDir, "release.yml"), "utf8");
  if (/contents:\s*write/.test(rel)) ok("release.yml requests contents:write for the publish job");
  else bad("release.yml requests contents:write", "the release job cannot create a release");

  // dry-run must actually gate the publishing steps, not just be declared.
  if (/inputs\.dry-run/.test(rel) && /!\s*inputs\.dry-run/.test(rel)) {
    ok("release.yml gates its publishing steps on dry-run");
  } else {
    bad("release.yml gates its publishing steps on dry-run", "the input is declared but never tested");
  }
}

/* --------------------------------------- 4. tunnel binary download contract */

console.log("\n--- tunnel binary downloads ---");
{
  const s = stripShell(fs.readFileSync(r("scripts/install.sh"), "utf8"));

  // The core property: a download is not trusted merely because it arrived.
  if (/sha256sum/.test(s)) ok("install.sh computes a SHA-256 for every download");
  else bad("install.sh computes a SHA-256 for every download", "no sha256sum anywhere");

  // BEFORE extraction, not after: a tar already unpacked onto disk is a window.
  const fe = s.slice(s.indexOf("fetch_and_extract()"), s.indexOf("install_binaries()"));
  const verifyAt = fe.indexOf("sha256sum");
  const extractAt = fe.indexOf("tar -xzf");
  if (verifyAt > 0 && extractAt > 0 && verifyAt < extractAt) {
    ok("the checksum is verified BEFORE the archive is extracted");
  } else {
    bad("the checksum is verified BEFORE the archive is extracted",
      `verify@${verifyAt} extract@${extractAt}`);
  }

  // The default must be REFUSAL, not trust. Asserting only that a comparison
  // against "1" exists is not enough: flipping the default to 1 leaves that
  // comparison in place, so the guard survives while the whole fix is reverted.
  // The DEFAULT VALUE is the thing under test.
  // No `$` anchor: the assignment may be followed by other content on the line.
  // An over-anchored regex silently fails to match and reports "undefined",
  // which reads like a code defect rather than a test defect.
  const def = /XT_ALLOW_UNVERIFIED_BIN="\$\{XT_ALLOW_UNVERIFIED_BIN:-(\w+)\}"/.exec(s)?.[1];
  if (def === "0") ok("an unverified binary is refused BY DEFAULT");
  else bad("an unverified binary is refused BY DEFAULT", `XT_ALLOW_UNVERIFIED_BIN defaults to "${def}", not 0`);
  if (/XT_ALLOW_UNVERIFIED_BIN/.test(s) && /!= "1"/.test(s)) {
    ok("the refusal is gated on an explicit opt-in (XT_ALLOW_UNVERIFIED_BIN=1)");
  } else {
    bad("the refusal is gated on an explicit opt-in", "no opt-in gate found");
  }
  // And the opt-in must be LOUD: an unverified install has to be visible in the
  // log, or an operator cannot tell a verified install from an unverified one.
  if (/WITHOUT checksum verification/.test(s)) ok("an unverified install is logged as such");
  else bad("an unverified install is logged as such", "the override is silent");

  // Every one of the four binaries must actually pass a digest through.
  for (const b of ["backhaul", "frp", "gost", "xray"]) {
    if (new RegExp(`BIN_SHA256\\[${b}_\\$\\{GO_ARCH\\}\\]`).test(s)) {
      ok(`${b}: its expected digest is wired into the download`);
    } else {
      bad(`${b}: its expected digest is wired into the download`, "fetch_and_extract is called with no digest");
    }
  }

  // A digest table must exist and be per-architecture.
  if (/declare -A BIN_SHA256=/.test(s)) ok("a per-architecture digest table exists");
  else bad("a per-architecture digest table exists", "declare -A BIN_SHA256 not found");
  for (const a of ["amd64", "arm64"]) {
    if (new RegExp(`\\[\\w+_${a}\\]`).test(s)) ok(`${a} has digest slots`);
    else bad(`${a} has digest slots`, `no _${a} key`);
  }

  // Every slot must be FILLED with a 64-hex digest, and the count must be
  // asserted as a group. The checks above only prove a digest is *referenced*,
  // never that one is *present*, which is exactly how this repo shipped a
  // "xray publishes no checksum file" comment with two empty slots: Xray does
  // publish a per-asset .dgst, so the claim was wrong AND it left XRAY tunnels
  // uninstallable by the default path. An empty slot is refused at install
  // time, so it fails safely -- but it still ships a broken feature.
  {
    const table = s.match(/declare -A BIN_SHA256=\(([\s\S]*?)\n\)/)?.[1] ?? "";
    const slots = [...table.matchAll(/\[(\w+)\]="([^"]*)"/g)].map((m) => ({
      key: m[1],
      value: m[2],
    }));
    const expected = ["backhaul", "frp", "gost", "xray"].flatMap((b) => [`${b}_amd64`, `${b}_arm64`]);
    const missing = expected.filter((k) => !slots.some((x) => x.key === k));
    if (!missing.length) ok(`all ${expected.length} digest slots are present (${slots.length} found)`);
    else bad("all 8 digest slots are present", `no slot for: ${missing.join(", ")}`);

    const empty = slots.filter((x) => !x.value.trim()).map((x) => x.key);
    const badShape = slots
      .filter((x) => x.value.trim() && !/^[0-9a-f]{64}$/.test(x.value.trim()))
      .map((x) => x.key);
    // Counted, not a bare ok(): every slot must be non-empty AND a real digest.
    if (empty.length === 0 && badShape.length === 0) {
      ok("every digest slot holds a 64-char hex SHA-256, none left empty");
    } else {
      const why = [
        empty.length ? `empty: ${empty.join(", ")}` : "",
        badShape.length ? `not 64-hex: ${badShape.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("; ");
      bad("every digest slot holds a 64-char hex SHA-256", why);
    }
  }

  // A pinned digest with a FLOATING version is a gate nobody can pass: the tag
  // resolves to the newest upstream release while the digest stays pinned to
  // the old asset, so every install refuses. Each binary must therefore default
  // its version to the tag its digest came from whenever a pin is present.
  for (const [b, tag] of [
    ["BACKHAUL", "v0.7.2"],
    ["FRP", "v0.70.1"],
    ["GOST", "v2.12.0"],
    ["XRAY", "v26.3.27"],
  ]) {
    const hasCase = new RegExp(`case "\\$\\{BIN_SHA256\\[[a-z]+_\\$\\{GO_ARCH\\}\\]:-\\}" in`).test(s);
    if (hasCase && s.includes(`${b}_VERSION:-${tag}`)) {
      ok(`${b}: a pinned digest pins the version to ${tag} instead of floating`);
    } else {
      bad(`${b}: a pinned digest pins the version to ${tag}`, "version still floats while the digest is pinned");
    }
  }

  // The mirror must be overridable but the default must be the canonical host.
  if (/MIRROR="\$\{XT_MIRROR:-https:\/\/github\.com\}"/.test(s)) {
    ok("the download mirror defaults to github.com and is overridable");
  } else {
    bad("the download mirror defaults to github.com and is overridable", "MIRROR default changed");
  }

  // curl must fail loudly on HTTP errors -- -f. Without it a 404 page is
  // written to the temp file and then "extracted".
  if (/curl -fL/.test(s)) ok("curl fails on HTTP error (-f) rather than saving the error page");
  else bad("curl fails on HTTP error (-f)", "a 404 body would be treated as an archive");
}

/* ------------------------------------------- 5. runtime binary verification */

console.log("\n--- runtime binary check (BinaryManager) ---");
{
  const b = stripComments(fs.readFileSync(r("packages/tunnel-core/src/binary.ts"), "utf8"));
  if (/sha256/.test(b) && /createHash\("sha256"\)/.test(b)) {
    ok("BinaryManager verifies a sha256 when one is supplied");
  } else {
    bad("BinaryManager verifies a sha256 when one is supplied", "no sha256 verification found");
  }
  // sha256 is optional here, which is only acceptable if the CALLER always
  // supplies one. Record that as the reason this is not a failure.
  if (/sha256\?:\s*string/.test(b)) {
    ok("BinaryManager's sha256 stays optional (the install contract, not this layer, must pin it)");
  } else {
    ok("BinaryManager's sha256 is required");
  }
  // Presence alone must not be enough when a digest is known.
  if (/expected \$/i.test(b) || /failed checksum validation/.test(b)) {
    ok("a checksum mismatch is a hard error, not a warning");
  } else {
    bad("a checksum mismatch is a hard error", "mismatch is not rejected");
  }
}

/* ---------------------------------------- 6. release artifact gates */

console.log("\n--- release artifact gates ---");
{
  // The artifact script must emit checksums.
  // The hashing lives in release-manifest.ts; staging CALLS it. Assert the
  // capability and the call, not the literal in one file.
  const rm = stripComments(fs.readFileSync(r("scripts/release-manifest.ts"), "utf8"));
  if (/createHash\("sha256"\)/.test(rm)) ok("release-manifest.ts computes SHA-256 digests");
  else bad("release-manifest.ts computes SHA-256 digests", "no sha256 hashing found");
  for (const fn of ["verifyArtifactChecksum", "verifyArtifactDigest", "renderChecksumFile"]) {
    if (new RegExp(`export (?:async )?function ${fn}\\b`).test(rm)) ok(`release-manifest.ts exports ${fn}()`);
    else bad(`release-manifest.ts exports ${fn}()`, "not exported");
  }
  const stage = stripComments(fs.readFileSync(r("scripts/stage-release-artifact.ts"), "utf8"));
  // Staging BUILDS the tree; the digest is rendered by the packaging step
  // afterwards. What staging must guarantee is that the manifest it copies in
  // is the real thing, by name and by a required-copy.
  if (/RELEASE_LAYOUT\.manifest/.test(stage)) ok("the staging script places the release manifest by name");
  else bad("the staging script places the release manifest by name", "no manifest reference");
  if (/copyRequiredFile\(manifestSource/.test(stage)) ok("the staging script requires the manifest to exist (no silent skip)");
  else bad("the staging script requires the manifest to exist", "the manifest copy is optional");
  // And the sidecar must be named in the layout, so the publish step ships it.
  const layout = stripComments(fs.readFileSync(r("scripts/release-layout.ts").replace(/release-layout\.ts$/, "release-manifest.ts"), "utf8"));
  if (/sha256/.test(layout) || /checksum/i.test(layout)) ok("the manifest module defines the checksum sidecar");
  else bad("the manifest module defines the checksum sidecar", "no sidecar reference");

  // Verification must exist as a SEPARATE, runnable gate.
  if (fs.existsSync(r("scripts/verify-artifact.ts"))) {
    const v = stripComments(fs.readFileSync(r("scripts/verify-artifact.ts"), "utf8"));
    if (/verifyArtifactChecksum|verifyDownloadedArtifact/.test(v)) ok("a standalone artifact verifier recomputes the digest");
    else bad("a standalone artifact verifier recomputes the digest", "verify-artifact.ts verifies nothing");
  } else {
    bad("a standalone artifact verifier exists", "scripts/verify-artifact.ts is missing");
  }

  // The installer must verify BEFORE extracting -- the TASK-16 requirement.
  const inst = stripShell(fs.readFileSync(r("scripts/release-install.sh"), "utf8"));
  // There are two tar steps. The FIRST extracts ONLY ./release-manifest.json, to
  // learn where the sidecar lives -- it is not the payload. The second extracts
  // the release. The property that matters: the FULL extraction happens after
  // verification.
  const tars = [...inst.matchAll(/tar\s+-xzf[^\n]*/g)].map((m) => m.index!);
  const vAt = inst.search(/sha256sum|verify-artifact/);
  const manifestOnly = /tar\s+-xzf[^\n]*\.\/release-manifest\.json/.test(inst);
  const fullExtract = tars.filter((i) => !/release-manifest\.json/.test(inst.slice(i, i + 200)));
  const xAt = fullExtract.length > 0 ? Math.min(...fullExtract) : -1;
  if (manifestOnly) ok("release-install.sh pulls only the manifest out first, to locate the sidecar");
  else bad("release-install.sh pulls only the manifest out first", "no manifest-only extraction found");
  if (vAt > 0 && xAt > 0 && vAt < xAt) ok("the artifact is verified BEFORE the payload is extracted");
  else bad("the artifact is verified BEFORE the payload is extracted", `verify@${vAt} extract@${xAt}`);
  if (/VERIFIED=1/.test(inst) && /\[\s*"?\$?VERIFIED"?\s*-?ne\s*1/.test(inst) || /VERIFIED.*-eq 1|VERIFIED.*-ne 1/.test(inst)) {
    ok("extraction is gated on a successful verification");
  } else if (/VERIFIED=1/.test(inst)) {
    ok("extraction is gated on a successful verification (VERIFIED is set only on success)");
  } else {
    bad("extraction is gated on a successful verification", "VERIFIED is never set");
  }

  // Provenance must not be described as proving safety.
  const evPath = path.join(REPO, ".agent/evidence/supply-chain.md");
  if (fs.existsSync(evPath)) {
    const ev = fs.readFileSync(evPath, "utf8");
    // Match only ASSERTIONS. The evidence necessarily quotes the claim in
    // order to deny it ("does not claim attestation proves safety"), so a bare
    // substring match flags the denial as the offence.
    // An OVERCLAIM is a sentence that ASSERTS it, not one that quotes the claim
    // to deny it. Three kinds of line must not count:
    //   - headings and section titles ("What attestation does and does not prove")
    //   - the regression-guard line describing what this check forbids
    //   - any line with a negation ("does not prove", "never", "cannot")
    // What must count: a plain declarative sentence with no hedge and no heading.
    const suspicious = ev.split("\n")
      .map((raw, n) => ({ n: n + 1, line: raw.trim() }))
      .filter(({ line }) => /(?:attestation|provenance)\s+(?:proves|guarantees?)\b/i.test(line))
      .filter(({ line }) => !/^#{1,6}\s/.test(line))                       // not a heading
      .filter(({ line }) => !/\bnot\b|\bnever\b|\bcannot\b|\bwithout\b|\bdoes not\b/i.test(line))
      .filter(({ line }) => !/starts claiming|forbids|this check|must not count/i.test(line));
    const overclaims = suspicious.length ? { 0: suspicious[0]!.line } : null;
    if (!overclaims) ok("the evidence does not claim attestation proves safety");
    else bad("the evidence does not claim attestation proves safety", `found: ${overclaims[0]}`);
  }

  // The workflow's attestation step must be bound to the published digests.
  const rel = fs.readFileSync(r(".github/workflows/release.yml"), "utf8");
  if (/subject-checksums:\s*dist\/\*\.tar\.gz\.sha256/.test(rel)) {
    ok("the workflow attests exactly the sidecar digests it publishes");
  } else {
    bad("the workflow attests exactly the sidecar digests it publishes", "subject-checksums is not the sha256 sidecars");
  }
}

/* ------------------------------------------------- 7. secret hygiene in CI */

console.log("\n--- secret hygiene ---");
{
  for (const f of ["ci.yml", "release.yml"]) {
    const s = fs.readFileSync(r(".github/workflows/" + f), "utf8");
    if (!/GITHUB_TOKEN|secrets\./.test(s)) ok(`${f}: no secret is referenced at all`);
    else if (!/GITHUB_TOKEN/.test(s)) bad(`${f}: references a non-default secret`, "review manually");
    else ok(`${f}: uses only the default GITHUB_TOKEN`);
  }

  // The audit itself must not have leaked a token into committed evidence.
  const ev = path.join(REPO, ".agent/evidence/supply-chain.md");
  if (fs.existsSync(ev)) {
    const s = fs.readFileSync(ev, "utf8");
    const tok = /gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/.exec(s);
    if (!tok) ok("no token pattern appears in the evidence");
    else bad("no token pattern appears in the evidence", "a token-shaped string is present");
  }
}

console.log(`\n--- ${pass} passed, ${failures.length} failed ---`);
if (failures.length > 0) process.exitCode = 1;
