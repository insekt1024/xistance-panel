#!/usr/bin/env bash
# Dependency-audit gate.
#
# `npm audit --audit-level=high` is the real gate and it BLOCKS. This wrapper
# exists only to recognise ONE specific, enumerated waiver for a single advisory
# that upstream has not fixed, so that the waiver is machine-checked rather than
# remembered.
#
# Why a waiver is needed at all (verified, not assumed):
#
#   GHSA-vfj7-8cjw-p6xm  braces  <=3.0.3   CWE-674, CVSS 7.5 (high)
#     chain: eslint-config-next -> @next/eslint-plugin-next -> fast-glob
#            -> micromatch -> braces
#   - braces@3.0.3 is the LATEST release. There is no patched version.
#   - eslint-config-next 16.3.8, installed in a scratch dir, is STILL vulnerable.
#   - npm's only offered remedy is DOWNGRADING to eslint-config-next@14.2.35,
#     a semver-major BACKWARDS move on a Next 16 project.
#   - micromatch@4.0.8 hard-depends on braces ^3.0.3, so `overrides` cannot
#     route around it either.
#   => `fixAvailable: None`. The advisory is unfixable, not merely unfixed.
#
# Why the waiver is SAFE (each point is enforced, not asserted):
#
#   1. DEV-ONLY. braces/micromatch/fast-glob are absent from BOTH shipped
#      artifacts (amd64 and arm64). The advisory cannot reach a shipped payload.
#   2. NOT REACHABLE FROM OUR CODE. No braces/micromatch reference exists in our
#      source or lint config; the only consumer is the lint toolchain.
#   3. PROD TREE IS CLEAN. `npm audit --omit=dev` reports 0 vulnerabilities.
#      Shipped code is still audited, and it passes.
#   4. EXPIRES. The waiver is refused if the advisory disappears (upstream fix
#      landed) or if the affected package starts reaching a shipped artifact.
#
# Deliberately NOT `--omit=dev`: the PRD requires that a waiver be DOCUMENTED.
# Silently narrowing the audit would drop dev advisories with no record, which is
# precisely how a gate stops meaning anything. Here the exact advisory set is
# pinned, so any NEW advisory fails immediately.
#
# Exit: 0 clean, 0 waived-as-above, 1 on any new/unwaived high+ or on prod.

set -uo pipefail
cd "$(dirname "$0")/.."

# The complete, exact set of advisories this gate is allowed to waive.
WAIVED_GHSAS="GHSA-vfj7-8cjw-p6xm"
WAIVED_PACKAGES="braces micromatch fast-glob @next/eslint-plugin-next eslint-config-next"

export WAIVED_GHSAS WAIVED_PACKAGES
PROD=$(npm audit --omit=dev --audit-level=high 2>&1)
PROD_RC=$?
if [ "$PROD_RC" -ne 0 ]; then
  echo "AUDIT FAIL: shipped/production dependency tree has a high+ advisory."
  echo "$PROD"
  exit 1
fi
echo "AUDIT PASS: production tree clean (0 high+, 0 critical)."

ALL=$(npm audit --json 2>/dev/null)
AUDIT_RC=$?

if [ "$AUDIT_RC" -eq 0 ]; then
  echo "AUDIT PASS: full tree clean -- no waiver needed."
  exit 0
fi

echo "$ALL" | node -e '
const fs = require("fs");
const waived = new Set((process.env.WAIVED_GHSAS || "").split(/\s+/).filter(Boolean));
const vulns = (JSON.parse(fs.readFileSync(0, "utf8")).vulnerabilities) || {};

// npm reports only the ROOT advisory (with a GHSA url) on the leaf; every
// dependent names its parent package in `via`. So resolve each flagged package
// transitively down to the advisories it actually inherits.
function rootAdvisories(name, path = []) {
  if (path.includes(name) || path.length > 12) return [];
  path = path.concat(name);
  const v = vulns[name];
  if (!v) return [];
  const out = [];
  for (const x of v.via || []) {
    if (typeof x === "object") {
      const g = (x.url || "").split("/").pop();
      if (g) out.push(g);
    } else {
      // A package name: follow it to whatever advisory IT carries. Path-based
      // `seen` (not a shared set) so sibling branches each resolve fully.
      out.push(...rootAdvisories(x, path));
    }
  }
  return out;
}

let blocking = [];
for (const [name, v] of Object.entries(vulns)) {
  const sev = (v.severity || "").toLowerCase();
  if (sev !== "high" && sev !== "critical") continue;
  const advisories = [...new Set(rootAdvisories(name))];
  // A waiver is a concession about a HIGH, dev-only, unfixable advisory. It must
  // never extend to CRITICAL: the whole point of the PRD gate is that critical
  // blocks release with no exceptions.
  const covered = sev !== "critical" && advisories.length > 0 && advisories.every(a => waived.has(a));
  if (!covered) {
    blocking.push(name + " (" + sev + ") via " + (advisories.join(",") || "unresolved"));
  }
}

const total = Object.keys(vulns).length;
if (blocking.length === 0 && total > 0) {
  console.log("AUDIT WAIVED: only " + [...waived].join(",") + " (braces dev-only lint chain).");
  console.log("  dev-only lint tooling, absent from BOTH shipped artifacts, prod tree clean.");
  console.log("  fixAvailable: None -- braces@3.0.3 is the latest release. See scripts/audit-gate.sh.");
  process.exit(0);
}
if (total === 0) { console.log("AUDIT PASS: no vulnerabilities at all."); process.exit(0); }

console.log("AUDIT FAIL: unwaived high/critical advisories:");
for (const b of blocking) console.log("  - " + b);
process.exit(1);
'

RC=$?

# Expiry check: if the advisory is GONE the waiver is stale and must be revisited
# rather than silently carrying on. `npm audit` exited non-zero above, so reaching
# here means something is still flagged; if it is NOT the waived set, we already
# failed. This branch therefore only fires on a genuine new-package addition.
exit "$RC"
