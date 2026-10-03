/**
 * XUI method coverage and the controlled private-network exception (TASK-34).
 *
 * Two distinct things are under test.
 *
 * 1. **The SSRF guard and its one documented exception.** 3X-UI panels usually
 *    live on the operator's own VPS, often on a private/tailnet address, so
 *    `/api/xui/test` intentionally does NOT apply the private-IP block. That
 *    exception is a liability: it only stays safe while it stays narrow. These
 *    tests pin its exact boundary -- it applies to XUI and to nothing else, and
 *    `/api/tools` must keep its guard.
 *
 * 2. **The "false running" defect.** `planXui` writes an `xui.json` pointer and
 *    returns zero processes, claiming it lets status "report the last-verified
 *    inbound". Nothing verifies anything: no login, no inbound fetch, no
 *    comparison. `computeStatus` then reports `running` for a tunnel that was
 *    never contacted, and a typo'd panel URL is indistinguishable from a healthy
 *    one. The engine must actually verify, and must fail honestly.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildXuiSyncPayload,
  normalizePanelUrl,
  XUI_INBOUNDS_PATH,
  XUI_LOGIN_PATHS,
  xuiInboundPath,
  xuiLoginBody,
} from "../packages/tunnel-core/src/config/xui.ts";
import { XuiConfigSchema, TunnelConfigSchema, TunnelMethod, type XuiConfig } from "../packages/types/src/index.ts";
import { syncXui, classifyXuiSync } from "../packages/tunnel-core/src/xui-sync.ts";

let pass = 0;
const failures: string[] = [];
const ok = (name: string) => {
  pass += 1;
  console.log(`  ok   ${name}`);
};
const bad = (name: string, detail: string) => {
  failures.push(name);
  console.log(`  FAIL ${name}\n       ${detail}`);
};

const RAW: XuiConfig = {
  panelUrl: "https://panel.example.com",
  username: "admin",
  password: "s3cr3t-panel-password",
  inboundId: 7,
  remark: "prod",
  syncInterval: 300,
};
const mk = (patch: Partial<XuiConfig> = {}): XuiConfig =>
  XuiConfigSchema.parse({ ...RAW, ...patch }) as XuiConfig;

async function main() {
  console.log("\n--- URL validation ---");

  // ---- 1. the panel URL must be a real, credential-free http(s) URL --------
  {
    const rejected: Array<[string, string]> = [
      ["a non-URL", "not a url"],
      ["a file: URL", "file:///etc/passwd"],
      ["a gopher: URL", "gopher://example.com"],
      ["a javascript: URL", "javascript:alert(1)"],
      ["a data: URL", "data:text/html,<h1>x</h1>"],
      ["a URL with credentials", "https://admin:hunter2@panel.example.com"],
      ["a URL with only a username", "https://admin@panel.example.com"],
      ["an empty URL", ""],
    ];
    let accepted = 0;
    for (const [label, v] of rejected) {
      const r = XuiConfigSchema.safeParse({ ...RAW, panelUrl: v });
      if (r.success) {
        accepted += 1;
        bad(`the schema refuses ${label}`, `accepted ${JSON.stringify(v)}`);
      }
    }
    if (accepted === 0) ok(`the schema refuses all ${rejected.length} invalid panel URLs`);
  }
  {
    const good = XuiConfigSchema.safeParse({ ...RAW, panelUrl: "http://10.0.0.5:2053" });
    if (good.success) ok("a private http panel URL is accepted -- this is the documented exception");
    else bad("a private http panel URL is accepted", good.error.issues.map((i) => i.message).join("; "));
  }

  // ---- 2. credential-free payloads ----------------------------------------
  {
    const payload = buildXuiSyncPayload(mk());
    const serialised = JSON.stringify(payload);
    if (!serialised.includes(RAW.password)) ok("the sync payload contains no password");
    else bad("the sync payload contains no password", serialised);
    if (!/"username"|"password"/.test(serialised)) ok("the sync payload has no credential fields at all");
    else bad("the sync payload has no credential fields", serialised);
    if (payload.baseUrl === "https://panel.example.com") ok("the sync payload carries the normalised base URL");
    else bad("the sync payload carries the base URL", payload.baseUrl);
    if (payload.inboundPath === "/panel/api/inbounds/get/7") ok("the sync payload carries the inbound path");
    else bad("the sync payload carries the inbound path", String(payload.inboundPath));
  }
  {
    const noId = buildXuiSyncPayload(mk({ inboundId: undefined }));
    if (noId.inboundPath === null) ok("no inbound id yields a null path rather than a bogus one");
    else bad("no inbound id yields a null path", String(noId.inboundPath));
  }
  {
    // Credentials go ONLY through the login body, never the URL.
    const body = xuiLoginBody(mk());
    if (body.get("username") === "admin" && body.get("password") === RAW.password) {
      ok("the login body carries the credentials in named fields");
    } else {
      bad("the login body carries the credentials in named fields", body.toString().slice(0, 80));
    }
    if (!body.toString().includes(RAW.panelUrl)) ok("the login body does not embed the panel URL");
    else bad("the login body does not embed the panel URL", body.toString().slice(0, 80));
  }
  {
    // Layer 1: the schema refuses it. Asserted on its own, because an `||`
    // here once let the normaliser's behaviour mask a schema regression.
    const hostile = "https://admin:hunter2@panel.example.com";
    const r = XuiConfigSchema.safeParse({ ...RAW, panelUrl: hostile });
    if (!r.success) ok("the schema refuses a credential-bearing panel URL");
    else bad("the schema refuses a credential-bearing panel URL", "accepted");
    if (!r.success && /username\/password fields/.test(r.error.issues.map((i) => i.message).join(";"))) {
      ok("the schema refusal names the credential fields, so the fix is obvious");
    } else {
      bad("the schema refusal names the credential fields", r.success ? "accepted" : r.error.issues.map((i) => i.message).join("; "));
    }

    // Layer 2: the normaliser strips them even when the schema was bypassed.
    // This is the defence-in-depth path -- a caller that skipped validation must
    // still not put a password into a request line or a log.
    const normalised = normalizePanelUrl(hostile);
    if (normalised === "https://panel.example.com") ok("normalisation strips embedded credentials");
    else bad("normalisation strips embedded credentials", normalised);
    if (!normalised.includes("hunter2") && !normalised.includes("admin")) ok("no credential survives normalisation");
    else bad("no credential survives normalisation", normalised);
    // A username-only URL is stripped the same way.
    const userOnly = normalizePanelUrl("https://admin@panel.example.com/");
    if (userOnly === "https://panel.example.com") ok("normalisation strips a username-only URL");
    else bad("normalisation strips a username-only URL", userOnly);
    // A normal URL with an @ in the PATH is not a credential and must survive.
    const atPath = normalizePanelUrl("https://panel.example.com/a@b");
    if (atPath === "https://panel.example.com/a@b") ok("an @ in the path is not mistaken for credentials");
    else bad("an @ in the path is not mistaken for credentials", atPath);
  }

  // ---- 3. path constants ---------------------------------------------------
  {
    if (XUI_LOGIN_PATHS.length >= 2) ok(`both x-ui and 3x-ui login paths are covered (${XUI_LOGIN_PATHS.length})`);
    else bad("both login paths are covered", String(XUI_LOGIN_PATHS.length));
    for (const p of [...XUI_LOGIN_PATHS, XUI_INBOUNDS_PATH]) {
      if (p.startsWith("/") && !p.includes("..") && !p.includes("//")) ok(`${p} is a safe relative path`);
      else bad(`${p} is a safe relative path`, p);
    }
    if (xuiInboundPath(7) === "/panel/api/inbounds/get/7") ok("the inbound path is built from a numeric id");
    else bad("the inbound path is built from a numeric id", xuiInboundPath(7));
    // A non-numeric id must be REFUSED, not turned into "/get/NaN" -- that
    // path is one the panel cannot answer, with an error that explains nothing.
    for (const [label, id] of [["NaN", Number.NaN], ["null", null as never], ["zero", 0], ["a float", 1.5], ["a negative", -3]] as const) {
      let msg = "<no error>";
      try {
        const p = xuiInboundPath(id as number);
        msg = `built ${p}`;
      } catch (e) {
        msg = (e as Error).message;
      }
      if (/positive integer/.test(msg) && !msg.includes("built ")) ok(`a ${label} inbound id is refused`);
      else bad(`a ${label} inbound id is refused`, msg);
    }
  }

  // ---- 4. the SSRF guard, and the boundary of the exception -----------------
  {
    const { isPrivateIp, isBlockedTarget } = await import("../apps/web/src/lib/ssrf.ts");
    const privates = ["127.0.0.1", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "0.0.0.0", "::1", "fe80::1", "fc00::1", "fd12::1"];
    let missed = 0;
    for (const ip of privates) {
      if (!isPrivateIp(ip)) {
        missed += 1;
        bad(`${ip} is recognised as private`, "reported public");
      }
    }
    if (missed === 0) ok(`all ${privates.length} private/reserved literals are recognised`);

    // 203.0.113.10 was listed here as a "public literal" to allow. It is not:
    // 203.0.113.0/24 is TEST-NET-3 (RFC 5737), a reserved documentation range,
    // and the guard correctly refuses it. Keeping it in this list asserted that
    // a correct SSRF guard was broken, and the suite went red on a fixed
    // function. The real public literals are routable addresses.
    const publics = ["8.8.8.8", "1.1.1.1", "2001:4860:4860::8888", "93.184.216.34"];
    let overBlocked = 0;
    for (const ip of publics) {
      if (isPrivateIp(ip)) {
        overBlocked += 1;
        bad(`${ip} is not private`, "reported private");
      }
    }
    if (overBlocked === 0) ok(`all ${publics.length} public literals are allowed`);

    // The documentation ranges are reserved, not public, so the guard must
    // refuse them. A panel pointed at one of these is not reaching the internet
    // -- it is reaching a range that can never host a real service, and treating
    // it as public is how an SSRF filter quietly stops matching what it claims.
    const reserved = ["192.0.2.1", "198.51.100.1", "203.0.113.1", "198.18.0.1"];
    let reservedMissed = 0;
    for (const ip of reserved) {
      if (!isPrivateIp(ip)) {
        reservedMissed += 1;
        bad(`${ip} (reserved documentation range) is blocked`, "reported public");
      }
    }
    if (reservedMissed === 0) ok(`all ${reserved.length} RFC 5737 documentation ranges are refused`);

    // The classic 172.16/12 boundary -- an off-by-one here is a real hole. The
    // first version of this assertion read `a && b && c` where `a` was the
    // negation, and reported a correct implementation as broken. Parenthesised
    // so each case is judged on its own.
    const b172 = [
      ["172.15.255.255", false],
      ["172.16.0.0", true],
      ["172.31.255.255", true],
      ["172.32.0.0", false],
    ] as const;
    let b172wrong = 0;
    for (const [ip, want] of b172) {
      if (isPrivateIp(ip) !== want) {
        b172wrong += 1;
        bad(`the 172.16/12 boundary at ${ip}`, `expected private=${want}, got ${isPrivateIp(ip)}`);
      }
    }
    if (b172wrong === 0) ok("the 172.16/12 range boundary is exact at all four edges");

    // 169.254.169.254 is the cloud metadata endpoint: the single most valuable
    // SSRF target there is.
    if (isPrivateIp("169.254.169.254")) ok("the cloud metadata address is blocked");
    else bad("the cloud metadata address is blocked", "allowed");

    for (const name of ["localhost", "metadata.google.internal", "foo.internal", "bar.local"]) {
      if (await isBlockedTarget(name)) ok(`${name} is blocked`);
      else bad(`${name} is blocked`, "allowed");
    }
    // Fail-closed: an unresolvable host must not become "allowed".
    if (await isBlockedTarget("this-host-does-not-exist.invalid")) ok("an unresolvable host fails closed");
    else bad("an unresolvable host fails closed", "allowed");
  }

  // ---- 5. the exception must not have leaked to other endpoints -----------
  // The exception is intentional, but it is scoped to /api/xui/test. If a
  // future edit applies it to /api/tools, the panel becomes an open proxy into
  // the operator's private network. Assert the tools route still guards.
  {
    const toolsRoute = fs.readFileSync(
      new URL("../apps/web/app/api/tools/route.ts", import.meta.url),
      "utf8",
    );
    const guards = (toolsRoute.match(/isBlockedTarget\(/g) ?? []).length;
    if (guards >= 3) ok(`the tools route still guards every probe type (${guards} guard calls)`);
    else bad("the tools route guards every probe type", `${guards} guard calls`);

    // The exception must be DOCUMENTED at the site, not merely implied.
    const xuiRoute = fs.readFileSync(
      new URL("../apps/web/app/api/xui/test/route.ts", import.meta.url),
      "utf8",
    );
    // The exception must be DOCUMENTED at the site, not merely implied — and
    // matched on intent, not on one exact wording. This assertion used to grep
    // for the literal "intentionally no SSRF", so replacing that blanket
    // exemption with a narrower policy (private allowed, loopback and
    // link-local refused) failed the test even though the behaviour improved.
    if (
      /no SSRF private-IP block|intentionally no SSRF|deliberately reachable|private\/tailnet address space is deliberately/i.test(
        xuiRoute,
      )
    ) {
      ok("the XUI route documents why it omits the blanket guard");
    } else {
      bad("the XUI route documents why it omits the blanket guard", "no rationale comment");
    }
    // ...and the narrower policy must actually be applied.
    if (/rejectPanelProbeHost\(parsed\.hostname\)/.test(xuiRoute)) {
      ok("the XUI route refuses loopback / link-local panel targets");
    } else {
      bad("the XUI route refuses loopback / link-local panel targets", "policy not applied");
    }
    if (/requireSession/.test(xuiRoute)) ok("the XUI route still requires a signed-in session");
    else bad("the XUI route still requires a signed-in session", "no session check");
    if (/rateLimit\(/.test(xuiRoute)) ok("the XUI route is still rate limited");
    else bad("the XUI route is still rate limited", "no rate limit");
  }

  // ---- 6. XUI must actually verify, and fail honestly ---------------------
  // planXui returning zero processes means computeStatus reports `running`.
  // That is only honest if a real verification happened.
  {
    const mod = await import("../packages/tunnel-core/src/xui-sync.ts").catch(() => null);
    if (!mod || typeof mod.classifyXuiSync !== "function") {
      bad("an XUI sync result can be classified", `module missing (${mod ? "no classifyXuiSync" : "no module"})`);
    } else {
      const cases: Array<[string, unknown, string]> = [
        ["a successful inbound fetch", { ok: true, inbound: { id: 7, up: true } }, "running"],
        ["a panel that answers with a non-JSON body", { ok: false, kind: "malformed" }, "error"],
        ["a login rejection", { ok: false, kind: "auth" }, "error"],
        ["an unreachable panel", { ok: false, kind: "unreachable" }, "error"],
        ["a rate-limited panel", { ok: false, kind: "rate_limited" }, "degraded"],
        ["a missing inbound", { ok: false, kind: "missing_inbound" }, "error"],
        ["a stopped inbound", { ok: true, inbound: { id: 7, up: false } }, "degraded"],
      ];
      let wrong = 0;
      for (const [label, result, want] of cases) {
        const got = mod.classifyXuiSync(result as never);
        if (got !== want) {
          wrong += 1;
          bad(`${label} maps to ${want}`, String(got));
        }
      }
      if (wrong === 0) ok(`all ${cases.length} XUI sync outcomes map to an honest status`);
    }
  }

  // ---- 7. bounded retries and cancellation ---------------------------------
  {
    const mod = await import("../packages/tunnel-core/src/xui-sync.ts").catch(() => null);
    if (!mod || typeof mod.XUI_RETRY_POLICY !== "object") {
      bad("XUI retries have a declared, bounded policy", "no policy");
    } else {
      const p = mod.XUI_RETRY_POLICY as { maxAttempts: number; baseMs: number; capMs: number };
      // Assert the POLICY is small, not merely finite. A mutant that sets
      // maxAttempts to 1000 is finite and would otherwise only be caught by a
      // 40-minute test run.
      if (p.maxAttempts >= 1 && p.maxAttempts <= 10) ok(`retries are few and finite (max ${p.maxAttempts} attempts)`);
      else bad("retries are few and finite", `${p.maxAttempts} attempts`);
      if (p.capMs > 0 && p.capMs <= 60_000) ok(`the backoff is capped (${p.capMs}ms)`);
      else bad("the backoff is capped", String(p.capMs));
      if (p.baseMs > 0) ok("the backoff starts at a positive delay");
      else bad("the backoff starts at a positive delay", String(p.baseMs));
    }
    if (!mod || typeof mod.syncXui !== "function") {
      bad("the XUI sync is callable", "no syncXui");
    } else {
      // A stop must abort in-flight retries, not wait them out.
      const ctrl = new AbortController();
      let attempts = 0;
      let fetches = 0;
      const started = Date.now();
      const promise = mod.syncXui(
        { panelUrl: "http://127.0.0.1:1/", username: "u", password: "p" } as never,
        {
          signal: ctrl.signal,
          sleep: async (ms: number, signal: AbortSignal) => {
            attempts += 1;
            // Resolve on abort, not on the timer: cancellation must be what
            // ends the wait, so an over-long policy is caught immediately
            // instead of grinding through thousands of real backoffs.
            return new Promise<void>((resolve) => {
              if (signal.aborted) return resolve();
              const t = setTimeout(resolve, Math.min(ms, 5));
              signal.addEventListener("abort", () => {
                clearTimeout(t);
                resolve();
              }, { once: true });
            });
          },
          fetchImpl: async () => {
            fetches += 1;
            throw new Error("connection refused");
          },
        },
      );
      setTimeout(() => ctrl.abort(), 20);
      const result = await promise;
      const elapsed = Date.now() - started;
      if (result.ok === false) ok("a failing XUI sync returns a failure, never a success");
      else bad("a failing XUI sync returns a failure", JSON.stringify(result));
      if (elapsed < 5_000) ok(`cancellation stops the retries promptly (${elapsed}ms, ${attempts} attempts)`);
      else bad("cancellation stops the retries promptly", `${elapsed}ms, ${attempts} attempts`);
      if (fetches <= 3) ok(`retries stayed bounded under cancellation (${fetches} fetches, ${attempts} sleeps)`);
      else bad("retries stayed bounded", `${fetches} fetches, ${attempts} sleeps`);
    }
  }

  // ---- 8b. nor when the login SUCCEEDS and no inbound was verified ---------
  //
  // TASK-136's first fix changed syncXui to return `up: false`, but planXui
  // branched on `result.ok` -- which is true for a login that confirmed nothing
  // -- so it still published `running` and never consulted classifyXuiSync.
  // status() prefers the diagnostic, so the fix did not reach the engine at all.
  // Section 8 above injects an UNREACHABLE panel; this injects a SUCCESSFUL one,
  // which is the case that looks healthy.
  {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "xt-xui-ok-"));
    const binDir = path.join(dataDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const { TunnelEngine } = await import("../packages/tunnel-core/src/engine.ts");
    class Handle {
      running = true;
      constructor(readonly spec: { unitName: string }) {}
      async isRunning() { return this.running; }
      async start() { this.running = true; }
      async stop() { this.running = false; }
    }
    const spec = {
      id: "xui-ok",
      name: "xui-ok",
      method: TunnelMethod.XUI,
      config: { method: TunnelMethod.XUI, xui: RAW },
      clientNode: { id: "n1", host: "127.0.0.1", isLocal: true },
    } as never;

    // Three engine states, three expected statuses. The middle one is the
    // regression: a login that verified nothing must not read as running.
    const scenarios: Array<[string, unknown, string]> = [
      [
        "a login that verified no inbound",
        { ok: true, kind: "ok" as const, loginPath: "/login", inbound: { id: 0, up: false } },
        "degraded",
      ],
      [
        "a verified, enabled inbound",
        { ok: true, kind: "ok" as const, loginPath: "/login", inbound: { id: 7, up: true } },
        "running",
      ],
      [
        "a verified but disabled inbound",
        { ok: true, kind: "ok" as const, loginPath: "/login", inbound: { id: 7, up: false } },
        "degraded",
      ],
    ];

    // Each scenario gets a distinct tunnel id: the diagnostic store outlives the
    // engine instance, so reusing one id let the previous scenario's summary leak
    // into the next assertion.
    for (const [label, syncResult, expected] of scenarios) {
      const tunnelId = `xui-ok-${label.replace(/\W+/g, "-")}`;
      const engine = new TunnelEngine({
        dataDir,
        localBinDir: binDir,
        forceNodeFallback: true,
        forwarderRunner: { prefix: ["node"], script: "forwarder.mjs" },
        createProcessHandle: async (s) => new Handle(s as { unitName: string }) as never,
        xuiSync: async () => syncResult as never,
      } as never);
      await engine.deploy({ ...spec, id: tunnelId } as never).catch(() => undefined);
      const st = await engine.status(tunnelId);
      if (st === expected) {
        ok(`engine: ${label} reports ${expected}`);
      } else {
        bad(
          `engine: ${label} reports ${expected}`,
          `reported ${String(st)}; status() prefers the published diagnostic`,
        );
      }
      // The REASON, not just the status. /api/tunnels does
      //   actualError = state is error|unknown|degraded
      //     ? engine.getDiagnostic(id)?.summary ?? null : null
      // so a degraded tunnel whose diagnostic still says `running` reaches the
      // operator as a warning badge with an EMPTY reason -- verified, and the
      // reason the planXui branch had to change despite not moving status().
      if (expected === "degraded") {
        const summary = engine.getDiagnostic(tunnelId)?.summary ?? null;
        if (typeof summary === "string" && summary.trim().length > 0) {
          ok(`  and ${label} carries a non-empty reason for the operator`);
        } else {
          bad(
            `  and ${label} carries a non-empty reason for the operator`,
            `diagnostic summary was ${JSON.stringify(summary)}`,
          );
        }
      } else {
        const summary = engine.getDiagnostic(tunnelId)?.summary ?? null;
        if (!summary || !String(summary).trim()) {
          ok("  and a running XUI tunnel carries no error reason");
        } else {
          bad(
            "  and a running XUI tunnel carries no error reason",
            `summary was ${JSON.stringify(summary)}`,
          );
        }
      }
    }

    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  // ---- 8. the engine must not report a never-verified XUI as running ------
  {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "xt-xui-"));
    const binDir = path.join(dataDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const { TunnelEngine } = await import("../packages/tunnel-core/src/engine.ts");
    class Handle {
      running = true;
      constructor(readonly spec: { unitName: string }) {}
      async isRunning() { return this.running; }
      async start() { this.running = true; }
      async stop() { this.running = false; }
    }
    // No network and no wall-clock: the point of the assertion is what the
    // engine REPORTS, not whether 3X-UI answers. Going through the real sync
    // meant live DNS plus 9 live HTTP attempts, and a retry-bounds regression
    // turned the suite into a multi-minute hang instead of a failure.
    const engine = new TunnelEngine({
      dataDir,
      localBinDir: binDir,
      forceNodeFallback: true,
      forwarderRunner: { prefix: ["node"], script: "forwarder.mjs" },
      createProcessHandle: async (s) => new Handle(s as { unitName: string }) as never,
      xuiSync: async () => ({
        ok: false,
        kind: "unreachable" as const,
        detail: "injected: the panel does not exist",
        retryable: true,
      }),
    } as never);

    const spec = {
      id: "xui-1",
      name: "xui",
      method: TunnelMethod.XUI,
      config: { method: TunnelMethod.XUI, xui: RAW },
      clientNode: { id: "n1", host: "127.0.0.1", isLocal: true },
    } as never;

    // No verification is possible here (the panel does not exist), so the
    // engine must NOT claim the tunnel is running.
    await engine.deploy(spec).catch(() => undefined);
    const st = await engine.status("xui-1");
    if (st === "running") bad("an unverified XUI tunnel is not reported running", String(st));
    else ok(`an unverified XUI tunnel reports ${st}, not running`);

    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  // ---- 9. the union path ---------------------------------------------------
  {
    const r = TunnelConfigSchema.safeParse({ method: TunnelMethod.XUI, xui: RAW });
    if (r.success) ok("a well-formed XUI tunnel validates through TunnelConfigSchema");
    else bad("a well-formed XUI tunnel validates", r.error.issues.map((i) => i.message).join("; "));
    const bad2 = TunnelConfigSchema.safeParse({ method: TunnelMethod.XUI, xui: { ...RAW, panelUrl: "file:///etc/passwd" } });
    if (!bad2.success) ok("a file: panel URL is refused through the union as well");
    else bad("a file: panel URL is refused through the union", "accepted");
  }

  // ---- TASK-136: a successful login is not a running tunnel -----------------
  //
  // syncXui returned `up: true` when no inboundId was configured, and
  // classifyXuiSync maps `up: true` straight to "running". So a tunnel whose
  // panel URL and credentials were correct -- but which had NO inbound verified
  // at all -- was reported to the operator as RUNNING. That is the exact failure
  // this module's header says it exists to prevent ("a tunnel was running when
  // the panel URL was a typo and the credentials were wrong, as long as a deploy
  // had been issued"), arriving through a different door.
  //
  // The suite already asserted the unreachable-panel case must not be "running";
  // it did not cover the login-succeeds case, which is the one that looks healthy.
  {
    const loginOk = async () => new Response("", { status: 200 });
    const noInbound = XuiConfigSchema.parse({
      panelUrl: "https://panel.example",
      username: "u",
      password: "p",
    });
    const res = await syncXui(noInbound as never, {
      fetchImpl: loginOk as never,
      sleep: async () => {},
    });
    if (res.ok) {
      ok("XUI: a reachable panel with correct credentials still returns an ok sync");
    } else {
      bad(
        "XUI: a reachable panel with correct credentials still returns an ok sync",
        `got ${JSON.stringify(res)}`,
      );
    }
    const st = classifyXuiSync(res);
    if (st !== "running") {
      ok("XUI: a login with no verified inbound is degraded, not running");
    } else {
      bad(
        "XUI: a login with no verified inbound is degraded, not running",
        "the UI would show RUNNING on the strength of a login alone",
      );
    }

    // Positive control: a real inbound that IS up must still be "running", or
    // the fix above would have downgraded every healthy XUI tunnel.
    const inboundFetch = async (u: unknown) =>
      String(u).includes("inbound")
        ? new Response(JSON.stringify({ obj: { id: 7, enable: true } }), { status: 200 })
        : new Response("", { status: 200 });
    const withId = XuiConfigSchema.parse({
      panelUrl: "https://panel.example",
      username: "u",
      password: "p",
      inboundId: 7,
    });
    const up = await syncXui(withId as never, {
      fetchImpl: inboundFetch as never,
      sleep: async () => {},
    });
    if (classifyXuiSync(up) === "running") {
      ok("XUI: a verified, enabled inbound is still reported running");
    } else {
      bad(
        "XUI: a verified, enabled inbound is still reported running",
        `classified ${classifyXuiSync(up)}`,
      );
    }

    // And a deliberately stopped inbound stays degraded -- not error, not running.
    const stoppedFetch = async (u: unknown) =>
      String(u).includes("inbound")
        ? new Response(JSON.stringify({ obj: { id: 7, enable: false } }), { status: 200 })
        : new Response("", { status: 200 });
    const down = await syncXui(withId as never, {
      fetchImpl: stoppedFetch as never,
      sleep: async () => {},
    });
    if (classifyXuiSync(down) === "degraded") {
      ok("XUI: a verified but disabled inbound is degraded (stopped, not broken)");
    } else {
      bad(
        "XUI: a verified but disabled inbound is degraded (stopped, not broken)",
        `classified ${classifyXuiSync(down)}`,
      );
    }
  }

  console.log(`\n--- ${pass} passed, ${failures.length} failed ---`);
  if (failures.length > 0) process.exitCode = 1;
}

void main();
assert.ok(true);
