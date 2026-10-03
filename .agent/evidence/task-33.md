# TASK-33 evidence — XRAY method coverage

**Status:** passed

## The finding: no tunnel config was ever written atomically

This is a cross-method defect that XRAY made visible. Both runners truncate the
destination and then write into it:

```ts
// LocalRunner — O_TRUNC, then write
await fs.writeFile(p, content, mode ? { mode } : undefined);

// RemoteRunner — shell redirect, truncates in place
const script = `echo ${b64} | base64 -d > ${target}`;
```

A process that starts, or re-reads its config, during that window sees a
truncated JSON document. For a tunnel binary that parses its config at startup
that is a crash loop; worse, a config that still parses but has lost its
`outbounds` sends traffic straight out via freedom.

Not XRAY-specific: every method that writes a config file (BACKHAUL, FRP, GOST,
XRAY, SSH unit files) was affected. Fixed at the runner level, so all of them
benefit.

| Runner | Before | After |
|---|---|---|
| Local | `fs.writeFile` in place | write sibling `.tmp`, then `rename` over the target |
| Remote | `> target` | decode into `.tmp`, `chmod`, then `mv -f` into place |

The temp file is a **sibling in the same directory** — a temp file in
`os.tmpdir()` could cross a mount point and make the rename non-atomic. On
Windows `rename` will not clobber, so there is a documented unlink-and-retry
path, and the comment says so rather than pretending the guarantee is uniform.

A failed write now leaves the previous config intact and cleans up its temp
file. Before, a failure partway through left a truncated file where a working
config had been.

## Other defects

**1. `uuid` was `z.string().min(1)`.** It is the VLESS/VMess credential and the
Trojan/Shadowsocks password, and it is written to disk in the clear. Any
non-empty string was accepted, including one containing a control character —
which produces a JSON document that is technically valid and that xray cannot
use. Now bounded to 128 chars, no whitespace or control characters, and a
restricted charset.

**2. `address` was a bare string.** It reaches xray's outbound verbatim. Now
`hostLikeAddress`, the same rule DIRECT and REVERSE use for the same reason.

**3. Reality was accepted without its keys.** `security: "reality"` produced
`{security: "reality", tlsSettings: {...}}` and nothing else. xray rejects that
at startup with an error that does not name the missing field. The schema now
requires `publicKey` when `security` is `reality`, and the builder emits a
complete `realitySettings` block.

## A test I had to correct rather than force

The suite originally asserted that `your-uuid-here` must be rejected as a
placeholder. It passed my charset rule, so the test failed — and the test was
**wrong**, not the rule. A short Shadowsocks password is indistinguishable from
a documentation placeholder, and rejecting it would refuse real
configurations. I replaced it with cases that are actually decidable (NUL, tab,
padding, too short, too long) and recorded the reasoning in the test, since the
next person will have the same idea.

## Platform honesty

Two assertions were replaced because they prove nothing on Windows:

- **File mode `0600`** — NTFS reports `0o666` for everything and `chmod` is a
  no-op, so the stat bits are meaningless here. The assertion is now
  POSIX-conditional, and the mode argument is verified through the remote
  script instead (`chmod 600` on the temp file before the rename), which is
  testable everywhere.
- **Failed write** — a read-only directory is not enforced on NTFS, so
  inducing failure that way silently passed. Replaced with a path whose parent
  is a *file*, which fails on every platform.

Both were checked empirically before being rewritten, not assumed.

## Tests: `scripts/test-xray.ts` — 45/45

Valid JSON and structural assertions (inbound/outbound/routing wiring — the
routing rule is what stops xray sending everything straight out via freedom),
all four protocols, ws/grpc/tls/reality stream settings, `allowInsecure` never
silently enabled, Reality key handling, 9 credential cases, 3 address cases,
atomic replacement (inode change), no temp-file leakage, failed-write
preserves the previous config, redaction through `sanitizeForDiagnostics` and
`buildDiagnostic`, command shape, and the remote script contract.

### Mutation testing — 7 mutants, all killed

| Mutant | Change | Result |
|---|---|---|
| A | local write truncates in place again | 1 fail |
| B | remote write truncates the live file | 3 fail |
| C | schema drops the Reality `publicKey` requirement | 2 fail |
| D | credential drops the whitespace/control rule | 1 fail |
| E | credential drops the charset/length rule | 1 fail |
| F | `address` reverts to a bare string | 3 fail |
| G | builder stops emitting `realitySettings` | 1 fail |

**Mutant D initially survived**, because the charset rule already rejects
whitespace and control characters. I checked that mechanically rather than
assuming it: the surviving rule is redundant for *refusal* but owns the
*message*. The suite now asserts the specific wording — a NUL byte must be
reported as a control character, not as "not a UUID" — which is what actually
distinguishes the two rules, the same resolution reached for TASK-31's
delimiter checks.

## Gate

```
test-xray                 45/45      test-port-allocation   27/27
test-reverse              36/36      test-bounded-caches     29/29
test-direct               49/49      test-diagnostics        22/22
test-port-forward         29/29      test-disposal-cleanup   15/15
test-forward-reconcile    26/26      test-retry-bounds       23/23
test-backhaul             39/39      test-tunnel-lifecycle   21/21
test-frp                  28/28      optimization harness    77/77
test-gost                 37/37      line endings            54/54
test-ssh                  50/50      version:check          7/7 match 1.1.2
typecheck clean     lint 0 errors     builds clean
```

`packages/types` was rebuilt before `tunnel-core`: `tunnel-core` compiles
against the emitted `.d.ts`, so a schema change surfaces there as a stale-type
error rather than a real one.

## Not claimed

- **No real xray binary ran.** Config generation, the write path, and redaction
  are tested; whether xray-core accepts the emitted document, and whether a
  Reality handshake works against a real 3X-UI, remain unproven. Real binary
  evidence is a separate step.
- The Windows unlink-and-retry path in `replaceFile` cannot be exercised for
  its EEXIST branch on NTFS, which renames natively. The POSIX rename path is
  the one under test here.
