# TASK-29 evidence — SSH lifecycle and option security

**Status:** passed

## The finding: remote code execution through the SSH username

`extraArgs` had a sound allowlist, but `username` and `host` were
`z.string().min(1)` — unvalidated. The destination reaches ssh as the argv
token `${username}@${host}`, and **ssh parses any leading-dash argv token as an
OPTION before it ever looks for a destination.**

A username of `-oProxyCommand=touch /tmp/pwned` produced:

```
argv tail: [ "-p", "22", "-oProxyCommand=touch /tmp/pwned@10.0.0.5" ]
LAST token: "-oProxyCommand=touch /tmp/pwned@10.0.0.5"
```

ssh reads that as `-o ProxyCommand=touch /tmp/pwned@10.0.0.5` — **arbitrary
command execution on the panel host.** It also bypassed the `extraArgs`
allowlist completely, because the payload never passed through `extraArgs`.
The allowlist was not the weak point; a sibling field was.

## The fix

`assertSafeSshDestination(username, host)` in `config/ssh.ts`, called by
`buildSshCommand` so a caller that bypasses the schema is still safe, plus
matching regexes on the schema:

```ts
const SSH_USERNAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,31}$/;
const SSH_HOST     = /^[A-Za-z0-9_][A-Za-z0-9.:_-]{0,252}$/;
```

Refused: a leading dash, every shell metacharacter, whitespace and control
characters, an embedded `@` (which makes the user/host split ambiguous), and
blank values. Kept: hostnames, IPv4/IPv6 literals, and ordinary POSIX
usernames. `buildSshCommand` and `buildAutosshCommand` both go through it, and
the errors name the offending field.

## Boundaries traced and confirmed safe

| Boundary | Finding |
| --- | --- |
| `spawn` / `execFile` in `runner.ts` | `spawn(argv[0], argv.slice(1))` — **no `shell: true` anywhere in the repo**. No shell interpolation of argv. |
| systemd `ExecStart` | `spec.command.map(shellQuote).join(" ")` — every token single-quote escaped. |
| systemd `Environment=` | `systemdQuote` strips CR/LF/NUL and escapes `\` and `"`. |
| systemd `Description=` | `sanitizeUnitText` collapses CR/LF to spaces, bounds to 200 chars. |
| unit file permissions | written `0o600` — it carries `SSHPASS` in `Environment=`. |
| passwords | via `SSHPASS` env / `sshpass -e`, never argv. Verified by test. |
| private keys | referenced by path with `-i`; a PEM body never enters argv. |

## The allowlist: verified rather than assumed

`filterExtraArgs` accepts only `["-o", "Key=Value"]` pairs with an allowlisted
key and a value matching `^[A-Za-z0-9._-]+$`. All 18 dangerous options tested
are dropped: ProxyCommand, ProxyJump, LocalCommand, PermitLocalCommand,
IdentityFile, IdentityAgent, ForwardAgent, ForwardX11, ControlPath,
ControlMaster, Match, Include, UserKnownHostsFile, PKCS11Provider,
SecurityKeyProvider, KnownHostsCommand, ProxyUseFdpass. All 6 safe options
survive, and 9 hostile values on *allowlisted* keys are dropped — the case a
key-only allowlist would miss.

`StrictHostKeyChecking` is allowlisted, so `no` passes the filter. That is
deliberate and safe: the base command sets `accept-new` **first**, and OpenSSH
takes the first obtained value, so the baseline cannot be weakened. The test
asserts that ordering rather than pretending the key is absent.

## Non-vacuity

| Mutation | Result |
| --- | --- |
| Remove the builder-side validation | **FAIL** 11 assertions |
| Relax the username regex to allow a leading dash | **FAIL** 3 assertions (after the fix below) |
| Remove the schema regexes | **FAIL** 1 assertion |
| Restored | 50/50 |

**Two of my own test defects were found and fixed, both of which had made the
suite green-but-empty:**

1. The dangerous-option list passed joined strings like `"-oProxyCommand=id"`.
   `filterExtraArgs` skips any token that is not literally `"-o"`, so all 18
   cases were dropped for the *wrong reason* and proved nothing about the
   allowlist. Now they are real `["-o", "Key=Value"]` pairs, and a **CONTROL**
   assertion proves an allowlisted key with a simple value survives — so the
   dangerous cases demonstrably fail on the key, not the value.
2. Relaxing the username regex still threw, because a separate
   `startsWith("-")` check caught it — so the regex's strictness was untested
   and the mutant passed. The test now calls the exported
   `assertSafeSshDestination` and asserts on the predicate across 24 hostile
   usernames, 17 hostile hosts, and 7 legitimate destinations.

That second fix immediately caught a **real over-tightening of my own**: I had
listed `a-b` as hostile, but it is a perfectly valid POSIX username. The regex
was right and the test was wrong.

## Not claimed

**No real SSH connection was made and no tunnel was established.** This is a
Windows host with no SSH target, and the VPS has no tunnel binaries installed.
The argv, validation, allowlist, redaction and systemd-rendering properties are
proven; an actual `ssh -N -L` session carrying traffic is not. That belongs with
the BACKHAUL/FRP/GOST items in the VPS acceptance pass.

## Verified

- `test-ssh.ts` — 50/50
- `test-gost.ts` — 37/37 · `test-frp.ts` — 28/28 · `test-backhaul.ts` — 39/39
- `test-forward-reconcile.ts` — 24/24 · `test-port-allocation.ts` — 27/27
- `test-bounded-caches.ts` — 29/29 · `test-diagnostics.ts` — 22/22
- `test-disposal-cleanup.ts` — 15/15 · `test-retry-bounds.ts` — 23/23
- `test-tunnel-lifecycle.ts` — 21/21
- `test-optimizations.ts` — 77/77 · `test-line-endings.sh` — 54/54
- `typecheck`, `lint` — pass

**30/73 tasks passed.**
