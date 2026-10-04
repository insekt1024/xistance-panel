/**
 * Reproduce the /nodes error boundary with a disposable server and print the
 * real server-side exception. Used to diagnose TASK-52; kept because the same
 * failure mode (a Server Component throwing) recurs.
 */
import os from "node:os";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

import { REPO, WEB, findChromium, findPlaywright, freePort, sleep, startApp } from "./lib/browser-harness";

async function main(): Promise<void> {
  const baseTmp = process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP ?? os.tmpdir();
  assert.ok(baseTmp, "a temporary directory is required");
  const TMP = path.join(baseTmp, `xistance-diag-${Date.now().toString(36)}`);
  const DB = path.join(TMP, "diag.db");
  const PORT = await freePort();
  fs.mkdirSync(TMP, { recursive: true });

  const pw = findPlaywright();
  const exe = findChromium();
  if (!pw || !exe) {
    console.log("SKIP: playwright/chromium unavailable");
    return;
  }

  const app = await startApp({
    db: DB,
    port: PORT,
    adminEmail: "diag@xistance.invalid",
    adminPassword: "DiagAdminPassw0rd!",
  });

  const browser = await pw.chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  try {
    await page.goto(`${app.origin}/en/login`, { waitUntil: "networkidle", timeout: 60_000 });
    await page.fill('input[name="email"]', "diag@xistance.invalid");
    await page.fill('input[name="password"]', "DiagAdminPassw0rd!");
    await page.click('button[type="submit"]');
    await sleep(3000);

    for (const route of ["/en", "/en/nodes", "/en/tunnels", "/en/users", "/en/settings", "/en/audit"]) {
      const before = app.log().length;
      await page.goto(`${app.origin}${route}`, { waitUntil: "networkidle", timeout: 60_000 });
      await sleep(800);
      const body = await page.evaluate<string>("(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,180)");
      const broke = /Something went wrong|unexpected error|Application error/i.test(body);
      const fresh = app.log().slice(before);
      console.log(`\n=== ${route} ${broke ? "*** ERROR BOUNDARY ***" : "ok"}`);
      if (broke) console.log(`    body: ${body}`);
      const errs = fresh.split("\n").filter((l) => /Error|error|\bat \b/.test(l));
      for (const l of errs.slice(0, 6)) console.log(`    ${l.slice(0, 160)}`);
    }
  } finally {
    await app.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    fs.rmSync(TMP, { recursive: true, force: true });
  }
  void REPO; void WEB;
}

main().catch((e: unknown) => { console.error(String(e)); process.exit(1); });
