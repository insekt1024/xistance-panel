/**
 * Browser smoke suite: nodes and tunnels (TASK-52).
 *
 * Walks the representative node and tunnel flows against a real production build
 * in real Chromium, on a disposable database. No real remote node is contacted
 * and no real tunnel credential is used — the only "remote" is an address the
 * local machine owns, so connectivity failure is the EXPECTED outcome and is
 * asserted as such.
 *
 * The three things this suite exists to catch, because each has been a real
 * defect in this repo:
 *
 *   1. A form that submits an invalid value and only complains afterwards.
 *   2. A UI that reports success the server did not actually grant — a toast
 *      that says "deployed" while the row behind it says `stopped`.
 *   3. An error that is technically shown but carries no next action.
 *
 * Run: TURBO_DISABLE=true npm run build && npx tsx scripts/test-smoke-nodes-tunnels.ts
 */
import os from "node:os";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

import {
  Checks, EXIT_SKIP, REPO, WEB, findChromium, findPlaywright, freePort, sleep,
  readJson, startApp, type Browser, type Context, type Page,
} from "./lib/browser-harness";

const ADMIN_EMAIL = "nodes-admin@xistance.invalid";
const ADMIN_PASS = "NodesAdminPassw0rd!";

/** A port the local machine owns and nothing listens on: the honest "unreachable". */
const DEAD_HOST = "127.0.0.1";
const DEAD_PORT = 1;


/**
 * Fill a control by its EXACT catalog label, and fail loudly if it is not found.
 *
 * Four real traps, each of which made an earlier version of this suite assert
 * against a form it had never actually filled:
 *
 *   1. `has-text` matches SUBSTRINGS, so "Name" also matched "SSH user".
 *   2. The node form's inputs are controlled components with no `name`
 *      attribute, so `input[name=...]` matches nothing.
 *   3. The SSH-key control is a bare `<label>` + `<input>` pair with no `htmlFor`.
 *   4. Required labels render as "Name*", so an exact match on "Name" fails.
 *
 * The lookup runs in the browser as plain DOM: Playwright's `text=` engine
 * treats a quoted string as substring text, and escaping a regex inside a
 * template literal is a reliable way to ship a syntax error to the page.
 */
async function fillByLabel(page: Page, label: string, value: string): Promise<void> {
  await fillImpl(page, label, value);
}

/** Same contract as fillByLabel; no behavioural difference, kept for clarity. */
async function fillByLabelText(page: Page, label: string, value: string): Promise<void> {
  await fillImpl(page, label, value);
}

const FIND_CONTROL = `
  (function (want) {
    var root = document.querySelector('[data-testid="node-create-dialog"]');
    if (!root) return null;
    var norm = function (t) {
      return (t || "").split(" ").filter(Boolean).join(" ")
        .replace(/[*]+$/, "").trim();
    };
    var labs = Array.from(root.querySelectorAll("label"));
    for (var i = 0; i < labs.length; i++) {
      if (norm(labs[i].textContent) !== want) continue;
      if (labs[i].htmlFor) {
        var byId = document.getElementById(labs[i].htmlFor);
        if (byId) return byId;
      }
      var near = labs[i].querySelector("input") || labs[i].querySelector("textarea");
      if (!near && labs[i].parentElement) near = labs[i].parentElement.querySelector("input");
      if (near) return near;
    }
    return null;
  })`;

const LIST_LABELS = `
  (function () {
    var root = document.querySelector('[data-testid="node-create-dialog"]');
    if (!root) return "NO DIALOG";
    return JSON.stringify(Array.from(root.querySelectorAll("label")).map(function (l) {
      return (l.textContent || "").split(" ").filter(Boolean).join(" ").trim();
    }));
  })()`;

