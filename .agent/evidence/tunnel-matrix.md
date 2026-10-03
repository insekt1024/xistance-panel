# All-method regression matrix

Generated 2026-10-03T17:46:24.464Z by `scripts/test-method-matrix.ts`.

> **This harness runs every method with an INJECTED process handle. Its own**
> **`realBinary` column is therefore `false` for all nine: no tunnel binary is**
> **executed here. Real-binary evidence comes from a separate pass on the**
> **target OS and is recorded in `real-binary-evidence.json` (validated by**
> **`scripts/test-real-binary-evidence.ts`). Read the two columns separately.**

| Method | Config | Lifecycle | Failure | Cleanup | Resource | Real binary (harness / on target) | Shared checks | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| BACKHAUL | yes | yes | referenced | yes | yes | yes (no here) | 21/21 | single-process: no partial deploy to leak |
| FRP | yes | yes | referenced | yes | yes | yes (no here) | 21/21 | single-process: no partial deploy to leak |
| GOST | yes | yes | referenced | yes | yes | yes (no here) | 21/21 | single-process: no partial deploy to leak |
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

- **XUI** — Metadata-only by design: X-UI records the status of a third-party 3x-ui panel and runs no tunnel binary on our nodes, so there is no binary to execute. Status is established by a real panel verification instead. This gap is by design, not an environment shortfall, and no credential would close it.

## Per-method suites

- `BACKHAUL` — `scripts/test-backhaul.ts`
- `FRP` — `scripts/test-frp.ts`
- `GOST` — `scripts/test-gost.ts`
- `SSH` — `scripts/test-ssh.ts`
- `PORT_FORWARD` — `scripts/test-port-forward.ts`
- `DIRECT` — `scripts/test-direct.ts`
- `REVERSE` — `scripts/test-reverse.ts`
- `XRAY` — `scripts/test-xray.ts`
- `XUI` — `scripts/test-xui.ts`
