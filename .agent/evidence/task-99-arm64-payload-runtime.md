# TASK-99 — the current arm64 payload boots, serves, and persists a real write

**Status: the current arm64 archive is proven end to end on an emulated arm64
target, up to and including a durable write across a SIGKILL.**

This closes the two arm64 facts that were outstanding after TASK-96/98. It does
**not** close the native-installer gate — see §5.

## 1. The archive extracts correctly

Extracted with the external notar extractor, because GNU tar under QEMU-user
arm64 cannot complete an extraction (TASK-91, root-caused with a 14-byte control
archive and Node's own official arm64 tarball failing identically):

```
extracted 1988 files, 420 directories, 62 long-name entries
  files extracted : 1988
  arm64 engines   : 1   (libquery_engine-linux-arm64-openssl-3.0.x.so.node)
```

The archive is the **current** one, SHA-256 `0b56ac6a6e3a82fc…`, 25,785,167
bytes, with the TASK-96 payload digest embedded and verified against the
extracted tree.

## 2. Migrations as the unprivileged service user

```
applied 20260823214332_init
migrations up to date (1 applied, 1 total)
  db owner: xistance  size: 172032
```

## 3. A real Prisma query on arm64

Not just "the schema is present" — a live query through the generated client and
the arm64 engine:

```
TABLES=11 APPLIED=1 ROLLEDBACK=0
USER_COUNT=0
```

## 4. The server boots and serves

```
Next.js 16.3.6
  health : HTTP 200
  nodes  : HTTP 401   (unauthenticated, correctly refused)
  login  : HTTP 400   (unauthenticated POST, correctly rejected)
  db owner: xistance
```

## 5. Persistence: a real write, across a hard kill

A health endpoint says the process is up. It does not say the **data** is
durable. So a row was written through the arm64 Prisma client as the
unprivileged `xistance` user, the server was `SIGKILL`ed (not shut down
gracefully), restarted, and the row read back:

```
1. WRITE   WROTE=1e2377cf-c536-4a3e-9220-0c248942ebba BEFORE=0 AFTER=1
2. SIGKILL health after kill: down
3. RESTART health after restart: 200
           NODES=1
           NODE=1e2377cf-c536-4a3e-9220-0c248942ebba:arm64-persist-…:203.0.113.9
           db owner: xistance  size: 172032
```

Same UUID before and after. The database is owned by the unprivileged service
user, so the service can write without root — the TASK-33 property holding on
arm64 with the current payload.

## A probe error worth recording

The first write attempt failed with `PrismaClientValidationError`. The cause was
mine: I used `port` and `username`, and the `Node` model's fields are `sshPort`
and `sshUser`. Prisma rejected the row correctly. Worth stating plainly because
a validation error in a persistence probe reads like a product defect until you
check the schema — the correct response to an unexpected validation error is to
read the model, not to loosen the assertion.

## 5. What this does NOT prove

The **native arm64 install path is still unexecuted.** The installer shells out
to `tar`, and this host's arm64 `tar` is broken under QEMU, so the installer
cannot complete here regardless of the payload being correct. Everything above
was extracted by an external tool, which proves the *payload* and not the
*installer*.

Still open, unchanged:

1. native arm64 install (needs a real arm64 host or the `ubuntu-24.04-arm`
   runner);
2. the `ubuntu-24.04-arm` CI release cell;
3. approval-gated operations: distinct-host `REVERSE` and the live
   password-reset command.

The emulated evidence above is deliberately labelled emulated. It is strong
evidence about the payload and weak evidence about the installer, and the
distinction is the whole point.

## 6. The failed arm64 install leaves no partial candidate

The other outstanding arm64 question: after the installer exits non-zero on the
emulated target, is anything left behind that could later be mistaken for a
valid release?

Re-ran the real installer against the current arm64 archive on the emulated
target, with the release directory listing captured before and after:

```
BEFORE: /opt/xistance/releases/v1.2.0          (the hand-extracted tree)
INSTALL EXIT: 6
AFTER : /opt/xistance/releases/v1.2.0
  dir count: 1
  current  : /opt/xistance/current
  unit     : absent -- install never reached activation
```

- **no new release directory** — the candidate is removed on the failure path
- **`current` was never repointed** at a partial tree
- **no systemd unit** — the installer never reached activation

The exit code was 6 rather than the earlier 7 because this run failed one stage
earlier (the manifest lift also goes through `tar`), which is itself
informative: the installer aborts at the *first* tar-dependent stage, before
anything is written. The safety property does not depend on which stage fails.

Combined with TASK-92 (the same property proven on amd64 against a shimmed tar
that extracts 2 of 1990 files and exits non-zero), the refusal path is now
verified on both architectures, and the *reason* it fires on arm64 is a
documented host defect rather than a product one.