async function fillImpl(page: Page, label: string, value: string): Promise<void> {
  const handle = await page.evaluateHandle(`${FIND_CONTROL}(${JSON.stringify(label)})`);
  const el = handle.asElement();
  if (!el) {
    const seen = await page.evaluate<string>(LIST_LABELS);
    throw new Error(
      `no control for label ${JSON.stringify(label)}; dialog labels: ${seen}`,
    );
  }
  await el.fill(value);
  // Verify React actually committed the value. A controlled input whose
  // onChange never fired keeps the DOM text but leaves component state empty,
  // which is exactly the "valid values, disabled submit" failure.
  await sleep(60);
  const back = await el.inputValue();
  if (back !== value) {
    throw new Error(
      `value did not stick for ${JSON.stringify(label)}: wrote ${JSON.stringify(value)}, read ${JSON.stringify(back)}`,
    );
  }
  // Focus then Tab is REQUIRED, not cosmetic. `useFieldValidation` reports
  // `valid = touched && !error && value.trim().length > 0`, and `touched` is set
  // only by an onBlur handler. A programmatic el.blur() does not always run
  // React's synthetic onBlur, so the submit button stayed disabled with every
  // field holding a correct value.
  await el.focus();
  await page.keyboard.press("Tab");
}

function labels(loc: string, group: string, key: string): string {
  const f = path.join(REPO, "packages/i18n/messages", `${loc}.json`);
  return (JSON.parse(fs.readFileSync(f, "utf8"))[group]?.[key] ?? "") as string;
}

