/**
 * REVERSE reachability (TASK-32).
 *
 * The distinction this module exists to make:
 *
 *   a live `ssh -R` process  !=  a reachable public port
 *
 * OpenSSH's `-R` does not fail when the remote sshd refuses a non-loopback
 * bind. With `GatewayPorts no` -- the Debian and Ubuntu default -- the remote
 * listener is silently placed on loopback. The ssh process is healthy, the port
 * is listening, the panel says `running`, and nothing outside the Foreign host
 * can reach it. An operator acting on that status loses traffic with no error
 * anywhere in the UI.
 *
 * `GatewayPorts clientspecified` is what allows the bind, and the README
 * documents it. This module is the code side of that note: it turns the
 * observed remote bind into an honest reachability answer.
 *
 * Kept dependency-free and pure so it is testable without a live sshd, and so
 * the engine can call it with whatever the probe layer supplies.
 */

/** What the probe observed about the remote side of an `ssh -R`. */
export interface ReverseReachInput {
  /**
   * The address the remote listener actually ended up bound to, as reported
   * by the probe (e.g. from `ss -ltn`). `null`/empty when unknown.
   */
  boundAddress: string | null | undefined;
  /**
   * The address the operator asked for (`remoteBindAddr`). A probe that cannot
   * tell loopback from public must pass the request through so the comparison
   * below is meaningful.
   */
  requestedAddress: string;
  /** True when something is listening on the port on the remote side. */
  listening: boolean;
}

export interface ReverseReach {
  /** True only when a non-loopback listener is actually bound. */
  reachable: boolean;
  listening: boolean;
  boundAddress: string | null;
  /**
   * Short, sanitised explanation. Never contains a command line, key path or
   * credential -- the diagnostic surface forbids those.
   */
  reason: string | null;
  /** Operator-facing remedy, or null when there is nothing to fix. */
  recovery: string | null;
}

/** Loopback, in the forms a probe may report. */
const LOOPBACK = new Set(["127.0.0.1", "::1", "[::1]", "localhost", "127.0.0.0/8"]);

/** 0.0.0.0 and :: are the "all interfaces" wildcards -- public, not loopback. */
const WILDCARD = new Set(["0.0.0.0", "::", "[::]", "*", ""]);

function isLoopback(addr: string | null | undefined): boolean {
  if (!addr) return false;
  return LOOPBACK.has(addr.trim().toLowerCase());
}

/**
 * Decide whether a reverse forward is actually reachable.
 *
 * `processAlive` is a separate input because the caller has it and the outcome
 * differs: a live process with a loopback bind is `degraded`, not `error` --
 * the tunnel is half-working, and the fix is a one-line sshd setting rather
 * than a restart.
 */
export function probeReverseReachability(input: ReverseReachInput): ReverseReach {
  const bound = input.boundAddress ?? null;
  const listening = input.listening === true;

  if (!listening) {
    return {
      reachable: false,
      listening: false,
      boundAddress: bound,
      reason:
        "Nothing is listening on the remote port. The ssh -R forward is not " +
        "established yet, or the local service it points at refused the connection.",
      recovery:
        "Check that the local service is running and that the remote port is free on the Foreign host.",
    };
  }

  // A wildcard bind means every interface, which includes the public one.
  const wildcard = !bound || WILDCARD.has(bound.trim().toLowerCase());

  if (wildcard) {
    return {
      reachable: true,
      listening: true,
      boundAddress: bound,
      reason: null,
      recovery: null,
    };
  }

  if (isLoopback(bound)) {
    const deliberate = isLoopback(input.requestedAddress);
    if (deliberate) {
      // The operator asked for loopback. That is a working tunnel, reachable
      // from the Foreign host -- not a fault, and flagging it would train
      // operators to ignore the warning.
      return {
        reachable: true,
        listening: true,
        boundAddress: bound,
        reason: null,
        recovery: null,
      };
    }
    return {
      reachable: false,
      listening: true,
      boundAddress: bound,
      reason:
        `The remote port is listening on ${bound}, but ${input.requestedAddress} was ` +
        "requested. OpenSSH fell back to loopback because the remote sshd has " +
        "`GatewayPorts no`, so the port is NOT reachable from outside the Foreign host. " +
        "The ssh process being alive does not mean the port is public.",
      recovery:
        "On the Foreign host, set `GatewayPorts clientspecified` in sshd_config " +
        "(for example /etc/ssh/sshd_config.d/xistance.conf) and reload sshd, then restart the tunnel.",
    };
  }

  // Some specific public address. Reachable, and the bound address is worth
  // surfacing because it may not be the one that was requested.
  return {
    reachable: true,
    listening: true,
    boundAddress: bound,
    reason: null,
    recovery: null,
  };
}

/**
 * Fold a reachability result into a tunnel status.
 *
 * `livenessStatus` is what the process check alone concluded. Liveness is
 * necessary but not sufficient: for REVERSE it may only produce `running` when
 * the remote side is genuinely reachable.
 */
export function reverseStatus(
  reach: ReverseReach,
  livenessStatus: string,
  processAlive = true,
): string {
  if (!processAlive) return "stopped";
  if (reach.reachable) return livenessStatus;
  // Alive, listening, but not reachable. DEGRADED rather than ERROR: nothing
  // crashed, and the recovery is a config change, not a restart.
  return "degraded";
}

/** The sanitised one-line an operator sees in the UI. */
export function reachabilitySummary(reach: ReverseReach): string {
  if (reach.reachable) {
    return reach.boundAddress
      ? `Remote port is listening on ${reach.boundAddress}.`
      : "Remote port is listening on all interfaces.";
  }
  return reach.reason ?? "The reverse forward is not reachable.";
}
