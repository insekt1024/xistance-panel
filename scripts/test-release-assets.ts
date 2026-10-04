/**
 * Focused TASK-6 regression test for standalone public/static asset staging.
 * Runs without a browser and is portable across Windows and Ubuntu.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

function request(server: http.Server, urlPath: string): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const address = server.address();
    if (!address || typeof address === "string") {
      reject(new Error("HTTP fixture server is not listening on a TCP port"));
      return;
    }
    const request = http.get({ hostname: "127.0.0.1", port: address.port, path: urlPath }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) }));
    });
    request.on("error", reject);
  });
}

async function main(): Promise<void> {
  const { stageReleaseAssets } = await import("./stage-release-assets.ts");
  const fixtureRoot = fs.mkdtempSync(path.join(
      process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP ?? os.tmpdir(),
      "xistance-release-assets-",
    ));
  const fixtureApp = path.join(fixtureRoot, "apps", "web");
  const fixtureNext = path.join(fixtureApp, ".next");
  const fixtureStandaloneApp = path.join(fixtureNext, "standalone", "apps", "web");
  const fixtureStatic = path.join(fixtureNext, "static");
  const fixturePublic = path.join(fixtureApp, "public");

  fs.mkdirSync(fixtureStandaloneApp, { recursive: true });
  fs.mkdirSync(path.join(fixtureStatic, "chunks"), { recursive: true });
  fs.mkdirSync(path.join(fixtureStatic, "media"), { recursive: true });
  fs.mkdirSync(path.join(fixturePublic), { recursive: true });
  fs.writeFileSync(path.join(fixtureStandaloneApp, "server.js"), "fixture\n");
  fs.writeFileSync(path.join(fixtureStatic, "chunks", "app.js"), "console.log('app');\n");
  fs.writeFileSync(path.join(fixtureStatic, "chunks", "app.css"), "body { display: block; }\n");
  fs.writeFileSync(path.join(fixtureStatic, "media", "font.woff2"), "fixture font\n");
  fs.writeFileSync(path.join(fixturePublic, "robots.txt"), "User-agent: *\n");
  const nestedStatic = path.join(fixtureStandaloneApp, ".next", "static", "static");
  fs.mkdirSync(nestedStatic, { recursive: true });
  fs.writeFileSync(path.join(nestedStatic, "stale.js"), "stale\n");

  try {
    await stageReleaseAssets(fixtureRoot);

    const fixtureStaticDestination = path.join(fixtureStandaloneApp, ".next", "static");
    const fixturePublicDestination = path.join(fixtureStandaloneApp, "public");
    for (const relativePath of ["chunks/app.js", "chunks/app.css", "media/font.woff2"]) {
      assert.ok(fs.existsSync(path.join(fixtureStaticDestination, relativePath)), `Missing staged fixture: ${relativePath}`);
    }
    assert.ok(fs.existsSync(path.join(fixturePublicDestination, "robots.txt")), "Missing staged public fixture");
    assert.ok(!fs.existsSync(path.join(fixtureStaticDestination, "static")), "fixture static/static must not exist");
    assert.ok(!fs.existsSync(path.join(fixturePublicDestination, "public")), "fixture public/public must not exist");

    const server = http.createServer((request, response) => {
      if (request.url === "/robots.txt") {
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        response.end(fs.readFileSync(path.join(fixturePublicDestination, "robots.txt")));
        return;
      }
      if (request.url?.startsWith("/_next/")) {
        const relativePath = decodeURIComponent(request.url.slice("/_next/".length));
        const file = path.resolve(fixtureStaticDestination, relativePath);
        if (!file.startsWith(`${fixtureStaticDestination}${path.sep}`) || !fs.existsSync(file)) {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(200).end(fs.readFileSync(file));
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const publicResponse = await request(server, "/robots.txt");
      assert.equal(publicResponse.status, 200);
      assert.equal(publicResponse.body.toString("utf8"), "User-agent: *\n");

      for (const relativePath of ["chunks/app.js", "chunks/app.css", "media/font.woff2"]) {
        const response = await request(server, `/_next/${relativePath}`);
        assert.equal(response.status, 200);
        assert.deepEqual(response.body, fs.readFileSync(path.join(fixtureStatic, relativePath)));
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }

  console.log("✅ Release assets: public/static layout and JS/CSS/media HTTP smoke passed");
}


main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
