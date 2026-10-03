# Three real rollback defects, all found only by installing the archive on the target OS

Date: 2026-09-30
Target: **Ubuntu 22.04.5 LTS, amd64, systemd PID 1** — privileged Docker container
from image `xt-target:22.04`. Exact-OS container evidence, **not** remote-VPS
evidence. All host/user/port/key values are throwaway probe values; all such
values are `[REDACTED]`.

Task: TASK-64 (update / rollback) and TASK-62 (install).

---

## How this surfaced

Rebuilding the release archive and installing **that exact archive** on a clean
22.04.5 target exposed a cluster of defects that the 50-assertion installer
suite had reported as passing the whole time. The suite asserted that the
installer *mentioned* `xt_install_rollback_command`. It never checked that the
function was reachable, that its inputs existed, or that the resulting command
ran.

All three were found by running the artifact end to end, in sequence:

| # | defect | symptom on a real host | installer said |
|---|---|---|---|
| 1 | function **defined after** its call site, inside an unclosed `if` | `xt_install_rollback_command: command not found` | exit 0, "healthy" |
| 2 | wrapper sourced `$WORK_DIR/lib/release-layout.sh`; installer stages it at `$WORK_DIR/release-layout.sh` | `[[ -r ]]` fails → `return 1` → never installed | exit 0, "healthy" |
| 3 | wrapper sourced the **installer temp dir**, which is `rm -rf`'d on exit | installs fine, then **every rollback fails** with `No such file or directory` | exit 0, "Roll back with: xt-rollback" |

Defects 1 and 2 meant the command was never created. Defect 3 is the more
insidious one: the command *was* installed, so every check that asked "does
`/usr/local/bin/xt-rollback` exist" passed, while the only thing an operator
actually does with it — run it, during a bad upgrade — failed every time.

## The fixes

- `xt_install_rollback_command()` moved above its call site, at top level.
- It resolves the library from the path the installer really writes, with a
  `lib/` fallback.
- It installs a **private copy** of the library beside the generated command
  (`/usr/local/bin/xt-rollback.lib`) and the command sources that. The command
  is now self-contained and survives the installer finishing.
- The install path is overridable via `XT_ROLLBACK_COMMAND_PATH` so the suite can
  exercise the real function without root.

## Test repair: greps that could not fail

The existing assertion was `grep -q "xt_install_rollback_command" release-install.sh`
— satisfied by the *call* alone, and by a file merely mentioning the name. It
passed against all three defects.

Replaced with assertions that can fail:

1. **Ordering** — the definition's line number must precede the call's.
2. **Behavioural path resolution** — the real function is extracted, run against a
   temp `WORK_DIR` laid out the way the installer lays it out, and must produce a
   command. A grep passes on a file containing *both* paths; the defect is which
   one is *used*.
3. **Survives the installer exit** — read the generated command's library
   reference, delete `WORK_DIR`, then require the reference to still resolve.

Two of these were themselves wrong before they were right:

- The first version of #2 was a **string grep** for `WORK_DIR}/release-layout.sh`
  and the wrong-path mutant **survived** it, because the fixed file contains that
  string in a comment as well as in code. It had to become behavioural.
- The first version of #3 checked the library *after* deleting the temp dir, so
  it failed on the genuine fix, and its test layout put the "installed" command
  inside `WORK_DIR` — which production never does (`/usr/local/bin` is outside
  it). Corrected to a faithful two-directory layout.

## Verification on Ubuntu 22.04.5 amd64

Suite: **50 passed, 0 failed** (was 47). Three mutants, each reproducing one
shipped defect, all **killed**:

| mutation | result |
|---|---|
| wrong `lib/` path | **killed** |
| definition moved after the call | **killed** |
| wrapper sourcing the installer temp dir | **killed** |

End-to-end on the target OS, with two genuine releases built from staged
payloads:

```
1. install v1.1.9              -> exit 0, healthy, current -> v1.1.9
2. upgrade to v1.2.0           -> exit 0, healthy, current -> v1.2.0
                                 process cwd /opt/xistance/releases/v1.2.0/apps/web
                                 "Previous release retained: /opt/xistance/releases/v1.1.9"
3. installer temp dir          -> GONE
4. xt-rollback /opt/xistance/releases/v1.1.9
      -> "rolled back to /opt/xistance/releases/v1.1.9 and restarted xistance.service"
      -> exit 0
      -> current ->  v1.1.9
      -> process cwd /opt/xistance/releases/v1.1.9/apps/web   <-- serves the OLD code
      -> service active, health ok
5. xt-rollback /opt/xistance/releases/v1.2.0   (repeatable, opposite direction)
      -> current -> v1.2.0, process cwd v1.2.0
```

Step 4's **process cwd** is the assertion that matters. Pointer movement alone
was the original defect: the symlink said `v1.1.9` while the old process kept
serving `v1.2.0` from its own cwd, and health still reported healthy. The
served-code check is the only one that distinguishes a real rollback from a
cosmetic one.

## Negative controls

- Corrupt archive + correct sidecar → `sha256sum` mismatch, WARNING, install
  refused before extraction.
- Both v1.1.9 and v1.2.0 archives verified `OK` against their sidecars inside the
  container before either was installed.

## Scope

Container evidence on the exact release OS, not a remote VPS. The rollback
command is installed at `/usr/local/bin/xt-rollback` and works as both READMEs
document (`sudo xt-rollback <release-dir>`); Persian parity suite 66/66
independently requires the same command name.
