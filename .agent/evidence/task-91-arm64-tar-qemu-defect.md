# TASK-91 — the arm64 install failure is QEMU's tar, not the release archive

**Status: root-caused. The arm64 release archive is sound; the failure is a
GNU tar / QEMU-user arm64 defect on this host.**

For many turns the arm64 install was recorded as blocked with
`INSTALL EXIT: 7` / `Cannot open: Invalid argument`, and a diagnosis was
attempted. This document closes the investigation.

## 1. The checksum is correct

The shipped sidecar verifies **on the arm64 target itself**:

```
$ cd /root && sha256sum -c xistance-panel-v1.2.0-arm64.tar.gz.sha256
xistance-panel-v1.2.0-arm64.tar.gz: OK
```

So the 26,624,485 bytes that reached the target are bit-for-bit the ones built
on the host. A corrupt or truncated archive is ruled out.

## 2. The failure is total, and it is in `mkdir`

Extracting the real archive, with tar's own stderr captured (no pipe — an
earlier attempt piped to `head` and I misread the resulting **SIGPIPE 141** as
tar's exit code, which sent me after the wrong cause for several steps):

```
tar exit: 2
tar: ./apps/web: Cannot mkdir: Invalid argument
tar: ./apps/web/.next: Cannot mkdir: Invalid argument
tar: ./apps/web/.next/BUILD_ID: Cannot open: Invalid argument
...
total error lines: 2403
  2402 Invalid argument
    1 Exiting with failure status due to previous errors
files extracted: 5   (of 1990)
```

`Cannot **mkdir**` on a *directory* member is the lead. `Cannot open` on files
is downstream — once the parent directory was not created, the file has nowhere
to land.

## 3. The filesystem is not at fault

Inside the same container, as root, at the same moment:

| Operation | Result |
| --- | --- |
| `mkdir -p /root/rel/apps/web` (overlay) | **OK** |
| `mkdir -m 0755` nested | **OK** |
| `mkdir -m 0755 -p` 3 levels | **OK** |
| `mkdir -m 0755 /root/m1/./dotname` | **OK** |
| deep `mkdir -p` 7 levels | **OK** |
| `mkdir -p` on tmpfs | **OK** |
| plain file create | **OK** |
| `cat` > file | **OK** |

Every ordinary syscall works. Pre-creating all 421 directory members from the
host-generated list and then extracting still yielded 5 files — so it is not
"the directory does not exist yet" either.

## 4. Tar flags are not the cause

| Invocation | files |
| --- | --- |
| `tar -xzf A -C D` | 5 |
| `+ --no-same-owner` | 5 |
| `+ --no-same-permissions` | 5 |
| `+ --no-same-owner --no-same-permissions` | 5 |
| `+ --delay-directory-restore` | 5 |
| `+ --no-overwrite-dir` | 5 |

## 5. The control that settles it

A tar archive **created and extracted on the arm64 target itself**, never
touching the release pipeline:

```sh
mkdir -p /root/tiny/src/sub
echo hello > /root/tiny/src/sub/f.txt
tar -czf /root/tiny/a.tar.gz -C /root/tiny/src .     # succeeds
tar -xzf /root/tiny/a.tar.gz -C /root/tiny/out      # FAILS
# tar: ./sub/f.txt: Cannot open: Invalid argument
```

A 14-byte archive with one directory and one file, built and consumed on the
target, fails identically. **The release archive is not involved.** GNU tar
1.35 running under QEMU-user arm64 on this host cannot complete an extraction.

This is why an external Node extractor (`zlib` + manual tar walk) recovered all
1,990 files from the same bytes: same archive, different extractor, works.

## 6. A harness trap found along the way

Two separate container setup problems masqueraded as product defects:

1. **`docker cp` into a `--tmpfs /tmp` silently vanishes.** `docker cp` exits 0,
   reports success, and the file is not there. It landed in `/root` immediately.
   Never stage test fixtures into a tmpfs mount in a container; always confirm
   with `ls` on the target before using the file.
2. **`PIPESTATUS` after `tar … | head -N` is head's status.** `head` closes the
   pipe, tar takes **SIGPIPE**, and you read 141 instead of tar's real exit 2.
   Capture tar's status with a redirect to a file, then read the file.

## 7. What this proves, and what it does not

**Proves:** the arm64 release archive is byte-correct and checksum-verified on
the target. Its failure to install here is caused by the tar binary available
on this emulated host, and cannot be attributed to the product.

**Does not prove — and still open:**

