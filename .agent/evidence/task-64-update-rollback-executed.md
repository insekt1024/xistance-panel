# TASK-64: the documented rollback command did not exist

Executing the update/rollback cycle on real Ubuntu 22.04.5 amd64 found two
defects in the recovery path. Both would hit an operator at the worst possible
moment — during a bad upgrade.

## Defect 1 — the documented rollback command was a shell function

`release-install.sh:641` printed, on every successful install:

```
   Roll back with: xt_activate_release /opt/xistance/releases/v1.1.2
```

and both READMEs told operators the same thing:

```
README.md:165     sudo xt_activate_release /opt/xistance/releases/<previous-tag>
README_FA.md:141  sudo xt_activate_release /opt/xistance/releases/<تگ-قبلی>
```

But `xt_activate_release` is a **shell function defined in
`scripts/lib/release-layout.sh:134`**, which the installer *sources*. Nothing
installs it into `PATH`. On the target:

```
$ sudo xt_activate_release /opt/xistance/releases/v1.1.2
bash: xt_activate_release: command not found
$ find / -name xt_activate_release -not -path "/proc/*"
(no results)
```

**The documented recovery path for a failed upgrade did not work at all.** Not
in a corner case — on every install, for every user.

The misleading part is `release-layout.sh:133`, a usage comment that reads like
a command:

```sh
# Usage: xt_activate_release /opt/xistance/releases/v1.2.0
xt_activate_release() {
```

Inside the sourced library that comment is harmless. The installer then copied
the *function's* name into a *user-facing* instruction, and nothing carried the
function across that boundary.

## Defect 2 — even when called correctly, rollback did not take effect

Sourcing the library and calling the function directly worked — the pointer
moved:

```
xt_current_release before: /opt/xistance/releases/v1.2.0-20260930055746
xt_activate_release /opt/xistance/releases/v1.1.2   -> exit 0
xt_current_release after : /opt/xistance/releases/v1.1.2
```

But the panel kept serving the old release:

```
active      : /opt/xistance/releases/v1.1.2          <- pointer says 1.1.2
process cwd : /opt/xistance/releases/v1.2.0-20260930055746/apps/web
health      : {"ok":true,"version":"1.2.0",...}       <- still 1.2.0
```

Only `systemctl restart xistance.service` made it real. Cause:
`xt_activate_release` contains **no `systemctl` call at all** — it writes the
pointer file, moves the symlink, and writes the manifest. The installer
restarts the service *separately*, after it, so any other caller (an operator
following the README) silently gets a rollback that changes nothing while the
panel keeps reporting the new version.

This is the worse of the two: a rollback that reports success and does nothing
is more dangerous than one that errors.

## The fix

**`xt_rollback` in `scripts/lib/release-layout.sh`** — does what the message
promised: activate, **restart the unit**, and fail loudly if it could not.

```sh
xt_activate_release "$release_dir" || return 1
...
if ! systemctl restart "$unit"; then
  printf 'failed to restart %s; the pointer moved but the old process is still running.\n' "$unit" >&2
  return 1
fi
```

It resolves the unit name rather than hardcoding it, and treats "no running
xistance unit" as a failure, because that is precisely the case where a
successful-looking rollback would be a lie.

**`xt_install_rollback_command` in `release-install.sh`** — generates
`/usr/local/bin/xt-rollback` during install, sourcing the library and calling
the wrapper. The documented command now exists.

**Both READMEs** and the installer's own success message now name
`xt-rollback`.

## Proven on the target

```
$ xt-rollback /opt/xistance/releases/v1.2.0-20260930055746
rolled back to .../v1.2.0-20260930055746 and restarted xistance.service
  health: {"ok":true,"version":"1.2.0",...}

$ xt-rollback /opt/xistance/releases/v1.1.2
rolled back to .../v1.1.2 and restarted xistance.service
  active      : /opt/xistance/releases/v1.1.2
  process cwd : /opt/xistance/releases/v1.1.2/apps/web    <- process actually moved
  health      : {"ok":true,"version":"1.1.2",...}        <- version actually reverted
```

