# TASK-97 — the aggregate's WSL scratch root was a fixed name

**Status: fixed. Two overlapping runs can no longer collide.**

## The symptom

After killing a run mid-flight, the next aggregate reported:

```
FAIL test-release-payload-linux.sh
     cp: cannot create directory '/root/xt-gate/artifact/apps': File exists
```

That reads like a payload defect — a corrupt staged tree, a permissions
problem, a broken copy. None of those were true. The gate passes 23/23 when run
on its own against the same payload.

## The cause

`scripts/run-all-tests.ts` built the WSL scratch tree at a **fixed** path:

```ts
const wslScript = [
  "set -e",
  "H=$HOME/xt-gate",
  "rm -rf $H && mkdir -p $H",
  `cp -a ".../dist/artifact" $H/artifact`,
  ...
```

Two runs sharing `$HOME/xt-gate` interleave: the second one's `rm -rf` and
`mkdir` land while the first is still copying, and `cp -a src dst` then fails
because a partially-copied `dst` already exists. The `rm -rf` is correct; it just
has no way to know another run owns the directory.

The error is doubly misleading because it names a path that a reader will
attribute to the payload — `/root/xt-gate/artifact/apps` — when the fault is
entirely in the harness's choice of directory name.

## The fix

Key the scratch root to the process:

```ts
"H=$HOME/xt-gate-$$",
"rm -rf $H && mkdir -p $H",
"trap 'rm -rf $H' EXIT",
```

`$$` is the WSL shell's PID, so each invocation gets its own root and removes it
on exit. A killed run's leftovers are named differently and can never be
mistaken for a live run's tree.

## The lesson

**A fixed scratch path is a shared resource, and a `rm -rf` on it is a race.**
This is the same class as the two tar failures earlier in the session — read
past the symptom to the harness before attributing a failure to the product:

| symptom | real cause |
| --- | --- |
| `cp: cannot create directory ... File exists` | two runs sharing `$HOME/xt-gate` |
| `tar: Cannot mkdir: Invalid argument` | QEMU's tar, not the archive |
| `bind EACCES 0.0.0.0:<5xxxx>` | a Windows excluded port range, not load |

In each case the message pointed at the artifact and the fault was in the
tooling around it. When a failure names a path under a scratch or temp
directory, suspect the scratch directory first.