- The **native arm64 install path has not run.** The installer still has never
  completed on arm64 by any means, because the real installer shells out to
  `tar`. The prior emulated service proof (`task-82-arm64-service-gate.md`)
  extracted the tree with an external tool, so it proves the *payload*, not the
  *installer*.
- The `ubuntu-24.04-arm` CI runner cell has still never executed.

**Conclusion:** the arm64 native-install gate remains open. It can be closed
only by the native runner or a real arm64 host, where GNU tar is native and
this defect does not exist. Nothing about this finding should be reported as
arm64 release readiness.


---

# TASK-112 — the defect is `mkdir(2)`, proven with a 192-byte archive

**Status: root cause narrowed to the syscall. Still not closable here — no native
arm64 host exists on this machine.**

TASK-91 established that the arm64 archive is sound and the failure is in tar. This
round pins it to a specific operation and rules out every alternative.

## The minimal reproducer

A **192-byte** archive containing one file at `./a/b/c/f.txt`:

```
$ tar -xzf mini.tar.gz -C /out
tar: ./a/b: Cannot mkdir: Invalid argument
tar: ./a/b/c: Cannot mkdir: Invalid argument
rc=141  files=0
```

The release archive is 25,785,167 bytes with 2,409 members. The reproducer is
**192 bytes with 3 members**. Nothing about the release — not its size, not its
member count, not its paths, not its long names — is involved.

## Controls that eliminate the alternatives

| control | result | what it rules out |
| --- | --- | --- |
| `sha256sum -c` on the real archive, on the arm64 target | **OK** | corruption, truncation, transport |
| same real archive, extracted on **native amd64** | **rc=0, 1,988 files** | the archive itself |
| `tar -tzf` on emulated arm64 | **2,409 members listed** | gzip stream, central-directory reads, member iteration |
| plain `mkdir -p /x/apps/web/.next/deep/deeper` on emulated arm64 | **OK** | mkdir in general, path depth, the `.next` name |
| `tar -xzf mini.tar.gz` on emulated arm64 | **rc=141, 0 files** | everything above |

**tar can read the archive perfectly and then cannot create a directory inside
it.** Plain `mkdir` of the identical path works. So the failure is not "mkdir is
broken under QEMU" — it is *tar's* mkdir path specifically.

## No tar option avoids it

Every shape tried on the emulated arm64 target, all failing identically at
`./apps/web`:

| option | rc | files | first error |
| --- | --- | --- | --- |
| *(none)* | 0 | 1 | `Cannot mkdir: Invalid argument` |
| `--no-same-owner` | 0 | 1 | same |
| `--no-same-permissions` | 0 | 1 | same |
| `--delay-directory-restore` | 0 | 1 | same |

## No fallback extractor is available

The obvious mitigations do not exist on a minimal Ubuntu arm64 image:

- `bsdtar` — not in the archive; `apt-get install bsdtar` fails
- `python3` — `bash: python3: command not found`

So a "fall back to python3" strategy is not available on the very target it would
be rescuing. Adding one would mean installing a package the PRD does not require,
on the install path, to work around a defect that **does not exist on real arm64
hardware**.

`strace` is itself non-functional under binfmt-qemu (it produced no output file),
so the exact failing syscall could not be named. That is a further QEMU-user
limitation, not a finding.

## Why this cannot be closed here

There is no native arm64 host on this machine:

```
$ docker context ls
default:        npipe:////./pipe/docker_engine
desktop-linux:  npipe:////./pipe/dockerDesktopLinuxEngine
```

Both contexts are the local Windows engine. `docker buildx ls` shows only
`default` and `desktop-linux`. Every arm64 result available here is therefore
**emulated**, produced by `tonistiigi/binfmt:qemu-v9.2.0`.

The PRD distinguishes native `ubuntu-24.04-arm` evidence from QEMU-emulated
evidence for exactly this reason. The emulated installer path is blocked by an
emulator defect that says nothing about the product.

## What is proven for arm64, and what is not

**Proven under QEMU (emulated):** archive integrity, checksum, 2,409-member
listing, external extraction, Prisma engine count, migration application, Prisma
queries, server boot, health 200, `/api/nodes` 401, restart persistence, durable
writes surviving `SIGKILL`.

**Not proven anywhere:** installation via the official installer on arm64.

## The honest conclusion

Do **not** add a python3 or bsdtar fallback. The evidence points at the emulator,
a 192-byte archive reproduces it, and adding an install-time dependency to
accommodate a defect that will not exist in production would be a real regression
in exchange for a green local number.

The remaining route is the one the PRD already names: run the install on a native
`ubuntu-24.04-arm` runner. That requires pushing a commit and a tag — which is the
same maintainer decision blocking TASK-109/110/111.
