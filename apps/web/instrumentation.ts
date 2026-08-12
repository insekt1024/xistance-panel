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

      const tunnels = await prisma.tunnel.findMany({
        where: { OR: [{ state: "running" }, { state: "starting" }] },
      });
      for (const t of tunnels) {
        const client = t.clientNodeId
          ? await prisma.node.findUnique({ where: { id: t.clientNodeId } })
          : null;
        const server = t.serverNodeId
          ? await prisma.node.findUnique({ where: { id: t.serverNodeId } })
          : null;
        try {
          const spec = await buildDeploySpec(t, client, server);
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
      console.log("[instrumentation] traffic sampler started");
    } catch (err) {
      console.error("[instrumentation] rehydration failed", err);
    }
  }
}
