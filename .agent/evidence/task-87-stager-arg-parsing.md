# TASK-87 — the release stager rejected valid invocations, and the error looked like a usage mistake

**Status: closed. One line of index arithmetic made the stager unusable for
every call that did not pass all three flags, while reporting a correct-looking
usage message.**

## How it surfaced

Rebuilding the amd64 artifact after the TASK-85 migration fix, a perfectly
ordinary invocation printed usage and exited 2:

```
$ npx tsx scripts/stage-release-artifact.ts <repo> <dest> --architecture amd64 --standalone <artifact>
Usage: stage-release-artifact.ts <repo-root> <destination> [--architecture amd64|arm64|native] [--standalone <dir>] [--prisma-client <dir>]
=== exit 2 ===
```

With `--prisma-client` added — the shape every existing caller used — it worked.

## The defect

```ts
const clientIndex = args.findIndex((arg) => arg === "--prisma-client");   // -1 when absent
const positional = args.filter(
  (arg, index) =>
    !arg.startsWith("--") &&
    index !== architectureIndex + 1 &&
    index !== standaloneIndex + 1 &&
    index !== clientIndex + 1,                                          // -1 + 1 === 0
);
const [repoRoot = process.cwd(), destination] = positional;
```

`findIndex` returns `-1` for an absent flag, and `-1 + 1` is `0`. The filter
therefore excluded **index 0 — the repo root** — whenever `--prisma-client` was
omitted. `positional` came back with one element, `destination` was `undefined`,
and the guard printed usage and set `exitCode = 2`.

Any single absent flag ate the first positional argument. Omitting
`--architecture` or `--standalone` alone did the same.

## Why the error message was actively misleading

The message names all three flags as if any subset were valid, and the docs
describe `[--prisma-client <dir>]` in brackets — optional. So the tool told the
caller the argument was optional, and then rejected the call for omitting it,
using a usage line that endorsed omitting it. Nothing pointed at the real cause.

## Why it survived

Every release call passes all three flags together, so the `-1` was never
exercised. `--prisma-client` was added for the arm64 provenance work (TASK-81);
before that there were only two flags, so the bug was introduced at the same time
as the third, and no caller had yet been written to the shorter form.

## The fix

Filter by the parsed value instead of by index arithmetic that is only meaningful
when the flag was actually seen:

```ts
const flagValues = new Set(
  [architectureIndex, standaloneIndex, clientIndex]
    .filter((index) => index !== -1)
    .map((index) => args[index + 1]),
);
const positional = args.filter((arg) => !arg.startsWith("--") && !flagValues.has(arg));
```

## The test

`scripts/test-stage-arg-parsing.ts` — 12 assertions through the real process
boundary, not by importing the parser. The module performs its work at import
time, so the only faithful check is what the binary does with a real argv.

- omitting each flag **individually** does not consume the repo root, and is not
  exit 2 (6 assertions — the defect's exact shape in all three positions)
- all three flags together are still accepted (the original working path, so the
  fix cannot over-correct)
- an unknown `--architecture` is **still** rejected and still exits 2
- a missing destination is still rejected

The last two matter: relaxing the filter could easily have turned the guard into
a no-op, and a stager that accepts `--architecture sparc` is worse than one that
refuses valid arguments.

## Mutation proof

Restoring the original index arithmetic:

```
--- 4 passed, 8 failed ---
=== exit 1 ===
```

All 8 defect-specific assertions died, while `all three flags together are still
accepted`, `an unknown --architecture is still rejected`, and `a missing
destination is still rejected` **kept passing** — the test discriminates the
defect from the surrounding behaviour rather than failing indiscriminately.

Source restored byte-identically (SHA-256 verified before and after).

```
--- 12 passed, 0 failed ---
```

## A second defect found while rebuilding: the archive contained itself

```
$ tar --force-local -czf dist/amd64/xistance-panel-v1.2.0-amd64.tar.gz -C dist/amd64 .
tar: .: file changed as we read it
  exit=1  size=40717461 bytes
```

Writing the archive *into the directory being archived* makes `tar` read its own
growing output. It exits 1, which is good — but the 40 MB file it leaves behind
is already the "successful" artifact size, so a build script that does not check
the exit code ships a truncated, self-referential tarball.

Fixed by archiving to a path outside the staged tree, then moving it in.

## The rebuilt artifact

```
dist/amd64/xistance-panel-v1.2.0-amd64.tar.gz     40,717,503 bytes
dist/amd64/xistance-panel-v1.2.0-amd64.tar.gz.sha256
  01a841663a8d391c9ca2a1b27bf5707b4512c39e85fe746fcbbaec5a8e086b1f

staged files      1989      extracted from archive  1988
archive vs staging differences: 0
foreign native binaries       : 0   (inspection PASS, 1990 files checked)
arm64 engines in amd64 archive: 0
release-manifest.json freshness: 4 passed, 0 failed
```

No credentials, tokens, private keys, or connection details appear in this file.
