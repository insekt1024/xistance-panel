import { json } from "@/lib/api";

export const dynamic = "force-dynamic";

interface EndpointDoc {
  method: string;
  path: string;
  auth: "none" | "user" | "admin" | "super_admin";
  description: string;
  params?: string;
  rateLimit?: string;
}

interface DocsResponse {
  name: string;
  version: string;
  description: string;
  auth: {
    description: string;
    roles: string[];
    session: string;
  };
  pagination: {
    description: string;
    params: string[];
  };
  endpoints: EndpointDoc[];
}

const docs: DocsResponse = {
  name: "Xistance Panel API",
  version: "1.0",
  description:
    "REST API for managing tunnels, nodes, port-forwarding rules, users, and diagnostics in the Xistance tunnel management panel.",
  auth: {
    description:
      "Most endpoints require a session cookie obtained via POST /api/auth/login. State-changing requests also require the Origin to match plus a CSRF token in the x-csrf-token header that matches the xt_csrf cookie.",
    roles: ["USER", "ADMIN", "SUPER_ADMIN"],
    session:
      "POST /api/auth/login with { email, password } to create a session. POST /api/auth/logout to destroy it.",
  },
  pagination: {
    description:
      "List endpoints use cursor-based pagination. Pass ?cursor=<id>&limit=<n> (max 100, default 50). Response includes hasNext and nextCursor fields.",
    params: ["cursor", "limit"],
  },
  endpoints: [
    // Auth
    {
      method: "POST",
      path: "/api/auth/login",
      auth: "none",
      description: "Authenticate and create a session. Rate-limited to 5 attempts per IP per minute.",
      params: "{ email: string, password: string }",
      rateLimit: "5/min per IP",
    },
    {
      method: "GET",
      path: "/api/auth/me",
      auth: "user",
      description: "Return the currently authenticated user profile.",
    },
    {
      method: "POST",
      path: "/api/auth/refresh",
      auth: "user",
      description: "Refresh the current session token.",
    },
    {
      method: "POST",
      path: "/api/auth/logout",
      auth: "none",
      description: "Destroy the current session and revoke the cookie.",
    },

    // Health
    {
      method: "GET",
      path: "/api/health",
      auth: "none",
      description:
        "Liveness/readiness probe. Returns DB reachability, engine status, and app version. Returns 503 when degraded.",
    },

    // Nodes
    {
      method: "GET",
      path: "/api/nodes",
      auth: "user",
      description:
        "List all nodes with cursor-based pagination. Secrets (keys, passwords) are redacted in responses.",
    },
    {
      method: "POST",
      path: "/api/nodes",
      auth: "admin",
      description:
        "Create a new node. Requires unique name+type combination. Secrets are encrypted at rest.",
      params:
        "{ name, type: 'IRAN'|'FOREIGN', host, port?, username?, authMethod: 'key'|'password', key?, password?, apiToken? }",
    },
    {
      method: "GET",
      path: "/api/nodes/[id]",
      auth: "user",
      description: "Get a single node by ID. Secrets are redacted.",
    },
    {
      method: "PUT",
      path: "/api/nodes/[id]",
      auth: "admin",
      description: "Update an existing node. Partial updates supported.",
      params:
        "{ name?, type?, host?, port?, username?, authMethod?, key?, password?, apiToken? }",
    },
    {
      method: "DELETE",
      path: "/api/nodes/[id]",
      auth: "admin",
      description:
        "Delete a node. Fails with 409 if the node is used by any tunnel.",
    },
    {
      method: "POST",
      path: "/api/nodes/[id]/test",
      auth: "admin",
      description:
        "Test SSH connectivity to a node. Spawns an SSH probe with a 10s timeout.",
      rateLimit: "10/min per user",
    },

    // Tunnels
    {
      method: "GET",
      path: "/api/tunnels",
      auth: "user",
      description:
        "List tunnels. USER role sees only owned + unowned tunnels; ADMIN+ sees all. Cursor-paginated.",
    },
    {
      method: "POST",
      path: "/api/tunnels",
      auth: "user",
      description:
        "Create and deploy a new tunnel. Checks port conflicts and user quota before deploying.",
      params:
        "{ name, clientNodeId, serverNodeId, config: TunnelConfig, autostart? }",
    },
    {
      method: "GET",
      path: "/api/tunnels/[id]",
      auth: "user",
      description:
        "Get tunnel details including live state from the engine.",
    },
    {
      method: "DELETE",
      path: "/api/tunnels/[id]",
      auth: "user",
      description:
        "Stop (if running) and delete a tunnel. Users can only delete their own tunnels.",
    },
    {
      method: "POST",
      path: "/api/tunnels/[id]/actions",
      auth: "user",
      description:
        "Start, stop, or restart a tunnel. Re-deploys if the tunnel is not loaded in the engine.",
      params: "{ action: 'start' | 'stop' | 'restart' }",
      rateLimit: "30/min per user",
    },
    {
      method: "GET",
      path: "/api/tunnels/[id]/logs",
      auth: "user",
      description:
        "Return the last 300 log lines for a tunnel (if running).",
    },
    {
      method: "POST",
      path: "/api/tunnels/[id]/logs",
      auth: "user",
      description:
        "Take an I/O stats snapshot of a running tunnel's process.",
    },
    {
      method: "GET",
      path: "/api/tunnels/[id]/events",
      auth: "user",
      description:
        "Server-Sent Events stream for live tunnel logs. Heartbeat every 15s.",
    },

    // Port Forwards
    {
      method: "GET",
      path: "/api/port-forwards",
      auth: "user",
      description:
        "List port-forwarding rules with cursor-based pagination.",
    },
    {
      method: "POST",
      path: "/api/port-forwards",
      auth: "user",
      description:
        "Create a new port-forwarding rule. Triggers reconciliation of iptables/nftables rules.",
      params:
        "{ name, direction: 'IRAN_TO_FOREIGN'|'FOREIGN_TO_IRAN', protocol: 'tcp'|'udp', sourcePort, destHost, destPort, enabled?, nodeId? }",
    },
    {
      method: "PUT",
      path: "/api/port-forwards/[id]",
      auth: "user",
      description:
        "Update a port-forwarding rule. Triggers reconciliation. Users can only update their own rules.",
      params:
        "{ name?, direction?, protocol?, sourcePort?, destHost?, destPort?, enabled?, nodeId? }",
    },
    {
      method: "DELETE",
      path: "/api/port-forwards/[id]",
      auth: "user",
      description:
        "Delete a port-forwarding rule. Triggers reconciliation.",
    },

    // Users
    {
      method: "GET",
      path: "/api/users",
      auth: "admin",
      description: "List all user accounts.",
    },
    {
      method: "POST",
      path: "/api/users",
      auth: "admin",
      description:
        "Create a new user. If no password is provided, one is generated and returned in the response (shown once).",
      params:
        "{ email, name, role?: 'USER'|'ADMIN'|'SUPER_ADMIN', quota?, password?, active? }",
    },
    {
      method: "PUT",
      path: "/api/users/[id]",
      auth: "admin",
      description:
        "Update a user. Prevents demoting the last SUPER_ADMIN.",
      params: "{ name?, role?, quota?, password?, active? }",
    },
    {
      method: "DELETE",
      path: "/api/users/[id]",
      auth: "super_admin",
      description:
        "Delete a user. Cannot delete yourself.",
    },

    // Audit
    {
      method: "GET",
      path: "/api/audit",
      auth: "admin",
      description:
        "List audit log entries with cursor-based pagination. Shows actor, action, target, IP, and timestamp.",
    },

    // Settings
    {
      method: "POST",
      path: "/api/settings/password",
      auth: "user",
      description:
        "Change the authenticated user's password. Revokes all other sessions. Rate-limited to 5 attempts per minute.",
      params: "{ current: string, new: string }",
      rateLimit: "5/min per user",
    },
    {
      method: "GET",
      path: "/api/settings/backup",
      auth: "admin",
      description:
        "Export a full backup (users, nodes, tunnels, port-forwards, webhooks, settings, traffic samples). Secrets remain encrypted.",
    },
    {
      method: "POST",
      path: "/api/settings/backup",
      auth: "super_admin",
      description:
        "Restore a backup. Uses upsert-style inserts (duplicates are silently skipped).",
      params: "{ backup: { version: 1, users?, nodes?, tunnels?, portForwards?, webhooks?, settings? } }",
    },

    // Tools
    {
      method: "POST",
      path: "/api/tools",
      auth: "user",
      description:
        "Run diagnostic tools: TCP port check, HTTP check, ping latency, DNS lookup, and censorship probe.",
      params:
        "{ type: 'tcp', host, port } | { type: 'http', url } | { type: 'latency', host } | { type: 'dns' } | { type: 'censorship' }",
      rateLimit: "20/min per user",
    },
  ],
};

export async function GET() {
  return json(docs);
}
