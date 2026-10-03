/**
 * TASK-16 — smoke test for protected localized routes and their static assets.
 *
 * TASK-6 proved that public/ and .next/static are *staged*. This proves the
 * staged standalone server actually *serves* them, and that a protected route
 * is genuinely protected, without a source checkout, a browser, or any real
 * credential.
 *
 * The server is started from a staged artifact against a temporary SQLite
 * database, with disposable secrets generated per run. The admin is created by
 * the same create-admin.mjs the installer uses, so the login path exercised
 * here is the real one.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import { collectAssetReferences, mimeOk } from "./lib/asset-refs";
import { pickPort } from "./lib/pick-port";

const repoRoot = path.resolve(__dirname, "..");

/** The engine filename Prisma will look for on this host. */
function requiredEngine(): string {
  if (process.platform === "win32") return "query_engine-windows.dll.node";
  if (process.platform === "darwin") return "libquery_engine-darwin.dylib.node";
  const musl = detectMusl();
  if (musl) return "libquery_engine-linux-musl-openssl-3.0.x.so.node";
  return "libquery_engine-debian-openssl-3.0.x.so.node";
}

function detectMusl(): boolean {
  try {
    const report = fs.readFileSync("/usr/bin/ldd", "utf8");
    return report.includes("musl");
  } catch {
    return false;
  }
}

/**
 * Exit code meaning "cannot run here, needs a matching host".
 *
 * The release artifact ships a single architecture's Prisma engine, so booting
 * it on a different host fails with a confusing engine error. Reporting that
 * as a pass would be worse than useless, so this is a distinct, non-zero
 * result that CI and humans both have to notice.
 */
const EXIT_SKIP = 77;

function tempRoot(): string {
  // os.tmpdir() is the POSIX answer and is ALWAYS defined. TMPDIR/TEMP/TMP are
  // conventions, not guarantees: GitHub's runners set none of them, so a suite
  // that requires one fails there while passing on any developer machine that
  // exports it. This assertion was how three suites went red in CI.
  const base = process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP ?? os.tmpdir();
  assert.ok(base, "a temporary directory is required");
  return fs.mkdtempSync(path.join(base, "xistance-smoke-"));
}

/** Ask the OS for a free port. */
const freePort = (): Promise<number> => pickPort("127.0.0.1");

interface Fetched {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  location: string | null;
}

function get(url: string, cookie?: string): Promise<Fetched> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const request = http.get(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        headers: cookie ? { cookie } : {},
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
            location: response.headers.location ?? null,
          }),
        );
      },
    );
    request.on("error", reject);
  });
}

/** Follow a single redirect, returning the destination response. */
async function follow(url: string): Promise<{ finalUrl: string; response: Fetched }> {
  let current = url;
  for (let hop = 0; hop < 5; hop += 1) {
    const response = await get(current);
    if (response.status >= 300 && response.status < 400 && response.location) {
      current = new URL(response.location, current).toString();
      continue;
    }
    return { finalUrl: current, response };
  }
  return { finalUrl: current, response: await get(current) };
}

/** Collect local static references out of a Next.js document. */
interface ServerHandle {
  child: ChildProcess;
  port: number;
  dataDir: string;
  password: string;
  stderr: string[];
  stop(): Promise<void>;
}

