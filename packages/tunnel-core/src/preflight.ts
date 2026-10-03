/**
 * Binary preflight (TASK-28).
 *
 * The previous check was `[ -e '<path>' ] && echo OK || echo MISSING`, which
 * tests EXISTENCE only. A binary that is present but not executable -- a
 * download that lost its +x bit, a `noexec` mount, a 0644 file from a partial
 * install -- passed preflight and then failed at exec with a bare
 * "permission denied" from the child process, which the panel could not
 * explain and which produced no actionable message.
 *
 * These helpers distinguish the four outcomes and give each one a fix. They are
 * extracted rather than inlined so the shell predicate and its classifier can
 * be tested independently of a live node.
 *
 * The absolute path is interpolated into a `bash -c` string, so it is
 * single-quote escaped here. A binary name is not attacker-controlled today, but
 * the path can contain spaces, and an unescaped quote would let it break out of
 * the script.
 */

export type PreflightOutcome = "ok" | "missing" | "not_executable" | "not_a_file";

/** POSIX single-quote escaping: close, escaped quote, reopen. */
export function shQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

/**
 * Build the one-round-trip shell probe for a node's binaries.
 *
 * One `bash -c` per node rather than one session per binary: on a remote node
 * each session is a full SSH round-trip, and a GOST tunnel needs only one.
 */
export function buildPreflightScript(bins: Array<{ bin: string; abs: string }>): string {
  return bins
    .map(({ bin, abs }) => {
      const p = shQuote(abs);
      // Order matters: a directory is reported as NOTFILE rather than NOTEXEC,
      // because "chmod +x" on a directory does not fix it.
      return (
        `if [ ! -e ${p} ]; then echo "MISSING ${bin}"; ` +
        `elif [ ! -f ${p} ]; then echo "NOTFILE ${bin}"; ` +
        `elif [ ! -x ${p} ]; then echo "NOTEXEC ${bin}"; ` +
        `else echo "OK ${bin}"; fi`
      );
    })
    .join("; ");
}

/** Map one line of preflight output to its outcome. */
export function classifyPreflightLine(line: string): PreflightOutcome | null {
  const s = line.trim();
  if (s.startsWith("OK ")) return "ok";
  if (s.startsWith("MISSING ")) return "missing";
  if (s.startsWith("NOTEXEC ")) return "not_executable";
  if (s.startsWith("NOTFILE ")) return "not_a_file";
  return null;
}

/** The binary name from a classified line, or null. */
export function preflightBin(line: string): string | null {
  const s = line.trim();
  const m = /^(OK|MISSING|NOTEXEC|NOTFILE) (.+)$/.exec(s);
  return m ? m[2].trim() : null;
}

/**
 * The actionable message for a failed preflight.
 *
 * Every branch names the absolute path AND the specific command that fixes it,
 * because the operator's next step differs per cause and a generic "install
 * failed" sends them guessing.
 */
export function preflightError(
  outcome: Exclude<PreflightOutcome, "ok">,
  bin: string,
  abs: string,
  nodeName: string,
): Error {
  switch (outcome) {
    case "not_executable":
      return new Error(
        `Required binary "${bin}" is present at ${abs} on ${nodeName} but is not executable. ` +
          `Run: chmod +x ${abs}  (or re-run scripts/install.sh).`,
      );
    case "not_a_file":
      return new Error(
        `Required binary "${bin}" at ${abs} on ${nodeName} is not a regular file ` +
          `(a directory or a device?). Run scripts/install.sh to reinstall it.`,
      );
    default:
      return new Error(
        `Required binary "${bin}" is missing on ${nodeName} (${abs}). ` +
          `Run scripts/install.sh (or: xistance install --bin ${bin}) on the node to install it.`,
      );
  }
}
