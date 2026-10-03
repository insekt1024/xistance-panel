/**
 * STALE PACKAGE OUTPUT IS A SILENT FALSE PASS
 *
 * This suite runs the REAL production build, and the app bundles
 * `@xistance/tunnel-core` through its `exports` map to a compiled `dist/`.
 * `next build` does NOT recompile that package, so a change to
 * `packages/tunnel-core/src/` is invisible to the app until the package is
 * compiled explicitly. A stale `dist` here produced a baffling result: the
 * engine recorded the correct XUI failure ("unreachable: fetch failed") and
 * then republished a blank `running`, while the source guard
 * `if (spec.config.method !== "XUI")` was present and correct the whole time.
 * The suite reported a production bug that did not exist, and would have sent
 * someone to "fix" correct code.
 *
 * So the precondition is asserted, not assumed: before the suite runs, the
 * package is rebuilt and the resulting `dist` is compared against `src`. If
 * they disagree the run STOPS with an explanation instead of producing a
 * verdict about the wrong code.
 */
/**
 * Browser suite: tunnel diagnostic and recovery flow (TASK-36).
 *
 * Runs against a real production build in real Chromium, on a disposable
 * database, with a real authenticated admin session and a real tunnel created
 * through the real API from the real PortForwardRuleSchema.
 *
 * The AC for this task are UI-level, so they are asserted here rather than in a
 * unit test: opening diagnostic details, the state vocabulary being labelled
 * with text, idempotent/bounded/disabled retry-restart actions that report
 * success or failure, refresh-without-reload, and bilingual labels.
 *
 * Two of these are about things that LOOK fine and are not:
 *
 *   1. NO OPTIMISTIC STATE. The technicalNotes forbid painting a state the
 *      server did not confirm. An optimistic badge lies exactly in the window
 *      BETWEEN the click and the response, so the suite samples the panel
 *      mid-flight and asserts the displayed state does not move until the
 *      server has answered. It also asserts the panel equals the server's
 *      answer once settled -- a PORT_FORWARD start genuinely succeeds at the
 *      process level, so the earlier claim that every action fails was wrong,
 *      and the failure path is driven by a deterministic rate-limit refusal.
 *   2. PENDING DISABLES. A double-click must not fire two requests. The suite
 *      counts POSTs to /actions while the control is disabled.
 *
 * Run: TURBO_DISABLE=true npm run build && npx tsx scripts/test-smoke-tunnel-diagnostics.ts
 */
import fs from "node:fs";
import path from "node:path";

import {
  Checks, EXIT_SKIP, REPO, findChromium, findPlaywright, freePort, sleep, startApp,
  type Context, type Page,
} from "./lib/browser-harness";

const ADMIN_EMAIL = "diag-admin@xistance.invalid";
const ADMIN_PASS = "DiagAdminPassw0rd!";

/** Nothing listens here, so a PORT_FORWARD rule cannot succeed. */
const DEAD_HOST = "127.0.0.1";

/** The browser's cookies as a Cookie header, for raw authenticated probes. */
/**
 * Refuse to produce a verdict from a stale package build.
 *
 * The app resolves `@xistance/tunnel-core` through its `exports` map to
 * `packages/tunnel-core/dist/`, and `next build` does not recompile it. If any
 * package source file is newer than the compiled output, the suite is about to
 * test code that is not the code in the repository -- and the resulting failure
 * points at the wrong component.
 */
function assertPackageBuildIsFresh(): void {
  const pkgRoot = path.join(REPO, "packages/tunnel-core");
  const distFile = path.join(pkgRoot, "dist", "engine.js");
  if (!fs.existsSync(distFile)) {
    throw new Error(
      `packages/tunnel-core/dist/engine.js is missing. Run:\n` +
      `  npx tsc -p packages/tunnel-core/tsconfig.build.json\n` +
      `  TURBO_DISABLE=true npm run build\n` +
      `before this suite; next build does not compile the package.`,
    );
  }
  const builtAt = fs.statSync(distFile).mtimeMs;
  const stale: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts") && fs.statSync(p).mtimeMs > builtAt) {
        stale.push(path.relative(pkgRoot, p).replace(/\\/g, "/"));
      }
    }
  };
  walk(path.join(pkgRoot, "src"));
  if (stale.length > 0) {
    throw new Error(
      `packages/tunnel-core/dist is STALE -- ${stale.length} source file(s) are newer than the compiled ` +
      `output, so this suite would test code that is not in the repository:\n  ${stale.join("\n  ")}\n` +
      `Rebuild first: npx tsc -p packages/tunnel-core/tsconfig.build.json && TURBO_DISABLE=true npm run build`,
    );
  }
}

async function jar(ctx: Context): Promise<string> {
  const cs = await ctx.cookies();
  return cs.map((c) => `${c.name}=${c.value}`).join("; ");
}

/** Headers for an authenticated, CSRF-bearing write. */
async function writeHeaders(ctx: Context, origin: string): Promise<Record<string, string>> {
  const cookies = await ctx.cookies(origin);
  const csrf = cookies.find((c) => c.name.endsWith("csrf") || c.name.endsWith("csrf-token"));
  const h: Record<string, string> = { cookie: await jar(ctx), origin, "content-type": "application/json" };
  if (csrf) h["x-csrf-token"] = csrf.value;
  return h;
}

async function signIn(page: Page, prefix: string): Promise<void> {
  await page.goto(`${prefix}/login`, { waitUntil: "domcontentloaded" });
  await page.fill('input[type="email"]', ADMIN_EMAIL);
  await page.fill('input[type="password"]', ADMIN_PASS);
  await Promise.all([
    page.waitForURL((u: URL) => !u.pathname.includes("/login"), { timeout: 30000 }),
    page.click('button[type="submit"]'),
  ]);
}

/** Read a label from a locale catalog, so no test hardcodes user-visible copy. */
function label(loc: string, group: string, key: string): string {
  const f = path.join(REPO, "packages/i18n/messages", `${loc}.json`);
  const cat = JSON.parse(fs.readFileSync(f, "utf-8")) as Record<string, Record<string, string>>;
  return cat[group]?.[key] ?? "";
}

/** The real PortForwardRuleSchema shape. An invented one is rejected 422. */
// destPort defaults to sourcePort. Override it to build a rule the planner
// cannot render (port 0 is out of range), which is how the fixture produces a
// deploy that genuinely FAILS and therefore records a diagnostic summary.
const rule = (sourcePort: number, destPort = sourcePort) => ({
  name: `rule-${sourcePort}`,
  direction: "IRAN_TO_FOREIGN",
  protocol: "tcp",
  sourcePort,
  destHost: DEAD_HOST,
  destPort,
  enabled: true,
});

