// Runs once when the Node.js server starts: rehydrate the tunnel engine from
// the database so previously-running tunnels survive panel restarts, and start
// the traffic sampler.

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      const { prisma } = await import("@xistance/db");
      const { getEngine } = await import("@/lib/engine");
      const { buildDeploySpec } = await import("@/lib/tunnels");
      const { startTrafficSampler } = await import("@/lib/sampler");
      const { reconcilePortForwards } = await import("@/lib/forward-supervisor");
      const { startMaintenance } = await import("@/lib/maintenance");

      const tunnels = await prisma.tunnel.findMany({
        where: {
          OR: [
            { state: "running" },
            { state: "starting", autostart: true },
          ],
        },
        include: {
          clientNode: { select: { id: true, name: true, type: true, host: true, sshUser: true, sshPort: true, authMethod: true, sshKeyEncrypted: true, sshPasswordEnc: true } },
          serverNode: { select: { id: true, name: true, type: true, host: true, sshUser: true, sshPort: true, authMethod: true, sshKeyEncrypted: true, sshPasswordEnc: true } },
        },
      });
      for (const t of tunnels) {
        try {
          const spec = await buildDeploySpec(t, t.clientNode, t.serverNode);
          await getEngine().deploy(spec);
          console.log(`[instrumentation] rehydrated tunnel ${t.name}`);
        } catch (err) {
          console.error(`[instrumentation] failed to rehydrate ${t.name}`, err);
        }
      }
      // Re-deploy enabled port-forward rules so they match their persisted state.
      try {
        await reconcilePortForwards();
        console.log("[instrumentation] port-forward rules reconciled");
      } catch (err) {
        console.error("[instrumentation] port-forward reconcile failed", err);
      }
      startTrafficSampler();
      startMaintenance();
      console.log("[instrumentation] traffic sampler + maintenance started");

      // Flush debounced engine stats to disk on shutdown so up to 5s of
      // traffic counters aren't lost across restarts.
      const engine = getEngine();
      const flush = () => {
        try {
          engine.flushStats();
        } catch {
          /* best effort */
        }
      };
      process.once("SIGTERM", flush);
      process.once("SIGINT", flush);
      process.once("beforeExit", flush);
    } catch (err) {
      console.error("[instrumentation] rehydration failed", err);
    }
  }
}
