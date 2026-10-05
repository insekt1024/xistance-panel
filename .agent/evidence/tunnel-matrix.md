# All-method regression matrix

Generated 2026-10-05T13:54:27.045Z by `scripts/test-method-matrix.ts`.

> **This harness runs every method with an INJECTED process handle. Its own**
> **`realBinary` column is therefore `false` for all methods: no tunnel binary is**
> **executed here. Real-binary evidence comes from a separate pass on the**
> **target OS and is recorded in `real-binary-evidence.json` (validated by**
> **`scripts/test-real-binary-evidence.ts`). Read the two columns separately.**

| Method | Config | Lifecycle | Failure | Cleanup | Resource | Real binary (harness / on target) | Shared checks | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| BACKHAUL | yes | yes | referenced | yes | yes | yes (no here) | 21/21 | single-process: no partial deploy to leak |
| FRP | yes | yes | referenced | yes | yes | yes (no here) | 21/21 | single-process: no partial deploy to leak |
| GOST | yes | yes | referenced | yes | yes | yes (no here) | 21/21 | single-process: no partial deploy to leak |
| ICMP | yes | yes | referenced | yes | yes | **no** (no here) | 21/21 | single-process: no partial deploy to leak |
| SSH | yes | yes | referenced | yes | yes | yes (no here) | 21/21 | single-process: no partial deploy to leak |
| PORT_FORWARD | yes | yes | referenced | yes | yes | yes (no here) | 21/21 | single-process: no partial deploy to leak |
| DIRECT | yes | yes | referenced | yes | yes | yes (no here) | 21/21 | single-process: no partial deploy to leak |
| REVERSE | yes | yes | referenced | yes | yes | yes (no here) | 21/21 | single-process: no partial deploy to leak |
| XRAY | yes | yes | referenced | yes | yes | yes (no here) | 21/21 | single-process: no partial deploy to leak |
| XUI | yes | yes | referenced | yes | yes | **no** (no here) | 17/17 | metadata-only: no process, no partial deploy; status comes from a real panel verification |

## Injected-process vs real-binary evidence

Every row's `Config`/`Lifecycle`/`Failure`/`Cleanup`/`Resource` columns are `local_command+injected_process` evidence: the engine lifecycle, cleanup, and resource guarantees are genuinely exercised through a real `TunnelEngine` with a scriptable process handle, which is what makes idempotent stop and partial-deploy cleanup provable at all.

A real-binary pass has since been executed on the target OS. **8/9** methods carry real bytes across a real tunnel: `BACKHAUL`, `DIRECT`, `FRP`, `GOST`, `PORT_FORWARD`, `REVERSE`, `SSH`, `XRAY`. See `task-65-tunnel-traffic.md`. The remaining 1 are recorded as NOT proved with a real binary, each with the reason.

### Methods without real-binary evidence

- **XUI** — Metadata-only by design: X-UI records the status of a third-party 3x-ui panel and runs no tunnel binary on our nodes, so there is no binary to execute. Status is established by a real panel verification instead. Not a coverage gap: PRD.md:112 specifies XUI's requirements as private-network exception, credential-free sync payload, API failure behavior and bounded retries -- none of which is a tunnel binary. Those four are asserted in scripts/test-xui.ts (61 passed, 0 failed). This field records which methods run an Xistance engine, which is a different question from which methods meet their PRD requirements.
- **ICMP** — No pingtunnel binary is installed on this host, so no ICMP process was started and no traffic crossed an ICMP echo hop. Verified instead: the generated per-role JSON config, the exact argv, and the full engine lifecycle through the shared method contract (21 checks). Two node-side requirements are also untested here: the server needs root or CAP_NET_RAW for a raw ICMP socket, and end-to-end reachability depends on the path actually permitting ping.

## Per-method suites

- `BACKHAUL` — `scripts/test-backhaul.ts`
- `FRP` — `scripts/test-frp.ts`
- `GOST` — `scripts/test-gost.ts`
- `ICMP` — `scripts/test-icmp.ts`
- `SSH` — `scripts/test-ssh.ts`
- `PORT_FORWARD` — `scripts/test-port-forward.ts`
- `DIRECT` — `scripts/test-direct.ts`
- `REVERSE` — `scripts/test-reverse.ts`
- `XRAY` — `scripts/test-xray.ts`
- `XUI` — `scripts/test-xui.ts`