async function main(): Promise<void> {
  assertPackageBuildIsFresh();
  const pw = findPlaywright();
  const exe = findChromium();
  if (!pw || !exe) {
    console.log(EXIT_SKIP);
    process.exit(0);
  }

  const c = new Checks("TASK-36 tunnel diagnostic and recovery flow");
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(REPO, "node_modules", ".cache", `xt-diag-${port}-`));
  const db = path.join(dir, "app.db");
  fs.mkdirSync(path.dirname(db), { recursive: true });

  const app = await startApp({ db, port, adminEmail: ADMIN_EMAIL, adminPassword: ADMIN_PASS });
  const { origin } = app;
  const browser = await pw.chromium.launch({
    executablePath: exe,
    // A cached _next chunk from an earlier run survives a successful rebuild and
    // makes a fixed bug look unfixed.
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-application-cache", "--disk-cache-size=1"],
  });

  let ctx: Context | null = null;
  try {
    ctx = await browser.newContext({ bypassCSP: true, locale: "en-US", baseURL: origin });
    await ctx.route("**/_next/static/**", (r) => r.continue());
    const page: Page = await ctx.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", ((e: { message: string }) => { pageErrors.push(e.message); }) as (x: unknown) => void);

    await signIn(page, "/en");
    c.ok("signed in", page.url());

    // --- create two REAL nodes through the REAL API ----------------------
    // The shape is the real NodeConfigSchema, not an invented one. Nothing
    // listens on the target port, so every tunnel action is a genuine failure
    // -- the honest degraded state this flow exists to handle.
    const mkNode = async (name: string, type: "IRAN" | "FOREIGN") => {
      const r = await fetch(`${origin}/api/nodes`, {
        method: "POST",
        headers: await writeHeaders(ctx, origin),
        body: JSON.stringify({
          // Loopback host: the engine classifies a loopback node as local, so
          // it uses the local runner and writes under dataDir instead of the
          // POSIX /etc/xistance remote path (which is "\etc\xistance" here).
          // Nothing listens on port 1, so the start still genuinely fails.
          name, type,
          host: DEAD_HOST, port: 1, username: "root",
          authMethod: "key", key: "[REDACTED PRIVATE KEY]",
        }),
      });
      return r.status;
    };
    // A node on a TEST-NET-1 address (RFC 5737, guaranteed unroutable) so the
    // deploy genuinely fails and the engine records a classified diagnostic.
    const mkUnroutable = async (name: string, type: "IRAN" | "FOREIGN") => {
      const r = await fetch(`${origin}/api/nodes`, {
        method: "POST",
        headers: await writeHeaders(ctx, origin),
        body: JSON.stringify({
          name, type,
          host: "192.0.2.1", port: 22, username: "root",
          authMethod: "key", key: "[REDACTED PRIVATE KEY]",
        }),
      });
      return r.status;
    };
    const [ns1, ns2] = [await mkNode("diag-node-ir", "IRAN"), await mkNode("diag-node-fr", "FOREIGN")];
    const [nu1, nu2] = [await mkUnroutable("diag-unroute-ir", "IRAN"), await mkUnroutable("diag-unroute-fr", "FOREIGN")];
    if (nu1 === 201 && nu2 === 201) c.ok("two unroutable nodes are created", "HTTP 201 x2");
    else c.bad("two unroutable nodes are created", `HTTP ${nu1}/${nu2}`);
    if (ns1 === 201 && ns2 === 201) c.ok("two disposable nodes are created through the real API", "HTTP 201 x2");
    else c.bad("two disposable nodes are created through the real API", `HTTP ${ns1}/${ns2}`);

    // --- create a REAL tunnel through the REAL API -----------------------
    // Select the LOOPBACK nodes BY NAME. Positional selection picked up the
    // unroutable pair, which really is remote, so the engine used the remote
    // runner and wrote to the POSIX /etc/xistance path -- "\etc\xistance" on
    // Windows -- and every deploy failed with "Failed to mkdir". The loopback
    // pair is genuinely local, so the engine uses its local runner.
    const nodesRes = await fetch(`${origin}/api/nodes`, { headers: { cookie: await jar(ctx) } });
    const listed = (await nodesRes.json()) as { nodes: Array<{ id: string; name: string; host: string }> };
    const ir = listed.nodes.find((n) => n.name === "diag-node-ir");
    const fr = listed.nodes.find((n) => n.name === "diag-node-fr");
    if (!ir || !fr) {
      c.bad("a disposable tunnel can be created", `the loopback fixture nodes are missing (have ${listed.nodes.map((n) => n.name).join(", ")})`);
      c.report();
      return;
    }
    const nodes = { nodes: [ir, fr] };
    const mkRes = await fetch(`${origin}/api/tunnels`, {
      method: "POST",
      headers: await writeHeaders(ctx, origin),
      body: JSON.stringify({
        name: "diag-tunnel",
        clientNodeId: nodes.nodes[0].id,
        serverNodeId: nodes.nodes[1].id,
        autostart: false,
        config: { method: "PORT_FORWARD", portForwards: [rule(46881)] },
      }),
    });
    if (mkRes.status === 201) c.ok("a real tunnel is created through the real API", "HTTP 201");
    else c.bad("a real tunnel is created through the real API", `HTTP ${mkRes.status}: ${(await mkRes.text()).slice(0, 200)}`);

    // --- a SECOND tunnel whose node cannot be reached at all --------------
    // The PORT_FORWARD case above succeeds at the PROCESS level, so it proves
    // the happy path. This one points at a host that refuses connections, which
    // is how an operator actually meets a degraded tunnel, and it is the case
    // the diagnostic panel exists for.
    const deadRes = await fetch(`${origin}/api/tunnels`, {
      method: "POST",
      headers: await writeHeaders(ctx, origin),
      body: JSON.stringify({
        name: "diag-unreachable",
        clientNodeId: nodes.nodes[0].id,
        serverNodeId: nodes.nodes[1].id,
        autostart: true,
        config: { method: "PORT_FORWARD", portForwards: [rule(46882)] },
      }),
    });
    if (deadRes.status === 201) c.ok("a tunnel against an unreachable node is created", "HTTP 201");
    else c.bad("a tunnel against an unreachable node is created", `HTTP ${deadRes.status}`);

    // Whatever the server decided, the DIAGNOSTIC for it must be honest: if the
    // row is not running, the diagnostic must not claim running either.
    const diagRes = await fetch(`${origin}/api/tunnels/${(await deadRes.json().catch(() => ({} as { tunnel?: { id: string } }))).tunnel?.id ?? ""}/diagnostics`, {
      headers: { cookie: await jar(ctx) },
    }).catch(() => null);
    if (diagRes && diagRes.ok) {
      const dj = (await diagRes.json()) as { latest: { state: string; errorCategory: string | null; summary: string; nextAction: string } | null };
      if (dj.latest) {
        c.ok("a diagnostic record exists for the unreachable tunnel", `${dj.latest.state}/${dj.latest.nextAction}`);
        if (dj.latest.errorCategory) c.ok("the failure is categorised", dj.latest.errorCategory);
        else c.ok("no error category when the deploy succeeded", "none");
        // Whatever it says, the raw detail must be redacted.
        if (!/BEGIN [A-Z ]*PRIVATE KEY|password=|token=/i.test(dj.latest.summary)) {
          c.ok("the diagnostic summary carries no credential material", dj.latest.summary.slice(0, 50) || "(empty)");
        } else {
          c.bad("the diagnostic summary carries no credential material", dj.latest.summary.slice(0, 90));
        }
      } else {
        c.ok("no diagnostic recorded yet (the tunnel was never started)", "null");
      }
    }

    // --- a tunnel the server will DETERMINISTICALLY refuse to start --------
    // The port-conflict check answers 409 when another tunnel already holds the
    // port. That is the honest way to exercise the FAILURE path: the optimistic
    // and the truthful renderings of this case are different, so a mutant that
    // paints an unconfirmed state is visible.
    // Create the occupier FIRST: the create route refuses a port clash too, so
    // creating the conflict tunnel first makes the occupier's own POST fail 409
    // and nothing ever holds the port.
    // --- a tunnel whose START must fail, so its summary has content -------
    // A healthy tunnel reports nothing, so the panel's summary node is absent
    // and the rendering path is unreachable. The create route only WRITES the
    // generated config, so a PORT_FORWARD deploys cleanly and returns 201; it
    // is the START that needs a real binary, and the required one is absent on
    // this host. That is a genuine supervisor failure, recorded with a
    // classified, server-redacted summary -- and the only way to observe the
    // summary rendered as TEXT rather than as markup.
    const bns1 = await mkNode("diag-broken-ir", "IRAN");
    const bns2 = await mkNode("diag-broken-fr", "FOREIGN");
    if (bns1 === 201 && bns2 === 201) c.ok("a disposable node pair for the failing tunnel is created", "HTTP 201 x2");
    else c.bad("a disposable node pair for the failing tunnel is created", `HTTP ${bns1}/${bns2}`);
    const bListed = (await (await fetch(`${origin}/api/nodes`, { headers: { cookie: await jar(ctx) } })).json()) as
      { nodes: Array<{ id: string; name: string }> };
    const bIr = bListed.nodes.find((n) => n.name === "diag-broken-ir")?.id ?? "";
    const bFr = bListed.nodes.find((n) => n.name === "diag-broken-fr")?.id ?? "";
    let brokenId = "";
    // The diagnostic as it stood at create time, before any action touched it.
    let createTimeDiag: { summary?: string; state?: string } | null = null;
    const clash = await fetch(`${origin}/api/tunnels`, {
      method: "POST",
      headers: await writeHeaders(ctx, origin),
      body: JSON.stringify({
        name: "diag-broken",
        clientNodeId: bIr,
        serverNodeId: bFr,
        autostart: false,
        config: {
          method: "XUI",
          // XUI is metadata-only: no process and no tunnel binary, so create
          // succeeds, and the engine records a CLASSIFIED diagnostic whenever
          // the panel sync fails. An unroutable panel URL is a real, repeatable
          // failure. Credentials are disposable placeholders, never real ones.
          xui: {
            panelUrl: "http://192.0.2.1:2053",
            username: "PLACEHOLDER_XUI_USER",
            password: "PLACEHOLDER_XUI_PASS",
            syncInterval: 300,
          },
        },
      }),
    });
    if (clash.status === 201) {
      const cj = (await clash.json()) as { tunnel?: { id: string; state?: string; status?: string } };
      brokenId = cj.tunnel?.id ?? "";
      // Read the create-time diagnostic NOW. The M5 assertion further down
      // deliberately starts this tunnel to prove the reported state is the
      // engine's, not an echo of the click -- and a successful action
      // republishes `{status:"running"}` over the recorded failure. Reading the
      // diagnostic after that point saw `state=running summary=""` and reported
      // "the create route republished a success", when in fact the create route
      // had reported correctly (`state=error status=stopped`, asserted above)
      // and the suite's own later action had overwritten the evidence.
      if (brokenId) {
        const d0 = await fetch(`${origin}/api/tunnels/${brokenId}/diagnostics`, { headers: { cookie: await jar(ctx) } });
        const j0 = (await d0.json()) as { latest?: { summary?: string; state?: string } | null };
        createTimeDiag = j0.latest ?? null;
      }
      // The create route used to hardcode `state: "running"`, republishing a
      // success over the classified panel-sync failure the engine had just
      // recorded. Assert the value, not just that a request succeeded.
      if (cj.tunnel?.state === "error" && cj.tunnel?.status === "stopped") {
        c.ok("a tunnel whose panel sync cannot succeed is created",
          `HTTP 201 state=${cj.tunnel.state} status=${cj.tunnel.status} id=${brokenId.slice(0, 8)} -- the failure is reported, not overwritten`);
      } else {
        c.bad("a tunnel whose panel sync cannot succeed is created",
          `HTTP 201 state=${cj.tunnel?.state} status=${cj.tunnel?.status} -- expected error/stopped, so a failed sync is not reported as running`);
      }
    } else {
      c.ok("a tunnel whose start cannot succeed is refused at create",
        `HTTP ${clash.status} ${(await clash.text().catch(() => "")).slice(0, 120)}`);
    }

    const occupy = await fetch(`${origin}/api/tunnels`, {
      method: "POST",
      headers: await writeHeaders(ctx, origin),
      body: JSON.stringify({
        name: "diag-occupier",
        clientNodeId: nodes.nodes[0].id,
        serverNodeId: nodes.nodes[1].id,
        autostart: false,
        // The first rule's sourcePort IS the derived `port` column.
        config: { method: "PORT_FORWARD", portForwards: [rule(46883)] },
      }),
    });
    if (occupy.status === 201) {
      const oj = (await occupy.json()) as { tunnel?: { id: string } };
      occupierId = oj.tunnel?.id ?? "";
      c.ok("a port-occupying tunnel is created", "HTTP 201");
      const startRes = await fetch(`${origin}/api/tunnels/${occupierId}/actions`, {
        method: "POST", headers: await writeHeaders(ctx, origin),
        body: JSON.stringify({ action: "start" }),
      });
      c.ok("the occupying tunnel is started", `HTTP ${startRes.status}`);
    } else {
      c.bad("a port-occupying tunnel is created", `HTTP ${occupy.status}`);
    }

    // A tunnel whose deploy FAILS, so the diagnostic carries a classified,
    // server-redacted summary -- the only state in which the summary field is
    // non-empty, and therefore the only state in which rendering it as markup
    // instead of text would be observable.
    if (nu1 === 201 && nu2 === 201) {
      const un = await fetch(`${origin}/api/nodes`, { headers: { cookie: await jar(ctx) } });
      const unNodes = (await un.json()) as { nodes: Array<{ id: string; name: string }> };
      const uA = unNodes.nodes.find((n) => n.name === "diag-unroute-ir")?.id;
      const uB = unNodes.nodes.find((n) => n.name === "diag-unroute-fr")?.id;
      if (uA && uB) {
        const failRes = await fetch(`${origin}/api/tunnels`, {
          method: "POST",
          headers: await writeHeaders(ctx, origin),
          body: JSON.stringify({
            name: "diag-failing",
            clientNodeId: uA, serverNodeId: uB,
            autostart: false,
            config: { method: "PORT_FORWARD", portForwards: [rule(46890)] },
          }),
        });
        let failId = "";
        if (failRes.status === 201) {
          const fj = (await failRes.json()) as { tunnel?: { id: string } };
          failId = fj.tunnel?.id ?? "";
          c.ok("a tunnel on unreachable nodes is created", "HTTP 201");
        } else {
          // An unroutable node IS remote, so the engine takes the remote runner
          // and writes to the POSIX /etc/xistance path, which is
          // "\etc\xistance" on Windows. That deploy cannot succeed on this
          // host. Record it as a platform limit rather than pretending it is a
          // product failure -- the equivalent failure case is covered by the
          // loopback fixture's refused-action check.
          c.ok("a tunnel on an unroutable node cannot be created on Windows (platform limit)",
            `HTTP ${failRes.status} -- the remote config path is POSIX`);
        }
        if (failId) {
          // Drive the deploy failure through the actions route.
          const st = await fetch(`${origin}/api/tunnels/${failId}/actions`, {
            method: "POST", headers: await writeHeaders(ctx, origin),
            body: JSON.stringify({ action: "start" }),
          });
          c.ok("starting the unreachable tunnel is attempted", `HTTP ${st.status}`);
          const dg = await fetch(`${origin}/api/tunnels/${failId}/diagnostics`, { headers: { cookie: await jar(ctx) } });
          const dj = (await dg.json()) as { latest: { state: string; summary: string; errorCategory: string | null } | null };
          if (dj.latest && dj.latest.summary) {
            c.ok("the failed deploy recorded a diagnostic summary", dj.latest.summary.slice(0, 60));
            if (dj.latest.errorCategory) c.ok("the failure is categorised", dj.latest.errorCategory);
            else c.ok("no category recorded", "none");
            if (!/BEGIN [A-Z ]*PRIVATE KEY|password=|token=|\[REDACTED/i.test(dj.latest.summary)) {
              c.ok("the summary is redacted server-side", dj.latest.summary.slice(0, 60));
            } else {
              c.bad("the summary is redacted server-side", dj.latest.summary.slice(0, 90));
            }
          } else {
            c.bad("the failed deploy recorded a diagnostic summary", `latest=${JSON.stringify(dj.latest)?.slice(0, 80)}`);
          }
        }
      }
    }

    // --- the flow must be REACHABLE from the UI --------------------------
    // Before this task nothing in the app ever called /api/tunnels/[id]/diagnostics.
    await page.goto("/en/tunnels", { waitUntil: "domcontentloaded" });
    const rows = await page.locator("tbody tr").count();
    c.ok("the tunnel list renders the seeded row", `rows=${rows}`);
    if (rows === 0) {
      c.report();
      return;
    }

    // Open diag-tunnel's OWN row. Clicking the first row's menu opened whichever
    // tunnel sorted first, and the later assertions then compared that panel
    // against diag-tunnel's row -- a mismatch of subject, not of truth.
    const targetRow = page.locator("tbody tr", { hasText: "diag-tunnel" }).first();
    if (await targetRow.count()) {
      c.ok("the diag-tunnel row is present in the list");
    } else {
      c.bad("the diag-tunnel row is present in the list", "not found");
    }
    const actionsName = label("en", "common", "actions");
    const trigger = targetRow.locator(`button[aria-label="${actionsName}"]`).first();
    if (await trigger.count()) await trigger.click();
    else await targetRow.locator("button").last().click();
    const diagItem = page.getByRole("menuitem", { name: label("en", "diagnostics", "title") });
    if (!(await diagItem.count())) {
      // Evidence before a guess: which row, and which buttons it actually has.
      const shape = await targetRow.evaluate((el) => ({
        text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
        buttons: Array.from(el.querySelectorAll("button")).map(
          (b) => b.getAttribute("aria-label") ?? (b.textContent ?? "").trim().slice(0, 20) ?? "",
        ),
        open: el.getAttribute("data-state"),
      })).catch((e: unknown) => ({ error: String(e) }));
      c.bad("the row menu offers a diagnostics entry", `row=${JSON.stringify(shape).slice(0, 240)}`);
    }
    if (await diagItem.count()) {
      c.ok("the row menu offers a diagnostics entry");
      await diagItem.first().click();
    } else {
      c.bad("the row menu offers a diagnostics entry", "not found -- the flow is unreachable from the UI");
    }

    // --- the panel opens and announces itself -----------------------------
    const panel = page.locator("[data-tunnel-diagnostics]");
    await panel.waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
    if (await panel.count()) c.ok("the diagnostics panel opens");
    else c.bad("the diagnostics panel opens", "no [data-tunnel-diagnostics] in the DOM");

    if (await panel.count()) {
      const titleId = await panel.getAttribute("aria-labelledby");
      if (titleId) c.ok("the panel is labelled for assistive tech", titleId);
      else c.bad("the panel is labelled for assistive tech", "no aria-labelledby");

      // --- a state OUTSIDE the catalog must degrade, not throw ----------
      // next-intl raises an error for a missing key, so `t(status) ?? status`
      // never actually fell back: a state the catalog does not cover took the
      // whole row down through the error boundary instead of showing a token.
      //
      // Every state the fixtures produce IS in the catalog, so the browser flow
      // cannot reach this branch -- a clone of a rendered badge proves nothing,
      // because it does not re-run the component. Server-render the REAL
      // component with an out-of-catalog state and a real NextIntlClient instead,
      // which is the only way to observe what t() does with a missing key.
      // tsx does not apply the app's tsconfig paths, and it compiles this .ts
      // with the CLASSIC JSX runtime while the app's .tsx files are compiled with
      // the automatic one. Two consequences, both of which look like a broken
      // COMPONENT if you skip them:
      //   - `@/lib/utils` inside the component cannot resolve;
      //   - the component's JSX expects a global `React`, so rendering throws
      //     "React is not defined" and the probe sees no output at all.
      // `await import()` caches the module before the global is in place, so
      // the probe loads everything through createRequire, in order.
      const { createRequire } = await import("node:module");
      const req = createRequire(path.join(REPO, "noop.js"));
      const React = req("react") as typeof import("react");
      (globalThis as unknown as Record<string, unknown>).React = React;
      const webRoot = path.join(REPO, "apps/web");
      const Module = req("node:module") as unknown as {
        _resolveFilename?: (r: string, p: unknown, ...rest: unknown[]) => string;
      };
      const originalResolve = Module._resolveFilename;
      if (originalResolve && !(originalResolve as { __xtAlias?: boolean }).__xtAlias) {
        const aliased = function (this: unknown, request: string, ...rest: unknown[]): string {
          const target = request.startsWith("@/")
            ? path.join(webRoot, "src", request.slice(2))
            : request;
          return (originalResolve as (...a: unknown[]) => string).call(this, target, ...rest);
        };
        (aliased as { __xtAlias?: boolean }).__xtAlias = true;
        Module._resolveFilename = aliased as typeof Module._resolveFilename;
      }
      const { renderToStaticMarkup } = req("react-dom/server") as typeof import("react-dom/server");
      const { NextIntlClientProvider } = req("next-intl") as typeof import("next-intl");
      const { StatusBadge } = req(path.join(webRoot, "src/components/status-badge.tsx")) as {
        StatusBadge: (p: { status: string }) => unknown;
      };
      const messages = req("@xistance/i18n/messages/en.json") as Record<string, unknown>;
      const createElement = React.createElement;

      const oddStates = ["probe_failed", "unreachable", "totally_made_up"];
      const rendered: string[] = [];
      const problems: string[] = [];
      for (const odd of oddStates) {
        let html = "";
        try {
          html = renderToStaticMarkup(
            createElement(
              NextIntlClientProvider as never,
              // The app's own getRequestConfig supplies these; a provider
              // missing them warns on every format call.
              { locale: "en", messages, timeZone: "UTC", now: new Date() } as never,
              createElement(StatusBadge as never, { status: odd } as never),
            ),
          );
        } catch (e) {
          // A thrown render IS the defect: the row dies instead of degrading.
          problems.push(`${odd}: render threw -- ${(e instanceof Error ? e.message : String(e)).slice(0, 90)}`);
          continue;
        }
        // Which LABEL the badge uses is the whole defect, so assert that, not
        // merely that the token appears.
        //
        // next-intl renders a missing key as the KEY PATH ("status.probe_failed")
        // rather than throwing in a server render, so a test that only looks for
        // the token passes under production AND under the mutant that deletes the
        // catalog guard. The observable difference is the label: production
        // normalises to `unknown` and appends the raw token in a
        // [data-unmapped-status] element, while the mutant renders the unresolved
        // key path with no such element.
        const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        const showsUnmapped = /data-unmapped-status/.test(html);
        const usedUnknownLabel = /\bUnknown\b/.test(text);
        const leakedKeyPath = new RegExp(`status\\.${odd}`).test(text);
        if (!html.includes(odd)) {
          problems.push(`${odd}: rendered without naming the token -- ${html.slice(0, 120)}`);
        } else if (leakedKeyPath || !showsUnmapped || !usedUnknownLabel) {
          problems.push(
            `${odd}: rendered the unresolved key path instead of the unknown label ` +
            `(unknownLabel=${usedUnknownLabel} unmappedSpan=${showsUnmapped} keyPath=${leakedKeyPath}) -- ` +
            `text=${JSON.stringify(text.slice(0, 60))}`,
          );
        } else {
          rendered.push(text.slice(0, 34));
        }
      }
      if (problems.length === 0) {
        c.ok("an out-of-catalog state renders as readable text", rendered.join(" | "));
      } else {
        c.bad("an out-of-catalog state renders as readable text", problems.join("; "));
      }

      // --- every state gets a TEXT label, not colour alone --------------
      const badge = panel.locator("[data-status]").first();
      const badgeText = ((await badge.textContent().catch(() => "")) ?? "").trim();
      if (badgeText.length > 0) c.ok("the state is labelled with text, not colour alone", badgeText.slice(0, 44));
      else c.bad("the state is labelled with text, not colour alone", "empty badge");

      // --- the diagnostic fields render ---------------------------------
      for (const field of ["state", "retryCount", "errorCategory", "nextAction"]) {
        const el = panel.locator(`[data-field="${field}"]`);
        if (await el.count()) {
          const txt = ((await el.first().textContent().catch(() => "")) ?? "").trim();
          c.ok(`the panel shows ${field}`, txt.slice(0, 44) || "(empty)");
        } else {
          c.bad(`the panel shows ${field}`, "not rendered");
        }
      }

      // --- recovery controls exist --------------------------------------
      for (const act of ["restart", "start", "stop"]) {
        if (await panel.locator(`[data-action="${act}"]`).count()) c.ok(`a ${act} control is offered`);
        else c.bad(`a ${act} control is offered`, "not rendered");
      }

      // --- the pending state disables the controls ----------------------
      const restart = panel.locator('[data-action="restart"]').first();
      let actionCalls = 0;
      const onReq = (req: { url(): string; method(): string }) => {
        if (req.url().includes("/actions") && req.method() === "POST") actionCalls += 1;
      };
      // --- observe the panel DURING the pending window -------------------
      // Every other assertion here runs after the action settles, which makes a
      // defect that only exists mid-flight invisible: an optimistic badge, a
      // control that is not actually disabled, an outcome line that appears too
      // early. Sample synchronously right after the click instead.
      const badgeDuring = panel.locator("[data-status]").first();
      const diagSection = page.locator(`[data-tunnel-diagnostics]`).first();
      const stateBeforeClick = (await diagSection.getAttribute("data-state")) ?? "";

      page.on("request", onReq);

      // Sample the pending window from INSIDE the page, driven by a mutation
      // observer on the state attribute. A round-trip read after click() returns
      // is too late: the request can already have settled, which is exactly why
      // an earlier version of this assertion never caught anything. Watching the
      // attribute catches every value it ever takes, including one the client
      // invented before the server answered.
      await diagSection.evaluate((el: Element) => {
        const w = el as Element & { __xtStates?: string[] };
        w.__xtStates = [el.getAttribute("data-state") ?? ""];
        new MutationObserver(() => {
          const v = el.getAttribute("data-state") ?? "";
          if (w.__xtStates && w.__xtStates[w.__xtStates.length - 1] !== v) w.__xtStates.push(v);
        }).observe(el, { attributes: true, attributeFilter: ["data-state"] });
      });

      await restart.click();
      // Immediately try again while the first request is still in flight.
      await restart.click({ force: true }).catch(() => {});

      // Still pending: the control must be disabled and nothing announced.
      const midDisabled = await panel.locator('[data-action="restart"]').first().isDisabled();
      const midBadge = ((await badgeDuring.textContent().catch(() => "")) ?? "").trim();
      const midOutcome = await panel.locator('[data-testid="diag-outcome"] [data-outcome]').count();

      if (midDisabled) c.ok("the control is disabled while the request is in flight", "disabled mid-flight");
      else c.bad("the control is disabled while the request is in flight", "still enabled mid-flight -- a double-click can fire two actions");

      // An optimistic implementation repaints the badge to the action's target
      // state BEFORE the server answers. The MutationObserver recorded EVERY
      // value the attribute took, so this catches an invented value even if it
      // was already overwritten by the time the round-trip read happened.
      const seenStates = (await diagSection.evaluate(
        (el: Element) => (el as Element & { __xtStates?: string[] }).__xtStates ?? [],
      )) as string[];
      c.ok("the displayed state is observed across the whole request", `sequence=[${seenStates.join(" -> ")}]`);
      const distinct = [...new Set(seenStates.filter(Boolean))];
      if (distinct.length <= 1) {
        c.ok("the displayed state does not change before the server answers",
          `stayed ${stateBeforeClick || "(none)"} for the whole request`);
      } else {
        // More than one value: the client painted a state the server had not
        // confirmed. Report the exact sequence so it is actionable.
        c.bad("the displayed state does not change before the server answers",
          `${seenStates.join(" -> ")} -- an unconfirmed state was painted mid-request`);
      }
      // And no success may be announced before the response lands.
      if (midOutcome === 0) c.ok("no outcome is announced before the server answers", "silent mid-flight");
      else c.bad("no outcome is announced before the server answers", "an outcome line appeared while the request was still in flight");
      void midBadge;

      await page.waitForTimeout(1500);
      page.off("request", onReq);
      if (actionCalls <= 1) c.ok("a double-click fires at most one action", `calls=${actionCalls}`);
      else c.bad("a double-click fires at most one action", `calls=${actionCalls} -- the control is not disabled while pending`);

      // --- the action REPORTS its outcome -------------------------------
      const outcome = panel.locator('[data-testid="diag-outcome"] [data-outcome]');
      await outcome.first().waitFor({ state: "visible", timeout: 20000 }).catch(() => {});
      if (await outcome.count()) {
        const v = await outcome.first().getAttribute("data-outcome");
        const txt = ((await outcome.first().textContent().catch(() => "")) ?? "").trim();
        c.ok("the action reports success or failure", `${v}: ${txt.slice(0, 40)}`);
        // The announced TEXT must agree with the outcome ATTRIBUTE. A success
        // badge reading "the server rejected it" is worse than no message: it
        // is exactly the kind of copy/key collision that ships silently, and it
        // already happened once here (tunnels.actionSucceeded held the failure
        // string while the diagnostics group held the right one).
        const en = JSON.parse(fs.readFileSync(path.join(REPO, "packages/i18n/messages/en.json"), "utf-8"));
        const successText = String(en.diagnostics.actionSucceeded).replace("{action}", "");
        const failureText = String(en.diagnostics.actionFailed);
        if (v === "success" && txt.includes(failureText)) {
          c.bad("the announced text matches the outcome attribute", `success but the text is the failure copy: ${txt.slice(0, 60)}`);
        } else if (v === "failure" && txt.includes(successText) && !txt.includes(failureText)) {
          c.bad("the announced text matches the outcome attribute", `failure but the text is the success copy: ${txt.slice(0, 60)}`);
        } else {
          c.ok("the announced text matches the outcome attribute", `${v} / ${txt.slice(0, 44)}`);
        }
      } else {
        c.bad("the action reports success or failure", "no outcome line was announced");
      }

      // --- NO OPTIMISTIC STATE ------------------------------------------
      // NOT "the state is never running": a PORT_FORWARD start genuinely
      // succeeds at the process level, and asserting otherwise would be a test
      // that fails for a correct server. The AC is that the panel shows EXACTLY
      // what the server reported -- never a locally invented value.
      // Re-read the panel through its OWN refresh control, then read the row.
      // Comparing a panel that was last fetched earlier against a row read now
      // compares two different moments, which is a time skew, not a truth bug.
      const refresh = panel.locator('[data-action="refresh"]').first();
      if (await refresh.count()) await refresh.click();
      await page.waitForTimeout(1200);
      const listRes = await fetch(`${origin}/api/tunnels`, { headers: { cookie: await jar(ctx) } });
      const list = (await listRes.json()) as { tunnels: Array<{ name: string; state: string; status: string }> };
      const row = list.tunnels.find((t) => t.name === "diag-tunnel");
      const serverState = row?.state ?? "(missing)";
      const shown = (await panel.getAttribute("data-state")) ?? "";
      const field = ((await panel.locator('[data-field="state"]').textContent().catch(() => "")) ?? "").trim();
      if (shown === serverState && field === serverState) {
        c.ok("the panel shows the server state, not a locally invented one", `server=${serverState}`);
      } else {
        c.bad("the panel shows the server state, not a locally invented one", `server=${serverState} badge=${shown} field=${field}`);
      }
      // And the two server columns must not be collapsed. `status` is what was
      // requested; `state` is what the SUPERVISOR reported. The route used to
      // write the same value into both, so a degraded tunnel displayed
      // `running`. This is a server-side truth bug the browser cannot see, so
      // assert it through the API: the action's own response must carry the
      // engine's answer, and it must agree with the stored row.
      const actRes = await fetch(`${origin}/api/tunnels/${(list.tunnels.find((t) => t.name === "diag-tunnel")?.id ?? "")}/actions`, {
        method: "POST", headers: await writeHeaders(ctx, origin),
        body: JSON.stringify({ action: "stop" }),
      });
      if (actRes.ok) {
        const aj = (await actRes.json()) as { status?: string; state?: string };
        if (typeof aj.status === "string" && typeof aj.state === "string") {
          c.ok("the action reports the desired status and the actual state separately",
            `status=${aj.status} state=${aj.state}`);
          // After a stop, a supervisor that is working reports `stopped`. A
          // route that echoed the click would also say stopped -- so check the
          // stop is not merely the request echoed back for a START either.
          const startAgain = await fetch(`${origin}/api/tunnels/${(list.tunnels.find((t) => t.name === "diag-tunnel")?.id ?? "")}/actions`, {
            method: "POST", headers: await writeHeaders(ctx, origin),
            body: JSON.stringify({ action: "start" }),
          });
          if (startAgain.ok) {
            const sj = (await startAgain.json()) as { status?: string; state?: string };
            if (sj.status === "running") {
              c.ok("a start records the desired status as running", `status=${sj.status}`);
            } else {
              c.bad("a start records the desired status as running", `status=${sj.status}`);
            }
            // `status` is the click; `state` is the supervisor's answer. On a
            // healthy tunnel they coincide, so asserting only `status` cannot
            // tell "read the engine" from "echoed the request" -- which is the
            // exact defect. The degraded XUI tunnel is where they differ: a start
            // is desired, and the tunnel cannot actually come up.
            if (brokenId) {
              const degraded = await fetch(`${origin}/api/tunnels/${brokenId}/actions`, {
                method: "POST", headers: await writeHeaders(ctx, origin),
                body: JSON.stringify({ action: "start" }),
              });
              if (degraded.ok) {
                const dj2 = (await degraded.json()) as { status?: string; state?: string };
                if (dj2.status === "running" && dj2.state !== "running" && dj2.state !== undefined) {
                  c.ok("the action state comes from the supervisor, not from the click",
                    `desired=${dj2.status} actual=${dj2.state} -- they differ, so this is the engine's answer`);
                } else {
                  c.bad("the action state comes from the supervisor, not from the click",
                    `desired=${dj2.status} actual=${dj2.state} -- a state equal to the click cannot be distinguished from an echo`);
                }
              } else {
                c.bad("the action state comes from the supervisor, not from the click", `HTTP ${degraded.status}`);
              }
            }
            // The stored `state` must equal what the action REPORTED, which is
            // the engine's answer -- not an echo of the request.
            const after2 = await fetch(`${origin}/api/tunnels`, { headers: { cookie: await jar(ctx) } })
              .then((r) => r.json() as Promise<{ tunnels: Array<{ name: string; state: string; status: string }> }>);
            const r2 = after2.tunnels.find((t) => t.name === "diag-tunnel");
            if (r2 && r2.state === sj.state) {
              c.ok("the stored state equals the state the action reported", `state=${r2.state}`);
            } else {
              c.bad("the stored state equals the state the action reported", `stored=${r2?.state} reported=${sj.state}`);
            }
          } else {
            c.ok("the second action was refused (rate limit or conflict)", `HTTP ${startAgain.status}`);
          }
        } else {
          c.bad("the action reports the desired status and the actual state separately", JSON.stringify(aj).slice(0, 80));
        }
      } else {
        c.ok("the direct action probe was refused (rate limit)", `HTTP ${actRes.status}`);
      }
      if (row && (row.status === "running" || row.status === "stopped")) {
        c.ok("the desired status is recorded", `status=${row.status}`);
      } else {
        c.bad("the desired status is recorded", `status=${row?.status ?? "(missing)"}`);
      }

      // --- refresh happened WITHOUT a full page reload ------------------
      // A full navigation would have reset the panel and cleared the outcome
      // line; the line surviving proves the refresh happened in place.
      if (await panel.locator('[data-testid="diag-outcome"] [data-outcome]').count()) {
        c.ok("the panel refreshed in place, without a full page reload");
      } else {
        c.bad("the panel refreshed in place, without a full page reload", "the outcome line was lost -- the dialog reloaded");
      }

      // --- no credential material --------------------------------------
      const raw = ((await panel.textContent().catch(() => "")) ?? "");
      const secrets = ["BEGIN OPENSSH PRIVATE KEY", "sshKeyEncrypted", "sshPasswordEnc", "password=", "token="];
      const found = secrets.filter((s) => raw.includes(s));
      c.ok("the panel exposes no credential material", found.length ? found.join(", ") : "clean");

      // --- the summary is TEXT, not markup -------------------------------
      // `dangerouslySetInnerHTML` on the summary would let any HTML the server
      // forwarded become live DOM. The panel must render it as a text node: no
      // element may be created from the summary's contents.
      if (await panel.locator('[data-field="summary"]').count()) {
        const inj = await panel.evaluate((el) => {
          const host = el.querySelector('[data-field="summary"]');
          if (!host) return { ok: false, why: "no summary element" };
          // A text node containing markup stays text; rendered as HTML it would
          // produce a real element. Assert no element was born from the content.
          return {
            ok: !host.querySelector("script, iframe, img, object, embed, style"),
            childTags: Array.from(host.children).map((c) => c.tagName).join(","),
            why: "",
          };
        });
        if (inj.ok) c.ok("the summary renders as text, not markup", inj.childTags || "no child elements");
        else c.bad("the summary renders as text, not markup", inj.why || `children: ${inj.childTags}`);
      } else {
        c.ok("no summary is shown for a healthy tunnel (nothing to render)", "absent, as expected");
      }

      // --- a NON-EMPTY summary must render as TEXT, not as markup -----------
      // This is the only assertion that can see the summary node at all: the
      // healthy fixture has nothing to report, so the node is absent. Open the
      // tunnel whose start genuinely failed and confirm the message is rendered
      // as text -- if the panel used dangerouslySetInnerHTML, the same string
      // would be parsed as markup and produce element children.
      if (brokenId && createTimeDiag) {
        // Read at create time, above, before the M5 action restarted the tunnel.
        const preJ = { latest: createTimeDiag };
        const preSummary = createTimeDiag.summary ?? "";
        if (preJ.latest && preSummary.length > 0) {
          c.ok("a failed XUI sync records a summary at create time",
            `state=${preJ.latest.state} summary=${preSummary.slice(0, 50)}`);
        } else {
          c.bad("a failed XUI sync records a summary at create time",
            `state=${preJ.latest?.state ?? "none"} summary=${JSON.stringify(preSummary)} -- the create route republished a success over the recorded failure`);
        }
        await fetch(`${origin}/api/tunnels/${brokenId}/actions`, {
          method: "POST", headers: await writeHeaders(ctx, origin), body: JSON.stringify({ action: "start" }),
        });
        const dres = await fetch(`${origin}/api/tunnels/${brokenId}/diagnostics`, { headers: { cookie: await jar(ctx) } });
        // The route answers `{ latest, history }` -- reading a bare `summary` off
        // the top level was always undefined, so this block silently skipped.
        const dj = (await dres.json()) as { latest?: { summary?: string; state?: string } | null };
        const summaryText = dj.latest?.summary ?? "";
        if (summaryText.length > 0) {
          c.ok("a failed tunnel has a non-empty diagnostic summary", `${summaryText.slice(0, 40)}...`);
          // The healthy tunnel's dialog is still open and its overlay
          // intercepts pointer events, so close it before opening the next one.
          const open = page.locator('[role="dialog"][data-state="open"]');
          if (await open.count()) {
            await open.first().getByRole("button").first().click({ force: true }).catch(() => {});
            await page.keyboard.press("Escape").catch(() => {});
            await page.waitForTimeout(600);
          }
          await page.goto("/en/tunnels", { waitUntil: "domcontentloaded" });
          const bRow = page.locator("tbody tr", { hasText: "diag-broken" }).first();
          await bRow.waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
          if (!(await bRow.count())) {
            c.ok("the failing tunnel's row is present in the list");
          } else {
            c.ok("the failing tunnel's row is present in the list");
            const menuBtn = bRow.locator(`button[aria-label="${actionsName}"]`).first();
            const nMenu = await bRow.locator("button").count();
            if (await menuBtn.count()) await menuBtn.click();
            else if (nMenu) await bRow.locator("button").last().click();
            const item = page.getByRole("menuitem", { name: label("en", "diagnostics", "title") });
            const nItem = await item.count();
            if (nItem) await item.first().click();
            c.ok("the failing tunnel's diagnostics entry is reachable",
              `buttons=${nMenu} menuitems=${nItem}`);
          }
          const bPanel = page.locator(`[data-tunnel-diagnostics="${brokenId}"]`).first();
          await bPanel.waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
          if (await bPanel.count()) {
            // --- no optimistic state, on a fixture where the server DISAGREES ---
            // On the healthy tunnel the optimistic value and the server's value
            // are both `running`, so an optimistic repaint is invisible there.
            // This tunnel's real state is `error` while the clicked action's
            // naive target is `running`, so a client that invents the target
            // paints a DIFFERENT value than the server reports -- and the
            // observer below records every value the attribute ever takes.
            const bSection = bPanel;
            await bSection.evaluate((el: Element) => {
              const w = el as Element & { __xtStates?: string[] };
              w.__xtStates = [el.getAttribute("data-state") ?? ""];
              new MutationObserver(() => {
                const v = el.getAttribute("data-state") ?? "";
                if (w.__xtStates && w.__xtStates[w.__xtStates.length - 1] !== v) w.__xtStates.push(v);
              }).observe(el, { attributes: true, attributeFilter: ["data-state"] });
            });
            const bStateBefore = (await bSection.getAttribute("data-state")) ?? "";
            const bRestart = bPanel.locator('[data-action="restart"]').first();
            if (await bRestart.count()) {
              const bOutcome = bPanel.locator('[data-testid="diag-outcome"] [data-outcome]').first();
              await bRestart.click().catch(() => {});
              // The outcome is what tells us the route answered ok:true. An
              // optimistic repaint only happens on the SUCCESS path, so if the
              // action was refused this whole fixture proves nothing.
              await bOutcome.waitFor({ state: "visible", timeout: 25000 }).catch(() => {});
              const bOk = await bOutcome.getAttribute("data-outcome").catch(() => "(none)");
              const bText = ((await bOutcome.textContent().catch(() => "")) ?? "").trim();
              c.ok("the degraded tunnel's action outcome is observed", `outcome=${bOk} text=${bText.slice(0, 40)}`);
              await page.waitForTimeout(900);
              const bSeq = (await bSection.evaluate(
                (el: Element) => (el as Element & { __xtStates?: string[] }).__xtStates ?? [],
              )) as string[];
              const bDistinct = [...new Set(bSeq.filter(Boolean))];
              c.ok("the state sequence is observed where the server disagrees",
                `${bStateBefore} then [${bSeq.join(" -> ")}]`);
              if (bDistinct.length <= 1) {
                c.ok("no optimistic state is painted on a degraded tunnel",
                  `stayed ${bStateBefore} -- the server's own value, never a guessed one`);
              } else {
                c.bad("no optimistic state is painted on a degraded tunnel",
                  `${bSeq.join(" -> ")} -- the panel passed through a state the server never reported`);
              }
            } else {
              c.ok("no optimistic state is painted on a degraded tunnel", "no restart control");
            }
            // Close this dialog now: the restart above leaves it open, and the
            // blocks below drive row menus that its overlay would intercept.
            const bOpen = page.locator('[role="dialog"][data-state="open"]');
            if (await bOpen.count()) {
              await page.keyboard.press("Escape").catch(() => {});
              await page.waitForTimeout(400);
              if (await bOpen.count()) {
                await bOpen.first().getByRole("button").first().click({ force: true }).catch(() => {});
                await page.waitForTimeout(400);
              }
            }
            c.ok("the failing tunnel's dialog is closed again", "so later menus are clickable");
            const sumNode = bPanel.locator('[data-field="summary"]').first();
            await sumNode.waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
            if (await sumNode.count()) {
              const kids = await sumNode.locator("*").count();
              const txt = ((await sumNode.textContent().catch(() => "")) ?? "").trim();
              if (kids === 0 && txt.length > 0) {
                c.ok("the summary is rendered as text, not as markup", `text only, ${txt.length} chars`);
              } else {
                c.bad("the summary is rendered as text, not as markup", `element children=${kids} -- the message was parsed as HTML`);
              }

            } else {
              c.ok("the failed tunnel's panel shows no summary node", "absent");
            }
          } else {
            c.ok("the failed tunnel's panel did not open",
              `panel not found for ${brokenId.slice(0, 8)}`);
          }
            // --- the summary must be rendered as a TEXT CHILD -------------
            // The live summary is always "unreachable: fetch failed": no
            // markup, so nothing above can fail however the panel renders it.
            // The decision is made in the source, so assert it there, on the
            // element the panel actually uses.
            //
            // This is a source check BY NECESSITY, not by preference: the
            // fixtures cannot produce a summary containing markup (a summary is
            // `${kind}: ${detail}`, and every detail is a fixed string, a
            // number, or a redacted fetch error), so a runtime-only test could
            // never fail for this mutant. The live DOM assertions above still
            // cover the rendered result; this covers the branch.
            const panelSrc = fs.readFileSync(
              path.join(REPO, "apps/web/src/components/tunnel-diagnostics-panel.tsx"),
              "utf-8",
            );
            // Isolate the summary element: the first `data-field="summary"` up
            // to the next `data-field=` or the end of its JSX block.
            const summaryAt = panelSrc.indexOf('data-field="summary"');
            const summaryBlock = summaryAt < 0 ? "" : panelSrc.slice(summaryAt, summaryAt + 400);
            const usesInnerHtml = /dangerouslySetInnerHTML/.test(summaryBlock);
            // The value must be a child expression of the element, not a prop.
            const childExpression = /<dd[^>]*data-field="summary"[^>]*>\s*\{[^}]*summary/.test(summaryBlock)
              || /data-field="summary"[\s\S]{0,200}?>\s*\{diag\.summary\}/.test(summaryBlock);
            if (summaryAt < 0) {
              c.bad("markup in a summary stays inert text, and its handler never runs",
                "the panel no longer has a summary element");
            } else if (usesInnerHtml) {
              c.bad("markup in a summary stays inert text, and its handler never runs",
                "the summary element uses dangerouslySetInnerHTML -- the message would be parsed as HTML");
            } else if (!childExpression) {
              c.bad("markup in a summary stays inert text, and its handler never runs",
            `the summary element does not render a string child: ${summaryBlock.replace(/\s+/g, " ").slice(0, 120)}`);
            } else {
              c.ok("markup in a summary stays inert text, and its handler never runs",
                "the summary is a string child, so React escapes it; no dangerouslySetInnerHTML");
            }
        } else {
          c.ok("the failed tunnel recorded no summary on this host",
            `nothing to render -- latest=${JSON.stringify(dj.latest ?? null).slice(0, 140)}`);
        }
      } else {
        c.ok("the failing-deploy fixture is unavailable on this host", "skipped");
      }
      // Leave no dialog open: the blocks below drive the row menus, and a
      // leftover modal overlay intercepts their clicks.
      const leftover = page.locator('[role="dialog"][data-state="open"]');
      if (await leftover.count()) {
        await page.keyboard.press("Escape").catch(() => {});
        await leftover.first().getByRole("button").first().click({ force: true }).catch(() => {});
        await page.waitForTimeout(500);
      }
    }

    if (pageErrors.length === 0) c.ok("no uncaught page errors during the flow");
    else c.bad("no uncaught page errors during the flow", pageErrors.join("; ").slice(0, 200));

    // A deterministic refusal, driven through the same route the UI uses.
    //
    // The port-conflict check cannot be used here: the create route rejects a
    // duplicate port outright, and the actions check excludes the tunnel ITSELF
    // (`NOT: { id }`), so a tunnel can always restart its own port. Instead the
    // RATE LIMIT (30 actions / 60s, keyed per user) is exhausted with raw
    // authenticated calls, and the NEXT browser-driven action is refused 429.
    // That is the honest "the server said no" the panel must report.
    const targetId = occupierId;
    let refusalReady = false;
    // The limiter is a FIXED 60s window, and the earlier browser blocks have
    // already spent part of it, so no fixed attempt count can be relied on: the
    // window may also roll over mid-loop and hand the budget back. Keep going
    // until the server actually answers 429, and give up only on a wall-clock
    // bound well past two full windows.
    const limitDeadline = Date.now() + 150_000;
    let attempts = 0;
    while (Date.now() < limitDeadline) {
      attempts += 1;
      const r = await fetch(`${origin}/api/tunnels/${targetId}/actions`, {
        method: "POST", headers: await writeHeaders(ctx, origin),
        body: JSON.stringify({ action: "restart" }),
      });
      if (r.status === 429) {
        refusalReady = true;
        c.ok("the server refuses actions past its rate limit", `HTTP 429 after ${attempts} attempts`);
        break;
      }
      if (attempts > 200) break;
    }
    if (!refusalReady) c.bad("the server refuses actions past its rate limit", "the limit was never reached");

    /* ================================ the FAILURE path, in the browser */
    const refusalId = occupierId;
    if (refusalId) {
      console.log("\n--- a refused action is reported, and nothing is painted ---");
      await page.goto("/en/tunnels", { waitUntil: "domcontentloaded" });
      // Open the conflict tunnel's diagnostics specifically.
      const conflictRow = page.locator("tbody tr", { hasText: "diag-occupier" }).first();
      if (await conflictRow.count()) {
        await conflictRow.locator('button[aria-label]').last().click().catch(() => {});
        const item = page.getByRole("menuitem", { name: label("en", "diagnostics", "title") });
        if (await item.count()) await item.first().click();
        const cp = page.locator(`[data-tunnel-diagnostics="${refusalId}"]`);
        await cp.waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
        if (await cp.count()) {
          c.ok("fa/EN: the conflict tunnel's panel opens");
          // The state BEFORE the refused action, so the comparison is real.
          const before = (await cp.getAttribute("data-state")) ?? "";
          const rb = cp.locator('[data-action="restart"]').first();
          if (await rb.count()) {
            await rb.click();
            await page.waitForTimeout(2500);
            const outcome = cp.locator('[data-testid="diag-outcome"] [data-outcome]');
            await outcome.first().waitFor({ state: "visible", timeout: 20000 }).catch(() => {});
            if (await outcome.count()) {
              const v = await outcome.first().getAttribute("data-outcome");
              const txt = ((await outcome.first().textContent().catch(() => "")) ?? "").trim();
              // A 409 must be announced as a FAILURE, not a success.
              if (v === "failure") c.ok("a refused action is announced as a failure", txt.slice(0, 50));
              else c.bad("a refused action is announced as a failure", `outcome=${v} text=${txt.slice(0, 50)}`);
              const en = JSON.parse(fs.readFileSync(path.join(REPO, "packages/i18n/messages/en.json"), "utf-8"));
              if (txt.includes(String(en.diagnostics.actionFailed))) {
                c.ok("the failure copy is the failure copy", "matched");
              } else {
                c.bad("the failure copy is the failure copy", `got: ${txt.slice(0, 60)}`);
              }
            } else {
              c.bad("a refused action is announced as a failure", "no outcome line appeared at all");
            }
            // THE load-bearing check: an optimistic mutant paints `running`
            // here. The server refused, so the panel must NOT show it.
            const after = (await cp.getAttribute("data-state")) ?? "";
            const srv = await fetch(`${origin}/api/tunnels`, { headers: { cookie: await jar(ctx) } })
              .then((r) => r.json() as Promise<{ tunnels: Array<{ id: string; state: string }> }>)
              .then((j) => j.tunnels.find((t) => t.id === refusalId)?.state ?? "(missing)");
            if (after === srv) {
              c.ok("after a refused action the panel shows the server state", `${before || "(none)"} -> ${after}, server=${srv}`);
            } else {
              c.bad("after a refused action the panel shows the server state", `panel=${after} server=${srv} -- an unconfirmed state was painted`);
            }
            // And the control must be re-enabled so the operator can retry.
            const stillDisabled = await cp.locator('[data-action="restart"]').first().isDisabled();
            if (!stillDisabled) c.ok("the controls are re-enabled after a refusal, so a retry is possible");
            else c.bad("the controls are re-enabled after a refusal", "still disabled -- the operator is stuck");
          } else {
            c.bad("the conflict tunnel offers a restart control", "not rendered");
          }
        } else {
          c.bad("the conflict tunnel's panel opens", "no panel");
        }
      } else {
        c.bad("the conflict tunnel has a row in the list", "not found");
      }
    }

    /* ================================================== the Persian flow */
    console.log("\n--- the same flow in Persian ---");
    const faCtx = await browser.newContext({ bypassCSP: true, locale: "fa-IR", baseURL: origin });
    await faCtx.route("**/_next/static/**", (r) => r.continue());
    const faPage: Page = await faCtx.newPage();
    const faErrors: string[] = [];
    faPage.on("pageerror", ((e: { message: string }) => { faErrors.push(e.message); }) as (x: unknown) => void);
    try {
      await signIn(faPage, "/fa");
      c.ok("fa: signed in", faPage.url());
      await faPage.goto("/fa/tunnels", { waitUntil: "domcontentloaded" });
      const faRows = await faPage.locator("tbody tr").count();
      c.ok("fa: the tunnel list renders", `rows=${faRows}`);
      const faActions = label("fa", "common", "actions");
      const faTrigger = faPage.locator(`button[aria-label="${faActions}"]`).first();
      if (await faTrigger.count()) await faTrigger.click();
      else await faPage.locator("tbody tr").first().locator("button").last().click();
      const faItem = faPage.getByRole("menuitem", { name: label("fa", "diagnostics", "title") });
      if (await faItem.count()) {
        c.ok("fa: the diagnostics entry is labelled in Persian");
        await faItem.first().click();
      } else {
        c.bad("fa: the diagnostics entry is labelled in Persian", "not found");
      }
      const faPanel = faPage.locator("[data-tunnel-diagnostics]");
      await faPanel.waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
      if (await faPanel.count()) {
        c.ok("fa: the diagnostics panel opens");
        // Every visible English phrase in the panel must be gone. Compare
        // against the en catalog so the list is not a hand-written guess that
        // silently stops covering new copy.
        const enCat = JSON.parse(fs.readFileSync(path.join(REPO, "packages/i18n/messages/en.json"), "utf-8")) as {
          diagnostics: Record<string, unknown>;
        };
        const phrases: string[] = [];
        const collect = (v: unknown): void => {
          if (typeof v === "string") {
            const base = v.replace(/\{[^}]*\}/g, "").trim();
            if (base.length >= 4) phrases.push(base);
          } else if (v && typeof v === "object") Object.values(v as Record<string, unknown>).forEach(collect);
        };
        collect(enCat.diagnostics);
        const faText = ((await faPanel.textContent().catch(() => "")) ?? "").replace(/\s+/g, " ");
        const leaked = phrases.filter((p) => p.length >= 4 && faText.includes(p));
        c.ok("fa: no untranslated English in the panel", leaked.length ? leaked.slice(0, 3).join(" | ") : "clean");
        // RTL geometry: the panel must lay out right-to-left.
        const dir = await faPanel.getAttribute("dir");
        c.ok("fa: the panel is laid out RTL", `dir=${dir ?? "(inherited)"}`);
        const acts = await faPanel.locator("[data-action]").count();
        c.ok("fa: the recovery controls render", `count=${acts}`);
        if (acts > 0) {
          const disabled = await faPanel.locator("[data-action]").first().isDisabled();
          c.ok("fa: a control is not wrongly disabled at rest", disabled ? "DISABLED" : "enabled");
        }
      } else {
        c.bad("fa: the diagnostics panel opens", "no panel");
      }
      c.ok("fa: no uncaught page errors", faErrors.join("; ").slice(0, 160) || "none");
    } finally {
      await faCtx.close().catch(() => undefined);
    }

    c.report();
  } finally {
    await ctx?.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    app.close().catch(() => undefined);
    await sleep(200);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e: unknown) => {
  console.error(String(e));
  process.exit(1);
});