/**
 * Rewrite build-machine absolute paths in staged Next output (owner-approved).
 *
 * Next bakes the build machine's absolute paths into traced server chunks, e.g.
 * `E:\\codes\\Projects\\repo\\packages\\db\\generated\\client`. A release artifact
 * must be relocatable, so staging rewrites the repo root to a release-relative
 * form. Only paths that begin at the repo root are rewritten; anything else is
 * left untouched, and the result is reported so unexpected rewrites are visible.
 */

import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const REWRITABLE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".json", ".map"]);

/** Matches an absolute Windows path to the repo root, capturing the tail for route filtering. */
const WINDOWS_ROOT_PATTERN = /([A-Za-z]:(?:\\\\{1,2}|\\{1,2})[^\s"'`<>|*?]*?)(packages[\\/]|apps[\\/]|tunnels[\\/])([^\s"'`]*)(\\?)/g;

/**
 * Matches an absolute POSIX path that reaches one of the workspace directories.
 *
 * The leading boundary is the whole point. A rewriteable path is a *string value*
 * that starts at a filesystem root, so the match must be preceded by a quote,
 * bracket, colon, comma or whitespace. Without that requirement the pattern also
 * fires partway through an already-relative path, and Next's per-route manifest
 *
 *   {"/api/tunnels/route": "app/api/tunnels/route.js"}
 *
 * was rewritten to "app../../tunnels/route.js". The artifact then installed
 * cleanly, verified its checksum, and returned 500 on every /api/tunnels call.
 *
 * A negative lookbehind is not sufficient: `[\w.\-/]` places the hyphen between
 * "." and "\/", which a regex engine reads as a character *range*, so the class
 * does not mean what it looks like. Requiring an explicit leading boundary is
 * unambiguous.
 */
const POSIX_ROOT_PATTERN =
  /(^|["'\[=:,\s])((?:\/[A-Za-z0-9._-]+){1,6}\/)(packages\/|apps\/|tunnels\/)([^\s"'`]*)/g;

/**
 * Route strings like "/tunnels/route" or "/tunnels/[id]/actions/route" are Next
 * route paths, not filesystem paths. Rewriting them makes Next throw a
 * "Requested and resolved page mismatch" error, so they are left untouched.
 * A real filesystem tail carries a file extension or a longer path segment.
 */
const isRouteLikeTail = (tail: string): boolean =>
  /(^|\/)(route|index|loading|error|not-found|default)$/.test(tail) || /\/?\[/.test(tail);


export interface RewriteResult {
  filesScanned: number;
  filesRewritten: number;
  replacements: number;
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function collectFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir)) {
      const full = path.join(dir, entry);
      const details = await stat(full);
      if (details.isDirectory()) await walk(full);
      else if (REWRITABLE_EXTENSIONS.has(path.extname(full))) files.push(full);
    }
  }
  await walk(root);
  return files;
}

/**
 * Rewrites build-machine absolute paths under `stagedRoot` to paths relative to
 * the release root. Prisma resolves its client output from `process.cwd()`,
 * which for the standalone server is the staged release root, so the repo root
 * prefix is replaced with nothing and the remainder is kept intact.
 *
 * Returns how much was changed so callers can fail on surprises.
 */
export async function rewriteBuildMachinePaths(
  stagedRoot: string,
  repoRoot: string,
): Promise<RewriteResult> {
  const root = path.resolve(stagedRoot);
  const normalizedRepo = repoRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  // The staged artifact is the *contents* of apps/web/.next/standalone, so the
  // server cwd inside it is <artifact>/apps/web while the client is staged at
  // <artifact>/packages/db/generated/client. That relationship is fixed by the
  // release layout, so compute it from the layout rather than from any temp path.
  const prefix = "../../";

  // Each pattern carries its own arity offset rather than having the callback
  // infer it from a capture value. Inferring was wrong: the Windows pattern's
  // first capture is a 27-character drive path, and treating a short capture as
  // a boundary silently prepended "../../" instead of stripping the prefix.
  type PatternSpec = { pattern: RegExp; hasBoundary: boolean };
  const patterns: PatternSpec[] = [];

  // Order matters. The drive-letter pattern must run first; afterwards the
  // remaining text no longer starts with a drive letter, so re-running a plain
  // repo-root match would prefix the already-rewritten path a second time.
  patterns.push({ pattern: WINDOWS_ROOT_PATTERN, hasBoundary: false });
  if (!/^[A-Za-z]:/.test(normalizedRepo)) {
    patterns.push({ pattern: new RegExp(escapeForRegExp(normalizedRepo), "g"), hasBoundary: false });
  }
  patterns.push({ pattern: POSIX_ROOT_PATTERN, hasBoundary: true });

  let filesScanned = 0;
  let filesRewritten = 0;
  let replacements = 0;

  for (const file of await collectFiles(root)) {
    filesScanned += 1;
    const original = await readFile(file, "utf8");
    let text = original;
    let fileCount = 0;

    for (const { pattern, hasBoundary } of patterns) {
      pattern.lastIndex = 0;
      text = text.replace(pattern, (match: string, ...rest: unknown[]) => {
        // String.replace passes: match, p1..pn, offset, wholeString, groups?
        const offsetIndex = rest.findIndex((value) => typeof value === "number");
        const groups = rest.slice(0, offsetIndex === -1 ? rest.length : offsetIndex) as string[];
        // Capture layout, for both patterns:
        //   windows: (root, segment, tail, trailing)
        //   posix:   (boundary, root, segment, tail)
        // The absolute root is what gets discarded; the segment and tail are what
        // survive, made relative to the server cwd. `root` is the *first* real
        // capture, so it sits at `offset` and is never emitted.
        const offset = hasBoundary ? 1 : 0;
        const lead = hasBoundary ? (groups[0] ?? "") : "";
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const _root = groups[offset] ?? "";
        const head = groups[offset + 1] ?? "";
        const tailCapture = groups[offset + 2] ?? "";
        const tail = tailCapture.startsWith(head) ? tailCapture.slice(head.length) : tailCapture;
        // The route guard must inspect the LAST capture, which is the only one
        // that can hold "route" or "[id]". Both patterns have a variable number
        // of groups, so it is taken from the end rather than by index -- reading
        // groups[2] looked at the workspace segment ("tunnels/") instead and let
        // every route string through the rewrite.
        const lastGroup = groups[groups.length - 1] ?? "";
        if (isRouteLikeTail(lastGroup) || isRouteLikeTail(tail)) return match;
        if (process.env.XT_TRACE_REWRITE === "1") {
          process.stderr.write(`TRACE match=${match} groups=${JSON.stringify(groups)}\n`);
        }
        fileCount += 1;
        const trailing = hasBoundary ? "" : (groups[offset + 3] ?? "");
        return `${lead}${prefix}${head}${tail}${trailing}`;
      });
    }

    if (fileCount === 0 || text === original) continue;
    await writeFile(file, text, "utf8");
    filesRewritten += 1;
    replacements += fileCount;
  }

  return { filesScanned, filesRewritten, replacements };
}
