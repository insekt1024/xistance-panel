# ICMP tunnel method (pingtunnel)

## Goal
Add a tenth tunnel method, ICMP, that carries TCP/UDP/SOCKS5 over ICMP echo
using esrrhs/pingtunnel (Go, static binaries, Apache/MIT). Lets a node reach a
service when only ICMP passes the filter.

## Upstream facts (from USAGE.md, not guessed)
- Server: `pingtunnel -type server -key <0..2147483647>` (needs raw ICMP -> root)
- Client: `pingtunnel -type client -l :PORT -s HOST -t HOST:PORT [-tcp 1] -key K`
- `-sock5 1` = SOCKS5 mode (implies TCP; `-t` optional)
- `-encrypt` = aes128|aes256|chacha20 (empty = off), `-encrypt-key` separate
- `-type` is shared by both roles; `-key` must MATCH on both sides
- Config-file mode `-c x.json`; CLI flags override file keys
- Congestion default `bb`; `-maxconn`, `-conntt`, `-timeout`, `-icmp_l`,
  `-nolog`, `-loglevel` also exist
- Latest release 2.10; linux assets `pingtunnel_linux64.zip` / `..._arm64.zip`

## Design decisions
1. **Config file, not argv, for the key.** The shared `key` (and the optional
   encryption passphrase) go into a 0600 JSON file passed with `-c`, mirroring
   BACKHAUL's 0600 config.toml carrying its token. argv is world-visible via
   `ps`, and systemd unit text is written to disk too.
2. **Both roles always run a process** (server + client), so the method gets the
   full lifecycle contract including partial-deploy cleanup.
3. **Key is numeric and required**, 0..2147483647 per USAGE.md. Bounded by the
   schema so a bad value is refused before anything is written.
4. **Target host:port required unless sock5** — same pair-required rule GOST
   learned the hard way (a blank target produced a listener that refused
   everything while reporting "running").
5. **Encryption optional but off by default**; when set, the passphrase is a
   separate secret and never logged.

## Files to change
- `packages/types/src/index.ts` — TunnelMethod.ICMP, IcmpConfigSchema, union arm
- `packages/tunnel-core/src/config/pingtunnel.ts` — NEW pure builders
- `packages/tunnel-core/src/{engine,binary,index}.ts` — planner, binary, barrel
- `packages/i18n/messages/en.json` + `fa.json` — labels + descriptions together
- `apps/web/.../tunnel-wizard.tsx`, `src/lib/tunnels.ts`, `import-dialog.tsx`
- `packages/db/prisma/schema.prisma` — method comment
- `scripts/install.sh` — pin digests + install pingtunnel
- `scripts/test-icmp.ts` — NEW per-method suite
- `scripts/test-method-matrix.ts`, `scripts/lib/method-contract.ts` — 10th method
- `scripts/run-all-tests.ts` — register
- `README.md` + `README_FA.md` — method list parity
- `.agent/evidence/` — record

## Verification (no vacuous passes)
- config builder: exact argv/JSON per role; key never in argv
- schema: out-of-range key refused; missing target refused unless sock5
- mutation: revert parser / revert key-to-0600 and watch the specific check fail
- method contract: ICMP row in the matrix, all dimensions covered
- aggregate: 78/78 + RESULT: PASS
- CI: all four jobs green on the pushed commit

## Not claimed
ICMP needs raw sockets (root) and is throughput-limited. No two-node traffic test
unless a real binary runs on both ends; the record says `realBinary: false`.