async function startStagedServer(artifactRoot: string): Promise<ServerHandle> {
  const dataDir = fs.mkdtempSync(path.join(tempRoot(), "data-"));
  const port = await freePort();

  // Disposable secrets, generated per run and never printed.
  const secret = randomBytes(32).toString("hex");
  const password = `Smoke-${randomBytes(12).toString("hex")}`;
  const dbPath = path.join(dataDir, "app.db");

  const migrator = spawnSync(
    process.execPath,
    [
      path.join(artifactRoot, "apply-migrations.mjs"),
      "--database", `file:${dbPath}`,
      "--migrations", path.join(artifactRoot, "packages", "db", "prisma", "migrations"),
    ],
    { encoding: "utf8" },
  );
  if (migrator.status !== 0) {
    throw new Error(`migrations failed in the staged artifact: ${migrator.stderr || migrator.stdout}`);
  }

  const admin = spawnSync(
    process.execPath,
    [
      path.join(artifactRoot, "create-admin.mjs"),
      "--database", `file:${dbPath}`,
      "--email", "smoke@xistance.local",
      "--password", password,
    ],
    { encoding: "utf8" },
  );
  if (admin.status !== 0) {
    throw new Error(`admin creation failed in the staged artifact: ${admin.stderr || admin.stdout}`);
  }

  const serverJs = path.join(artifactRoot, "apps", "web", "server.js");
  if (!fs.existsSync(serverJs)) throw new Error(`staged artifact has no server.js at ${serverJs}`);

  const stderr: string[] = [];
  const child = spawn(process.execPath, [serverJs], {
    cwd: path.join(artifactRoot, "apps", "web"),
    env: {
      ...process.env,
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      NODE_ENV: "production",
      DATABASE_URL: `file:${dbPath}`,
      XT_SECRET_KEY: secret,
      // A local, disposable origin: never a real deployment's.
      XT_PUBLIC_URL: `http://127.0.0.1:${port}`,
      NEXTAUTH_SECRET: secret,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
  child.stdout?.on("data", () => undefined);

  // Wait for readiness rather than sleeping a fixed amount.
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) break;
    try {
      const health = await get(`${base}/api/health`);
      if (health.status === 200) { ready = true; break; }
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  if (!ready) {
    child.kill();
    // Only the tail of stderr, and never the disposable secrets.
    const tail = stderr.join("").split("\n").slice(-12).join("\n").replace(secret, "[redacted]");
    throw new Error(`the staged server did not become ready.\n${tail}`);
  }

  return {
    child,
    port,
    dataDir,
    password,
    stderr,
    stop: async () => {
      child.kill();
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) { resolve(); return; }
        child.once("exit", () => resolve());
        setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5000);
      });
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function main(): Promise<void> {
  const artifactRoot = process.env.XT_SMOKE_ARTIFACT ?? path.join(repoRoot, "dist", "artifact");
  const failures: string[] = [];

  if (!fs.existsSync(path.join(artifactRoot, "apps", "web", "server.js"))) {
    console.error(
      `No staged artifact at ${artifactRoot}. Run stage-release-artifact.ts first, ` +
        "or set XT_SMOKE_ARTIFACT.",
    );
    process.exit(1);
  }

  const clientDir = path.join(artifactRoot, "packages", "db", "generated", "client");
  const needed = requiredEngine();
  if (!fs.existsSync(path.join(clientDir, needed))) {
    const shipped = fs
      .readdirSync(clientDir)
      .filter((entry) => entry.endsWith(".node"));
    console.error(
      `This host (${process.platform}/${process.arch}) needs ${needed}, but the staged artifact ` +
        `ships only: ${shipped.join(", ") || "no engine at all"}.\n` +
        "The artifact is single-architecture by design, so this test can only run where the " +
        "release targets. Re-stage for this platform, or run it on the target host.",
    );
    process.exit(EXIT_SKIP);
  }

  const server = await startStagedServer(artifactRoot);
  const base = `http://127.0.0.1:${server.port}`;
  const password = server.password;

  try {
    // -----------------------------------------------------------------------
    // 1. Health reports a reachable database.
    // -----------------------------------------------------------------------
    const health = await get(`${base}/api/health`);
    if (health.status !== 200) {
      failures.push(`health returned ${health.status}, expected 200`);
    }
    if (!/"database"\s*:\s*"(ok|reachable|up)"/.test(health.body)) {
      failures.push(`health did not report a reachable database: ${health.body.slice(0, 200)}`);
    }

    // -----------------------------------------------------------------------
    // 2. A protected localized route is protected.
    // -----------------------------------------------------------------------
    // The dashboard lives under [locale]/(app); unauthenticated it must not
    // return panel content.
    const protectedResult = await follow(`${base}/en/tunnels`);
    if (protectedResult.response.status === 200) {
      const looksLikePanel = /password|sign in|login/i.test(protectedResult.response.body);
      if (!looksLikePanel) {
        failures.push("an unauthenticated request to a protected route returned panel content");
      }
    } else if (protectedResult.response.status < 300 || protectedResult.response.status >= 400) {
      failures.push(
        `protected route answered ${protectedResult.response.status} without redirecting to a login page`,
      );
    }

    // -----------------------------------------------------------------------
    // 3. The login page renders, in each supported locale.
    // -----------------------------------------------------------------------
    const locales = ["en", "fa"];
    for (const locale of locales) {
      // localePrefix is "as-needed", so the default locale answers with a
      // redirect to the unprefixed path. That redirect is correct behaviour,
      // so it is followed rather than treated as a failure.
      const loginTrace = await follow(`${base}/${locale}/login`);
      const login = loginTrace.response;
      if (login.status !== 200) {
        failures.push(
          `/${locale}/login returned ${login.status} (final url ${loginTrace.finalUrl}, ` +
            `location ${login.location ?? "(none)"})`,
        );
        continue;
      }
      if (!/<html|<!doctype/i.test(login.body)) {
        failures.push(`/${locale}/login did not return an HTML document`);
        continue;
      }

      // -------------------------------------------------------------------
      // 4. Every local asset the login page references must actually load.
      // -------------------------------------------------------------------
      const references = collectAssetReferences(login.body);
      if (references.length === 0) {
        failures.push(`/${locale}/login referenced no static assets; the smoke test would be vacuous`);
      }
      for (const reference of references) {
        const asset = await get(`${base}${reference}`);
        if (asset.status !== 200) {
          failures.push(`asset ${reference} returned ${asset.status}, expected 200`);
          continue;
        }
        if (!mimeOk(asset.headers, reference)) {
          failures.push(
            `asset ${reference} returned content-type "${String(asset.headers["content-type"] ?? "(none)")}"`,
          );
        }
      }
    }

    // -----------------------------------------------------------------------
    // 5. No secret ever appears in what the server logged.
    // -----------------------------------------------------------------------
    const logged = server.stderr.join("");
    if (logged.includes(password)) {
      failures.push("the server wrote the disposable password to its log");
    }
  } finally {
    await server.stop();
  }

  if (failures.length > 0) {
    // Summaries only: no bodies, no credentials.
    console.error(`\n❌ Protected-route smoke test failed (${failures.length} problem(s)):`);
    for (const failure of failures) console.error(`   - ${failure}`);
    process.exit(1);
  }

  console.log(
    "✅ Protected-route smoke: health, auth redirect, localized login, and every referenced asset served",
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