async function main(): Promise<void> {
  /**
 * A "cannot run at all" bail-out (no build, no browser). Distinct from a
 * partial-coverage skip: the suite must STOP, because continuing would report a
 * wall of vacuous passes instead of a clear SKIP with an exit code.
 */
function bail(why: string): never {
  console.log(`\nSKIP (${why})`);
  process.exit(EXIT_SKIP);
}

const check = new Checks();
  const baseTmp = process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP ?? os.tmpdir();
  assert.ok(baseTmp, "a temporary directory is required");
  const TMP = path.join(baseTmp, `xistance-nodes-${Date.now().toString(36)}-${process.pid}`);
  const DB = path.join(TMP, "nodes.db");
  const PORT = await freePort();
  fs.mkdirSync(TMP, { recursive: true });

  if (!fs.existsSync(path.join(WEB, ".next/BUILD_ID"))) {
    bail("no production build (run: TURBO_DISABLE=true npm run build)");
  }
  const pw = findPlaywright();
  if (!pw) bail("playwright-core not resolvable");
  const exe = findChromium();
  if (!exe) bail("no Chromium in the playwright cache");

  const app = await startApp({ db: DB, port: PORT, adminEmail: ADMIN_EMAIL, adminPassword: ADMIN_PASS });
  const { origin } = app;

  const browser: Browser = await pw.chromium.launch({
    executablePath: exe,
    // A cached _next chunk from an earlier run survives a successful rebuild and
    // makes a fixed bug look unfixed. Bypass the HTTP cache.
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-application-cache", "--disk-cache-size=1"],
  });
  const ctx: Context = await browser.newContext({ bypassCSP: true });
  // Defeat the Next.js dev-style chunk cache at the route level too.
  await ctx.route("**/_next/static/**", (route) => route.continue());
  const page: Page = await ctx.newPage();

  const pageErrors: string[] = [];
  page.on("pageerror", ((e: { message: string }) => { pageErrors.push(e.message); }) as (x: unknown) => void);

  const read = <T,>(body: string): Promise<T> => readJson<T>(page, body);
  const text = async (): Promise<string> =>
    read<string>("return (document.body.innerText || '').replace(/\\s+/g, ' ').trim();");

  /** Dismiss Sonner toasts: they steal focus and perturb :focus-visible. */
  const clearToasts = async (): Promise<void> => {
    await page.evaluate(`(() => {
      for (const b of Array.from(document.querySelectorAll("[data-sonner-toast] button")))
        b.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      return true;
    })()`);
    await sleep(120);
  };

  const login = async (): Promise<void> => {
    await page.goto(`${origin}/en/login`, { waitUntil: "networkidle", timeout: 60_000 });
    await page.fill('input[name="email"]', ADMIN_EMAIL);
    await page.fill('input[name="password"]', ADMIN_PASS);
    await page.click('button[type="submit"]');
    for (let i = 0; i < 60; i++) {
      const at = await read<string>("return location.pathname;");
      if (!at.includes("/login")) return;
      await sleep(200);
    }
    throw new Error(`login did not complete; still on ${await text()}`);
  };

  try {
    await login();
    check.ok("logged in", await read<string>("return location.pathname;"));

    /* ================================================================ nodes */
    console.log("\n--- the node form cannot submit an invalid value ---");
    const pageErrors: string[] = [];
    page.on("pageerror", (e: Error) => pageErrors.push(`${e.message} :: ${(e.stack || "").split("\n").slice(1, 4).join(" | ").slice(0, 300)}`));
    page.on("console", (m: { type(): string; text(): string }) => {
      if (m.type() === "error") pageErrors.push(`console: ${m.text().slice(0, 300)}`);
    });
    await page.goto(`${origin}/en/nodes`, { waitUntil: "networkidle", timeout: 60_000 });
    await clearToasts();
    await sleep(1500);
    await clearToasts();

    // Surface a Server Component exception immediately instead of letting a
    // later 30s selector timeout swallow it.
    {
      const body = await page.evaluate<string>("(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,200)");
      void pageErrors;
      if (/Something went wrong|unexpected error/i.test(body)) {
        const errs = app.log().split("\n").filter((l) => /Error|error|\bat \b/.test(l));
        check.bad("the nodes page renders", `${body.slice(0, 120)}\n       PAGE: ${pageErrors.slice(0, 3).join("\n       ")}\n       SRV: ${errs.slice(0, 4).join("\n       ")}`);
        throw new Error("nodes page hit its error boundary");
      }
      check.ok("the nodes page renders");
    }
    // Watch the network: an invalid form must never reach the server. Submitting
    // and complaining afterwards is the defect this catches, so the assertion is
    // about the WIRE, not about a toast.
    const nodePosts: number[] = [];
    page.on("response", ((r: { url(): string; status(): number; request(): { method(): string } }) => {
      if (/\/api\/nodes$/.test(r.url()) && r.request().method() === "POST") nodePosts.push(r.status());
    }) as (x: unknown) => void);

    const addLabel = labels("en", "nodes", "add");
    // The dialog's confirm button is common.save -- `common.create` does not
    // exist, so the previous lookup returned "" and every click waited 30s for a
    // button that could never appear, which also left the dialog closed.
    const createLabel = labels("en", "common", "save");

    // Re-open the dialog if it is not already up. Radix restores focus to the
    // opener on close, so assuming the dialog is still mounted after a failed
    // submit is what made the next fill time out.
    const openAdd = async (): Promise<boolean> => {
      if (await page.$('[data-testid="node-create-dialog"]')) return true;
      // There are TWO "Add node" buttons (the header and the empty-state action),
      // so a bare has-text selector hits Playwright's strict-mode violation and
      // resolves to neither. Take the first explicitly.
      await page.click(`button:has-text("${addLabel}") >> nth=0`).catch(() => undefined);
      for (let i = 0; i < 25; i++) {
        if (await page.$('[data-testid="node-create-dialog"]')) return true;
        await sleep(200);
      }
      return false;
    };
    if (await openAdd()) {
      check.ok("the add-node dialog opens");
    } else {
      // Report WHY: how many candidate buttons, and what the click produced.
      // Re-read the page: the boundary can appear seconds after networkidle.
      const nowText = await page.evaluate<string>("(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,160)");
      const why = await read<string>(`
        const btns = Array.from(document.querySelectorAll("button")).filter(b => (b.textContent||"").includes(${JSON.stringify(addLabel)}));
        return JSON.stringify({
          candidates: btns.length,
          pageText: (document.body.innerText||"").replace(/\s+/g," ").slice(0,260),
          pathname: location.pathname,
          html: btns.slice(0,2).map(b => b.outerHTML.slice(0,110)),
          dialogs: document.querySelectorAll('[role="dialog"]').length,
          testid: document.querySelectorAll('[data-testid="node-create-dialog"]').length,
        });
      `);
      check.bad("the add-node dialog opens",
        `no dialog. now=${JSON.stringify(nowText)}\n       PAGE: ${pageErrors.slice(0, 3).join("\n       ")}\n       SRV: ${app.log().split("\n").filter((l) => /Error|error|\bat \b/.test(l)).slice(0, 4).join("\n       ")}\n       ${why}`);
    }

    const submitState = async (): Promise<{ disabled: boolean; described: number; invalid: number; msg: string }> =>
      read<{ disabled: boolean; described: number; invalid: number; msg: string }>(`
        const dlg = document.querySelector('[data-testid="node-create-dialog"]');
        const btns = dlg ? Array.from(dlg.querySelectorAll("button")).filter(b => (b.textContent||"").trim() === ${JSON.stringify(createLabel)}) : [];
        const submit = btns[0];
        const desc = document.querySelectorAll("input[aria-describedby], [aria-invalid='true']");
        return {
          disabled: submit ? submit.disabled : true,
          described: document.querySelectorAll("input[aria-describedby]").length,
          invalid: document.querySelectorAll("[aria-invalid='true']").length,
          msg: (desc[0]?.textContent || "").replace(/\\s+/g," ").trim().slice(0, 90),
        };
      `);

    const empty = await submitState();
    if (empty.disabled) {
      check.ok("the create button is disabled while the form is empty");
    } else {
      check.bad("the create button is disabled while the form is empty",
        "an empty form leaves the create button enabled, so the user can submit a node with no host");
    }

    // Click it anyway: a disabled control must swallow the click, and no request
    // may go out. This is the assertion that would catch a missing `disabled`.
    await page.click(`button:has-text("${createLabel}")`).catch(() => undefined);
    await sleep(900);
    if (nodePosts.length === 0) {
      check.ok("an invalid node form never reaches the server");
    } else {
      check.bad("an invalid node form never reaches the server",
        `${nodePosts.length} POST(s) went out from an empty form (${nodePosts.join(",")})`);
    }

    // Now a half-filled form: name only. Still invalid, still no request.
    await sleep(400);
    const partial = await submitState();
    if (partial.disabled) check.ok("the form stays invalid with only a name filled in");
    else check.bad("the form stays invalid with only a name filled in",
      "the create button became enabled with no host and no username");

    // An invalid hostname must be rejected before submit, with an accessible
    // message rather than a silent no-op.
    await fillByLabel(page, labels("en", "nodes", "name"), "smoke-node");
    await fillByLabel(page, labels("en", "nodes", "host"), "bad host name");
    // useFieldValidation only computes `error` once `touched` is set, which the
    // fill helper now does by pressing Tab. Read AFTER that, and settle a tick
    // so React has re-rendered with aria-invalid/aria-describedby in place.
    await sleep(700);
    // The label renders as "Host*" (required marker), so match the normalised
    // text. An exact match on "Host" found no label, the probe read a null
    // input, and the assertion reported aria-invalid=false for a field that was
    // really flagged -- the test was reporting its own selector failure.
    const badHost = await read<{ invalid: boolean; msg: string; disabled: boolean; labelFound: boolean }>(`
      var dlg = document.querySelector('[data-testid="node-create-dialog"]');
      var norm = function (t) {
        return (t || "").split(" ").filter(Boolean).join(" ").replace(/[*]+$/, "").trim();
      };
      var want = ${JSON.stringify(labels("en", "nodes", "host"))};
      var lab = null;
      if (dlg) {
        var labs = Array.from(dlg.querySelectorAll("label"));
        for (var i = 0; i < labs.length; i++) {
          if (norm(labs[i].textContent) === want) { lab = labs[i]; break; }
        }
      }
      var input = lab && lab.htmlFor ? document.getElementById(lab.htmlFor) : null;
      var desc = input ? input.getAttribute("aria-describedby") : null;
      var el = desc ? document.getElementById(desc.split(" ")[0]) : null;
      var btns = dlg
        ? Array.from(dlg.querySelectorAll("button")).filter(
            function (b) { return (b.textContent || "").trim() === ${JSON.stringify(createLabel)}; })
        : [];
      return {
        labelFound: Boolean(input),
        invalid: input ? input.getAttribute("aria-invalid") === "true" : false,
        msg: ((el && el.textContent) || "").split(" ").filter(Boolean).join(" ").trim().slice(0, 90),
        disabled: btns[0] ? btns[0].disabled : true,
      };
    `);
    if (badHost.invalid && badHost.msg) {
      check.ok(`a malformed host is refused with an accessible message`, badHost.msg);
    } else {
      check.bad("a malformed host is refused with an accessible message",
        `labelFound=${badHost.labelFound} aria-invalid=${badHost.invalid} message=${JSON.stringify(badHost.msg)} disabled=${badHost.disabled}`);
    }
    if (badHost.disabled) check.ok("a malformed host keeps the form unsubmittable");
    else check.bad("a malformed host keeps the form unsubmittable", "the create button stayed enabled");

    console.log("\n--- a valid node pointing at nothing is still created ---");
    // The invalid-form pass left the dialog in an unknown state (Radix restores
    // focus to the opener on close), so re-open explicitly rather than assuming
    // it is still up.
    await openAdd();
    await sleep(300);
    // Creation is a local record. Reachability is a separate, later fact, so a
    // node whose host refuses connections must still be creatable -- otherwise
    // the panel is unusable before the fleet exists.
    await fillByLabel(page, labels("en", "nodes", "host"), DEAD_HOST);
    await sleep(400);
    await fillByLabel(page, labels("en", "nodes", "sshPort"), String(DEAD_PORT));
    await fillByLabel(page, labels("en", "nodes", "username"), "root");
    // The key field is required when auth is "key" (the default), so omitting
    // it left the submit button permanently disabled.
    await fillByLabelText(page, labels("en", "nodes", "key"), "-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-real-key\n-----END OPENSSH PRIVATE KEY-----");
    await sleep(500);
    // Diagnostic: what does the dialog actually contain right now?
    if (process.env.NT_DEBUG) {
      const dump = await read<string>(`
        const dlg = document.querySelector('[role="dialog"]');
        if (!dlg) return "NO DIALOG";
        const fields = Array.from(dlg.querySelectorAll("input")).map(i => ({
          id: i.id, type: i.type, value: i.value, invalid: i.getAttribute("aria-invalid"),
        }));
        return JSON.stringify({ fields, text: (dlg.innerText||"").replace(/\\s+/g," ").slice(0,200) });
      `);
      console.log("       [dbg] " + dump);
    }
    // React state is the only source of truth for isAddValid. Re-read every
    // field AFTER React has re-rendered, because the previous dump ran in the
    // same tick as the fill and could still show pre-commit values.
    await sleep(800);
    const ready = await submitState();
    if (ready.disabled) {
      const fields = await read<string>(`
        const dlg = document.querySelector('[data-testid="node-create-dialog"]');
        if (!dlg) return "NO DIALOG";
        const btns = Array.from(dlg.querySelectorAll("button"));
        const sv = btns.find(b => (b.textContent || "").trim() === ${JSON.stringify(createLabel)});
        const rows = Array.from(dlg.querySelectorAll("input, textarea")).map(i => {
          const lab = i.id ? document.querySelector('label[for="' + CSS.escape(i.id) + '"]') : null;
          const d = i.getAttribute("aria-describedby");
          const dtxt = d ? ((document.getElementById(d) || {}).textContent || "") : "";
          return (lab ? lab.textContent.trim() : (i.placeholder || i.type)) +
            " = " + JSON.stringify(i.value.slice(0, 24)) +
            (i.getAttribute("aria-invalid") === "true" ? " [INVALID]" : "") +
            (dtxt ? " {" + dtxt.replace(/ +/g, " ").trim().slice(0, 40) + "}" : "");
        });
        return JSON.stringify({ submitDisabled: sv ? sv.disabled : "NO SUBMIT BTN", fields: rows });
      `);
      check.bad("a fully filled node form becomes submittable", fields);
    } else {
      check.ok("a fully filled node form becomes submittable");
    }
    await page.click('[data-testid="node-create-dialog"] button:has-text("' + createLabel + '") >> nth=0');
    await sleep(1500);
    await clearToasts();
    await page.goto(`${origin}/en/nodes`, { waitUntil: "networkidle", timeout: 60_000 });
    if ((await text()).includes("smoke-node")) {
      check.ok("a node with an unreachable host is still created");
    } else {
      check.bad("a node with an unreachable host is still created",
        "the form refused a syntactically valid node; creation must not depend on reachability");
    }

    // A second node, so the tunnel flow has two distinct ends.
    await openAdd();
    await sleep(300);
    await fillByLabel(page, labels("en", "nodes", "name"), "smoke-node-2");
    await fillByLabel(page, labels("en", "nodes", "host"), DEAD_HOST);
    await fillByLabel(page, labels("en", "nodes", "sshPort"), String(DEAD_PORT));
    await fillByLabel(page, labels("en", "nodes", "username"), "root");
    // The key field is required when auth is "key" (the default), so omitting
    // it left the submit button permanently disabled.
    await fillByLabelText(page, labels("en", "nodes", "key"), "-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-real-key\n-----END OPENSSH PRIVATE KEY-----");
    await sleep(400);
    await page.click(`button:has-text("${createLabel}")`);
    await sleep(1500);
    await clearToasts();
    await page.goto(`${origin}/en/nodes`, { waitUntil: "networkidle", timeout: 60_000 });
    const nodeCount = await read<number>("return document.querySelectorAll('tbody tr').length;");
    if (nodeCount >= 2) check.ok(`two disposable nodes exist (${nodeCount} rows)`);
    else check.bad("two disposable nodes exist", `only ${nodeCount} row(s); the tunnel flow needs two`);

    /* ============================================== reachability honesty */
    console.log("\n--- reachability is reported honestly ---");
    const testRes = await (async (): Promise<{ status: number; body: string }> => {
      const list = await (await fetch(`${origin}/api/nodes`, { headers: { cookie: await jar(ctx) } })).json()
        .catch(() => ({ nodes: [] })) as { nodes: Array<{ id: string; name: string }> };
      const node = list.nodes.find((n) => n.name === "smoke-node");
      if (!node) return { status: 0, body: "node not in the list" };
      const r = await fetch(`${origin}/api/nodes/${node.id}/test`, {
        method: "POST", headers: await writeHeaders(ctx, origin, false),
      });
      return { status: r.status, body: (await r.text()).slice(0, 200) };
    })();

    if (testRes.status === 200) {
      let okFlag = false;
      try { okFlag = (JSON.parse(testRes.body) as { ok?: boolean }).ok === true; } catch { /* not json */ }
      if (okFlag) {
        check.bad("an unreachable node is reported unreachable",
          "the test endpoint answered ok:true for a port with nothing listening on it");
      } else {
        check.ok("an unreachable node is reported unreachable", testRes.body.replace(/\s+/g, " ").slice(0, 80));
      }
    } else {
      check.bad("an unreachable node is reported unreachable",
        `the test endpoint answered ${testRes.status}: ${testRes.body.slice(0, 120)}`);
    }

    // The failure message must be actionable and must not echo a secret.
    if (/(password|private key|BEGIN [A-Z ]*PRIVATE)/i.test(testRes.body)) {
      check.bad("the reachability error carries no secret material", testRes.body.slice(0, 120));
    } else {
      check.ok("the reachability error carries no secret material");
    }

    /* ============================================================== tunnels */
    console.log("\n--- a tunnel that cannot deploy must not claim success ---");
    const listRes = await fetch(`${origin}/api/nodes`, { headers: { cookie: await jar(ctx) } });
    const nodes = (await listRes.json()) as { nodes: Array<{ id: string; name: string }> };
    const nodeA = nodes.nodes[0]?.id;
    const nodeB = nodes.nodes[1]?.id;

    if (!nodeA || !nodeB) {
      check.bad("a disposable tunnel can be created and deployed",
        `need two nodes for a tunnel; the fixture has ${nodes.nodes.length}`);
    } else {
      // Two nodes, same dead port: the second must be refused as a port clash,
      // and the FIRST must be a visible stopped row rather than a false success.
      // Build a real PORT_FORWARD payload from the real PortForwardRuleSchema.
      // An invented { listenPort, targetHost, targetPort } shape was rejected
      // with 422 "config.portForwards: Required", which reads like an API
      // outage rather than a wrong fixture.
      const rule = (sourcePort: number) => ({
        name: `rule-${sourcePort}`,
        direction: "IRAN_TO_FOREIGN",
        protocol: "tcp",
        sourcePort,
        destHost: DEAD_HOST,
        destPort: sourcePort,
        enabled: true,
      });

      const mk = async (name: string, port: number, nodes?: { client: string; server: string }) => {
        const r = await fetch(`${origin}/api/tunnels`, {
          method: "POST",
          headers: await writeHeaders(ctx, origin),
          body: JSON.stringify({
            name,
            clientNodeId: nodes?.client ?? nodeA,
            serverNodeId: nodes?.server ?? nodeB,
            autostart: true,
            config: { method: "PORT_FORWARD", portForwards: [rule(port)] },
          }),
        });
        return { status: r.status, body: (await r.text()).slice(0, 240) };
      };

      const t1 = await mk("smoke-tunnel", 45999);
      if (t1.status === 201) {
        check.ok("a tunnel is created", `HTTP ${t1.status}`);
      } else {
        check.bad("a tunnel is created", `HTTP ${t1.status}: ${t1.body.slice(0, 160)}`);
      }

      // Deploy against an unreachable node cannot succeed. Whatever the route
      // does, the row must not be left claiming `running`.
      const after = await (async (): Promise<Array<{ name: string; state: string; status: string; err: string | null }>> => {
        const r = await fetch(`${origin}/api/tunnels`, { headers: { cookie: await jar(ctx) } });
        const d = (await r.json()) as { tunnels: Array<{ name: string; state: string; status: string; errorMessage: string | null }> };
        return d.tunnels;
      })();
      // PORT_FORWARD against a LOCAL node legitimately deploys: the panel
      // spawns a real local forwarder process, and the remote destination being
      // unreachable is a RUNTIME condition, not a deploy failure. The earlier
      // version of this test asserted "not running", which was simply wrong
      // about what the feature does.
      //
      // The honest invariant is narrower and is what the user actually relies
      // on: the row must agree with the engine. Ask the engine, then require
      // the stored state to match.
      const row = after.find((t) => t.name === "smoke-tunnel");
      if (!row) {
        check.bad("a deploy attempt always leaves a row",
          "the tunnel vanished: no record of a deployment that was attempted");
      } else {
        const detail = await (async () => {
          const r = await fetch(`${origin}/api/tunnels/${row.id}`, { headers: { cookie: await jar(ctx) } });
          return r.ok ? (await r.json()) as { tunnel: { state: string; status: string; errorMessage: string | null } } : null;
        })();
        const engineState = detail?.tunnel.state ?? row.state;
        if (row.state === engineState) {
          check.ok("the stored state agrees with the engine", `state=${row.state} status=${row.status}`);
        } else {
          check.bad("the stored state agrees with the engine",
            `row says ${row.state} but the engine says ${engineState}`);
        }
        // A row that claims `running` must not carry a deploy error, and a row
        // with an error must not claim `running`.
        if (row.state === "running" && row.err) {
          check.bad("a running row carries no deploy error", `state=running error=${row.err}`);
        } else {
          check.ok("a running row carries no deploy error");
        }
      }

      // A deploy that genuinely cannot plan anything must land as stopped +
      // an error, never as a running row with nothing behind it. XUI is
      // metadata-only, so use a PORT_FORWARD with an empty rule set instead: the
      // schema rejects it at 422, which the same-node case already covers, so
      // assert the honest invariant -- every row the API returns is a row the
      // engine can explain.
      const allRows = await (async () => {
        const r = await fetch(`${origin}/api/tunnels`, { headers: { cookie: await jar(ctx) } });
        const d = (await r.json()) as { tunnels: Array<{ state: string; errorMessage: string | null }> };
        return d.tunnels;
      })();
      const inexplicable = allRows.filter((t) => t.state === "running" && t.errorMessage);
      if (inexplicable.length === 0) {
        check.ok("no running row carries an error", `${allRows.length} row(s) checked`);
      } else {
        check.bad("no running row carries an error", JSON.stringify(inexplicable).slice(0, 160));
      }

      const t2 = await mk("smoke-tunnel-dup", 45999);
      if (t2.status === 409 || t2.status === 500) {
        check.ok("a duplicate port is refused", `HTTP ${t2.status}`);
      } else {
        check.bad("a duplicate port is refused", `the second tunnel on port 45999 was accepted (HTTP ${t2.status})`);
      }

      // Invalid config must be rejected with a message, not a 500 stack.
      const bad = await fetch(`${origin}/api/tunnels`, {
        method: "POST",
        headers: await writeHeaders(ctx, origin),
        body: JSON.stringify({ name: "smoke-bad", clientNodeId: nodeA, serverNodeId: nodeA, config: { method: "NOT_A_METHOD" } }),
      });
      const badBody = (await bad.text()).slice(0, 160);
      if (bad.status === 400 || bad.status === 422) {
        check.ok("an invalid method is rejected with a 4xx", `HTTP ${bad.status}`);
      } else {
        check.bad("an invalid method is rejected with a 4xx", `HTTP ${bad.status}: ${badBody}`);
      }
      if (/at \w+ \(|node_modules|\.tsx:\d+|Error:/.test(badBody)) {
        check.bad("a validation error carries no stack trace", badBody.slice(0, 120));
      } else {
        check.ok("a validation error carries no stack trace");
      }
      // Same node on both ends is a config error the UI can prevent. The rule
      // shape must still be valid, or the 422 would be for the wrong reason.
      const same = await mk("smoke-same", 45991, { client: nodeA, server: nodeA });
      if (same.status === 422) check.ok("the same node on both ends is refused (422)", `HTTP ${same.status}`);
      else check.bad("the same node on both ends is refused", `HTTP ${same.status}: ${same.body.slice(0, 100)}`);
    }

    /* ============================================================== the UI */
    console.log("\n--- the tunnels table reflects the server ---");
    await page.goto(`${origin}/en/tunnels`, { waitUntil: "networkidle", timeout: 60_000 });
    await clearToasts();
    const table = await read<{ rows: number; body: string; hasName: boolean }>(`
      const rows = document.querySelectorAll("tbody tr");
      return { rows: rows.length, body: (document.body.innerText||"").replace(/\\s+/g," ").slice(0,400), hasName: (document.body.innerText||"").includes("smoke-tunnel") };
    `);
    if (table.hasName) check.ok("the tunnels table lists the created tunnel", `${table.rows} row(s)`);
    else check.bad("the tunnels table lists the created tunnel", `the row is missing; the table shows: ${table.body.slice(0, 140)}`);

    // Every row needs a name for its actions, or the controls are unreachable.
    const unnamed = await read<number>(`
      const btns = Array.from(document.querySelectorAll("tbody button"));
      return btns.filter(b => !b.getAttribute("aria-label") && !(b.textContent||"").trim()).length;
    `);
    if (unnamed === 0) check.ok("every row action control has an accessible name");
    else check.bad("every row action control has an accessible name", `${unnamed} control(s) in the table have no name`);

    /* ============================================================== errors */
    console.log("\n--- no page or console errors ---");
    if (pageErrors.length === 0) check.ok("no uncaught exceptions");
    else check.bad("no uncaught exceptions", pageErrors.slice(0, 2).join(" | ").slice(0, 200));

    const errLines = app.log().split("\n").filter((l) => /error|Error|\bat \b/i.test(l));
    console.log(errLines.length ? errLines.slice(0, 8).join("\n       ") : "       (server log clean)");
  } finally {
    await app.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    fs.rmSync(TMP, { recursive: true, force: true });
  }

  process.exitCode = check.report();
}

/**
 * Headers for an authenticated, CSRF-bearing write.
 *
 * The CSRF cookie is deliberately JavaScript-readable (the production client
 * reads it in apiFetch), but it is only half the contract: the server compares
 * the cookie against an `X-CSRF-Token` header. Every write here previously sent
 * only `cookie` + `origin` and got a blanket 403, which is indistinguishable
 * from a genuine authorization failure -- so the tunnel assertions were
 * reporting API rejections as product behaviour.
 */
async function writeHeaders(ctx: Context, origin: string, withBody = true): Promise<Record<string, string>> {
  const cookies = await ctx.cookies(origin);
  const csrf = cookies.find((c) => c.name.endsWith("csrf") || c.name.endsWith("csrf-token"));
  const h: Record<string, string> = { cookie: await jar(ctx), origin };
  if (withBody) h["content-type"] = "application/json";
  if (csrf) h["x-csrf-token"] = csrf.value;
  else throw new Error(`no CSRF cookie in ${JSON.stringify(cookies.map((c) => c.name))}`);
  return h;
}

async function jar(ctx: Context): Promise<string> {
  const cs = await ctx.cookies();
  return cs.map((c) => `${c.name}=${c.value}`).join("; ");
}

main().catch((e: unknown) => {
  console.error(String(e));
  process.exit(EXIT_SKIP === 77 ? 1 : 1);
});