Pointer, process, and reported version now agree. Before the fix, only the
pointer moved.

## The assertions, and proof they bite

Six new checks in `scripts/test-release-installer.sh` (47/47 pass). They cover
the *class*, not just the instance: no user-facing document may name a sourced
shell function, the installer must install the command, its own hint must name
it, and the wrapper must restart the service.

| mutant | result |
|---|---|
| README reverted to `xt_activate_release` | **exit 1** — 2 failures, incl. *"does not instruct users to run a sourced shell function"* |
| `systemctl restart` removed from the wrapper | **exit 1** — *"the rollback wrapper restarts the service"* |
| installer's hint reverted to the function | **exit 1** — *"the installer's own rollback hint names the installed command"* |
| restored | 47/47 |

## The lesson

**Static tests could not have found this.** Every test in the suite read
`release-install.sh` as text and saw `xt_activate_release` called at L590, with
`lib/release-layout.sh` sourced — a coherent, correct-looking install path. The
defect lived in the gap between *what the installer does internally* and *what
it tells the operator to type*. No amount of reading the source finds that; only
executing the documented command on a real host does.

The whole reason this surfaced is that TASK-64 was executed rather than
declared blocked. A rollback bug in a release that had been "verified" by
static tests alone would have shipped.

## The forced-failure step, done three times

The first attempt was **defeated by an unrelated guard** and proved nothing:

```
$ release-install.sh --version v1.9.9-bad --archive <corrupted>
EXIT=2
  ✗ Invalid version 'v1.9.9-bad'. Expected an explicit semver tag such as v1.2.0.
```

Version validation fired before the checksum was ever reached. A correct
refusal for the wrong reason is still a proof of nothing.

Second attempt, valid tag, corrupted archive:

```
EXIT=6
  ✗ The artifact does not contain release-manifest.json.
  active AFTER : /opt/xistance/releases/v1.1.2    (unchanged)
  health       : 200 / version 1.1.2
```

Refused, live install untouched — but caught by the *manifest* check, not the
digest.

Third attempt, corrupt **only** the sidecar, archive byte-identical:

```
EXIT=6
  ✗ Checksum verification FAILED for xistance-panel-v1.2.2-amd64.tar.gz.
    The download does not match the published digest. Not extracting.
  active AFTER : /opt/xistance/releases/v1.1.2    (unchanged)
```

That is the real digest gate refusing, with the live install intact.

### And the negative control, which caught a test error of mine

A tampered sidecar must fail *and* a good one must succeed, or the gate proves
nothing. My first control **failed for my own mistake**: I copied the v1.2.0
archive to `ok.tar.gz` beside its v1.2.0 sidecar, then installed with
`--version v1.2.2`. The installer renames the archive to
`xistance-panel-v1.2.2-amd64.tar.gz` while the sidecar still names
`xistance-panel-v1.2.0-amd64.tar.gz`, so `sha256sum --check` could not find the
file it was told to check:

```
sha256sum: xistance-panel-v1.2.0-amd64.tar.gz: No such file or directory
```

That is a **test-setup error, not a product defect**: the real
`--archive` path always pairs a version with its own archive name. Redone
correctly:

```
$ release-install.sh --version v1.1.2 --archive /tmp/ctl2/xistance-panel-v1.1.2-amd64.tar.gz
EXIT=0
  ✓ Manifest taken from the artifact.
  ✓ Checksum verified (sha256sum).
  ✓ Database schema is up to date.
  ✓ Systemd unit installed for xistance.
  ✓ Xistance Panel v1.1.2 is installed and healthy on port 8080.
```

Both directions proven on the target: tampered sidecar refused with the live
install untouched, good sidecar accepted. The checksum gate is non-vacuous.
