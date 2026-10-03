/**
 * Diagnostic: report absolute build-machine paths baked into Next server chunks.
 * Read-only. Usage: npx tsx scripts/inspect-build-paths.ts [dir]
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? "apps/web/.next/server");

const files: string[] = [];
function walk(dir: string): void {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.(?:js|mjs|cjs|json)$/.test(entry)) files.push(full);
  }
}
walk(root);

const patterns: Array<[string, RegExp]> = [
  ["windows-drive", /[A-Za-z]:(?:\\\\|\\){1,2}[^"'`\s]{4,120}/g],
  ["posix-build-dir", /\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+){2,}\/(?:packages|apps|tunnels)\/[A-Za-z0-9_./-]*/g],
];

const findings = new Map<string, Set<string>>();
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const [label, pattern] of patterns) {
    pattern.lastIndex = 0;
    const matches = text.match(pattern);
    if (!matches) continue;
    const key = path.relative(root, file);
    for (const match of matches) {
      if (!findings.has(key)) findings.set(key, new Set());
      findings.get(key)!.add(`${label}: ${match}`);
    }
  }
}

if (findings.size === 0) {
  console.log("No absolute build-machine paths found.");
} else {
  let total = 0;
  for (const [file, values] of findings) {
    console.log(`\n${file}`);
    for (const value of values) {
      total += 1;
      console.log(`  ${value}`);
    }
  }
  console.log(`\nFiles with absolute paths: ${findings.size}; distinct values: ${total}`);
}
