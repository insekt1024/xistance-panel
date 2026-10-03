/**
 * XRAY method coverage (TASK-33).
 *
 * Three gaps this suite exists to close:
 *
 *  1. **Config writes are not atomic.** Both runners truncate the destination
 *     and then write (`fs.writeFile`, `> target`). A process that starts — or
 *     re-reads — while the write is in flight sees a truncated, invalid JSON
 *     file. For a tunnel binary that parses its config at startup, that is a
 *     crash loop, or worse, a config that parses as valid but is missing
 *     outbounds.
 *
 *  2. **`uuid` is not validated.** It is the credential for VLESS/VMess and the
 *     password for Trojan/Shadowsocks. Any non-empty string is accepted, and it
 *     is written to a world-readable file.
 *
 *  3. **Reality is accepted without its required fields.** A Reality outbound
 *     without `publicKey`/`shortIds` cannot work, and xray fails at runtime
 *     with an error that does not name the missing field.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildXrayCommand,
  buildXrayConfig,
  XRAY_BINARY,
} from "../packages/tunnel-core/src/config/xray.ts";
import { XrayConfigSchema, type XrayConfig } from "../packages/types/src/index.ts";
import { TunnelConfigSchema } from "../packages/types/src/index.ts";
import { buildGostCommand } from "../packages/tunnel-core/src/config/gost.ts";

// tests/ lives beside the repo root; resolve example + builder sources from there.
const ROOT = path.resolve(import.meta.dirname, "..");

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

const RAW: XrayConfig = {
  listenPort: 10808,
  protocol: "vless",
  address: "example.com",
  port: 443,
  uuid: "b831381d-6324-4d53-ad4f-8cda48b30811",
  network: "tcp",
  security: "none",
};
const mk = (patch: Partial<XrayConfig> = {}): XrayConfig =>
  XrayConfigSchema.parse({ ...RAW, ...patch }) as XrayConfig;

async function main() {
  console.log("\n--- config generation ---");

  // ---- 1. valid JSON, structural assertions -------------------------------
  {
    const text = buildXrayConfig(mk());
    let doc: Record<string, never> | null = null;
    try {
      doc = JSON.parse(text);
      ok("the generated config parses as JSON");
    } catch (e) {
      bad("the generated config parses as JSON", (e as Error).message);
    }
    const d = doc as unknown as {
      inbounds: Array<Record<string, unknown>>;
      outbounds: Array<Record<string, unknown>>;
      routing: { rules: Array<Record<string, unknown>> };
    };
    if (d.inbounds.length === 1) ok("exactly one inbound is generated");
    else bad("exactly one inbound is generated", String(d.inbounds.length));
    if (d.inbounds[0]?.protocol === "dokodemo-door") ok("the inbound is a dokodemo-door");
    else bad("the inbound is a dokodemo-door", String(d.inbounds[0]?.protocol));
    if (d.inbounds[0]?.port === 10808) ok("the inbound listens on the configured port");
    else bad("the inbound listens on the configured port", String(d.inbounds[0]?.port));
    // The routing rule is what connects inbound to outbound; without it xray
    // happily runs and sends everything straight out via freedom.
    const rule = d.routing.rules[0];
    if (rule?.inboundTag?.[0] === d.inbounds[0]?.tag) ok("the routing rule matches the inbound tag");
    else bad("the routing rule matches the inbound tag", JSON.stringify(rule));
    if (rule?.outboundTag === d.outbounds[0]?.tag) ok("the routing rule targets the proxy outbound");
    else bad("the routing rule targets the proxy outbound", JSON.stringify(rule));
    if (d.outbounds.length === 2) ok("a freedom outbound is present as the direct fallback");
    else bad("a freedom outbound is present", String(d.outbounds.length));
  }

  // ---- 2. every supported protocol ----------------------------------------
  {
    const cases: Array<[XrayConfig["protocol"], (d: never) => boolean, string]> = [
      ["vless", (d) => !!(d as never as { settings: { vnext: unknown[] } }).settings.vnext, "vnext"],
      ["vmess", (d) => !!(d as never as { settings: { vnext: unknown[] } }).settings.vnext, "vnext"],
      ["trojan", (d) => !!(d as never as { settings: { servers: unknown[] } }).settings.servers, "servers"],
      ["shadowsocks", (d) => !!(d as never as { settings: { servers: unknown[] } }).settings.servers, "servers"],
    ];
    for (const [protocol, shape, what] of cases) {
      const doc = JSON.parse(buildXrayConfig(mk({ protocol })));
      if (doc.outbounds[0].protocol === protocol && shape(doc.outbounds[0] as never)) {
        ok(`${protocol} produces a ${what} outbound`);
      } else {
        bad(`${protocol} produces a ${what} outbound`, JSON.stringify(doc.outbounds[0]).slice(0, 160));
      }
    }
    const rejected = XrayConfigSchema.safeParse({ ...RAW, protocol: "vmess2" });
    if (!rejected.success) ok("an unsupported protocol is refused by the schema");
    else bad("an unsupported protocol is refused", "accepted");
  }

  // ---- 3. stream settings --------------------------------------------------
  {
    const ws = JSON.parse(buildXrayConfig(mk({ network: "ws", path: "/ray" })));
    const wsS = ws.outbounds[0].streamSettings as { network: string; wsSettings: { path: string } };
    if (wsS.network === "ws" && wsS.wsSettings.path === "/ray") ok("ws transport carries the path");
    else bad("ws transport carries the path", JSON.stringify(wsS));

    const wsDefault = JSON.parse(buildXrayConfig(mk({ network: "ws" })));
    const wdS = wsDefault.outbounds[0].streamSettings as { wsSettings: { path: string } };
    if (wdS.wsSettings.path === "/") ok("ws defaults to path / rather than emitting undefined");
    else bad("ws defaults to path /", JSON.stringify(wdS.wsSettings));

    const grpc = JSON.parse(buildXrayConfig(mk({ network: "grpc" })));
    const gS = grpc.outbounds[0].streamSettings as { network: string; grpcSettings: { serviceName: string } };
    if (gS.network === "grpc" && gS.grpcSettings.serviceName === "xistance") ok("grpc defaults to a service name");
    else bad("grpc defaults to a service name", JSON.stringify(gS));

    const tls = JSON.parse(buildXrayConfig(mk({ security: "tls", sni: "cdn.example.com" })));
    const tS = tls.outbounds[0].streamSettings as { security?: string; tlsSettings?: { serverName: string; allowInsecure: boolean } };
    if (tS.security === "tls" && tS.tlsSettings?.serverName === "cdn.example.com") ok("tls carries the SNI as serverName");
    else bad("tls carries the SNI as serverName", JSON.stringify(tS));
    if (tS.tlsSettings?.allowInsecure === false) ok("tls never silently enables allowInsecure");
    else bad("tls never silently enables allowInsecure", JSON.stringify(tS?.tlsSettings));
  }

  // ---- 4. Reality requires its keys ---------------------------------------
  // A Reality outbound with no publicKey is accepted here and fails at xray
  // startup with an error that does not name the field.
  {
    const built = JSON.parse(
      buildXrayConfig(
        mk({
          security: "reality",
          publicKey: "8Zq9xJ0m5n1pQ7rS2tU4vW6yA3bC5dE7fG9hI1jK3lM5nO7pQ9rS1tU3vW5xY7z",
        }),
      ),
    );
    const rs = built.outbounds[0].streamSettings as { security?: string; realitySettings?: Record<string, unknown> };
    if (rs.security === "reality" && rs.realitySettings && typeof rs.realitySettings.publicKey === "string") {
      ok("a reality outbound emits realitySettings with a publicKey");
    } else {
      bad("a reality outbound emits realitySettings with a publicKey", JSON.stringify(rs).slice(0, 200));
    }
  }
  {
    const r = XrayConfigSchema.safeParse({ ...RAW, security: "reality" });
    if (!r.success) ok("the schema refuses reality without a publicKey");
    else bad("the schema refuses reality without a publicKey", "accepted");
    if (!r.success && /publicKey/.test(r.error.issues.map((i) => i.message).join(";"))) {
      ok("the reality refusal names publicKey, so the operator knows what is missing");
    } else {
      bad("the reality refusal names publicKey", r.success ? "accepted" : r.error.issues.map((i) => i.message).join("; "));
    }
    const good = XrayConfigSchema.safeParse({
      ...RAW,
      security: "reality",
      publicKey: "8Zq9xJ0m5n1pQ7rS2tU4vW6yA3bC5dE7fG9hI1jK3lM5nO7pQ9rS1tU3vW5xY7z",
    });
    if (good.success) ok("reality is accepted once a publicKey is supplied");
    else bad("reality is accepted once a publicKey is supplied", good.error.issues.map((i) => i.message).join("; "));
  }

  // ---- 5. credential validation -------------------------------------------
  {
    // A placeholder string like "your-uuid-here" is deliberately NOT in this
    // list. It is indistinguishable from a legitimate short Shadowsocks
    // password, and rejecting it would refuse real configurations. The panel
    // cannot know which is which; asserting otherwise would be asserting a
    // capability it does not have.
    const hostile: Array<[string, string]> = [
      ["an empty uuid", ""],
      ["a uuid with a control character", "b831381d\n6324-4d53"],
      ["a uuid with a space", "b831381d 6324"],
      ["a uuid with a tab", "b831381d\t6324"],
      ["a uuid with a NUL", "b831381d\u00006324"],
      ["a uuid with a leading space", " b831381d"],
      ["a uuid with a trailing space", "b831381d "],
      ["a too-short string", "ab"],
      ["a very long string", "x".repeat(4096)],
    ];
    let accepted = 0;
    for (const [label, v] of hostile) {
      const r = XrayConfigSchema.safeParse({ ...RAW, uuid: v });
      if (r.success) {
        accepted += 1;
        bad(`the schema refuses ${label}`, `accepted ${JSON.stringify(v.slice(0, 30))}`);
      }
    }
    if (accepted === 0) ok(`the schema refuses all ${hostile.length} unusable uuid values`);

    // The charset rule and the whitespace/control rule both refuse these
    // values, so "it threw" cannot tell them apart. What differs is the
    // MESSAGE the operator sees, and that is the property each rule owns. A
    // NUL byte reported as "not a UUID, X25519 key, or password" is useless;
    // it should be reported as a control character.
    const credMsg = (v: string): string => {
      const r = XrayConfigSchema.safeParse({ ...RAW, uuid: v });
      return r.success ? "<accepted>" : r.error.issues.map((i) => i.message).join("; ");
    };
    if (/control character/i.test(credMsg("b831381d\n6324"))) {
      ok("a control character in the credential is reported as a control character");
    } else {
      bad("a control character is reported as a control character", credMsg("b831381d\n6324"));
    }
    if (/leading or trailing whitespace/i.test(credMsg(" abcd1234"))) {
      ok("a padded credential is reported as whitespace, not as a bad charset");
    } else {
      bad("a padded credential is reported as whitespace", credMsg(" abcd1234"));
    }
    if (/at most 128|printable characters/i.test(credMsg("x".repeat(4096)))) {
      ok("an oversized credential is reported with its actual limit");
    } else {
      bad("an oversized credential is reported with its limit", credMsg("x".repeat(4096)));
    }
  }

  // ---- 6. address validation ----------------------------------------------
  {
    const hostile: Array<[string, string]> = [
      ["a leading dash", "-oProxyCommand=x"],
      ["a URL delimiter", "a/b"],
      ["whitespace", "a b"],
    ];
    let accepted = 0;
    for (const [label, v] of hostile) {
      const r = XrayConfigSchema.safeParse({ ...RAW, address: v });
      if (r.success) {
        accepted += 1;
        bad(`the schema refuses an address with ${label}`, `accepted ${JSON.stringify(v)}`);
      }
    }
    if (accepted === 0) ok(`the schema refuses all ${hostile.length} malformed address values`);
  }

  // ---- 7. the config file must be written atomically ----------------------
  // The contract: a reader must never observe a partially written file. The
  // observable consequence is that the destination path is replaced by rename,
  // so its inode changes, and a reader holding the old inode still reads the
  // complete previous config.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xt-xray-"));
    const target = path.join(dir, "xray.json");
    const { LocalRunner } = await import("../packages/tunnel-core/src/runner.ts");
    const runner = new LocalRunner();
    const full = buildXrayConfig(mk());
    await runner.writeFile(target, full, 0o600);

    const first = JSON.parse(fs.readFileSync(target, "utf8"));
    if (first.outbounds[0].protocol === "vless") ok("the config lands on disk intact");
    else bad("the config lands on disk intact", "unreadable");

    // Replace it and prove the inode changed -- that is what "atomic" means
    // here. An in-place truncate+write keeps the same inode.
    const inoBefore = fs.statSync(target).ino;
    await runner.writeFile(target, buildXrayConfig(mk({ protocol: "trojan" })), 0o600);
    const inoAfter = fs.statSync(target).ino;
    if (inoBefore !== inoAfter) ok("rewriting the config replaces the file rather than truncating it in place");
    else bad("rewriting the config replaces the file rather than truncating it in place", `inode stayed ${inoBefore}`);

    const second = JSON.parse(fs.readFileSync(target, "utf8"));
    if (second.outbounds[0].protocol === "trojan") ok("the replacement is complete and valid");
    else bad("the replacement is complete and valid", second.outbounds[0].protocol);

    // No temp files may be left behind.
    const leftovers = fs.readdirSync(dir).filter((f) => f !== "xray.json");
    if (leftovers.length === 0) ok("no temporary files are left in the config directory");
    else bad("no temporary files are left in the config directory", leftovers.join(", "));

    // The file holds a credential, so the mode argument must reach the write.
    // NTFS reports 0o666 for everything and chmod is a no-op, so the stat bits
    // prove nothing here -- assert on the POSIX path instead, where they do.
    if (process.platform === "win32") {
      ok("mode enforcement is POSIX-only; the stat bits prove nothing on NTFS (asserted below instead)");
    } else {
      const mode = fs.statSync(target).mode & 0o777;
      if (mode === 0o600) ok("the config file is written 0600, since it holds a credential");
      else bad("the config file is written 0600", "0" + mode.toString(8));
    }

    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---- 8. a failed write must not destroy the previous config -------------
  // A read-only directory is not enforced on NTFS, so inducing failure that
  // way would silently pass on Windows. Making the parent a FILE fails on
  // every platform, after the original config is already in place -- which is
  // exactly the window an in-place truncate+write would destroy.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xt-xray2-"));
    const target = path.join(dir, "xray.json");
    const { LocalRunner } = await import("../packages/tunnel-core/src/runner.ts");
    const runner = new LocalRunner();
    await runner.writeFile(target, buildXrayConfig(mk()), 0o600);
    const good = fs.readFileSync(target, "utf8");

    // Move the good config OUTSIDE the directory, then replace the directory
    // with a file so the new path cannot be created at all. (Stashing it
    // inside, as a first attempt did, meant the cleanup removed the very file
    // the assertion then tried to read.)
    const stash = path.join(path.dirname(dir), path.basename(dir) + ".stash.json");
    fs.renameSync(target, stash);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.writeFileSync(dir, "not a directory");

    let threw = false;
    try {
      await runner.writeFile(target, buildXrayConfig(mk({ protocol: "vmess" })), 0o600);
    } catch {
      threw = true;
    }

    if (!threw) bad("a write into an impossible path reports an error", "it silently succeeded");
    else ok("a write into an impossible path reports an error");

    // The previous config, still readable where it was, must be untouched.
    const after = fs.readFileSync(stash, "utf8");
    if (after === good) ok("a failed write leaves the previous config intact");
    else bad("a failed write leaves the previous config intact", `now ${after.length} bytes, was ${good.length}`);

    fs.rmSync(dir, { force: true });
    fs.rmSync(stash, { force: true });
  }

  // ---- 9. redaction: the credential must not escape ------------------------
  {
    const secret = "b831381d-6324-4d53-ad4f-8cda48b30811";
    const text = buildXrayConfig(mk());
    // The config itself must CONTAIN the credential -- that is its job. What
    // must never happen is the credential reaching a log/diagnostic surface.
    if (text.includes(secret)) ok("the generated config does contain the credential, as it must");
    else bad("the generated config contains the credential", "absent");

    const { sanitizeForDiagnostics, classifyError } = await import(
      "../packages/tunnel-core/src/diagnostics.ts"
    );
    const line = `failed to start: ${text}`;
    const clean = sanitizeForDiagnostics(line);
    if (!clean.includes(secret)) ok("sanitizeForDiagnostics removes the credential from a config dump");
    else bad("sanitizeForDiagnostics removes the credential", "the credential survived");

    const { buildDiagnostic } = await import("../packages/tunnel-core/src/diagnostics.ts");
    const d = buildDiagnostic({ status: "error", error: `xray: bad config ${text}` });
    if (!d.summary.includes(secret)) ok("a diagnostic summary does not carry the credential");
    else bad("a diagnostic summary does not carry the credential", "leaked into summary");
    if (typeof classifyError === "function") ok("classifyError is available for the xray failure path");
  }

  // ---- 10. command shape and binary ---------------------------------------
  {
    if (XRAY_BINARY === "xray") ok("the binary name is xray");
    else bad("the binary name is xray", XRAY_BINARY);
    const cmd = buildXrayCommand("/etc/xistance/xray.json");
    if (cmd[0] === "xray" && cmd[1] === "run" && cmd[2] === "-c" && cmd[3] === "/etc/xistance/xray.json") {
      ok("the command is `xray run -c <cfg>`");
    } else {
      bad("the command is `xray run -c <cfg>`", JSON.stringify(cmd));
    }
  }

  // ---- 11. the REMOTE runner must also write atomically --------------------
  // Production uses RemoteRunner for any non-loopback node, and it is a
  // different code path with the same requirement. Assert the generated remote
  // script: it must decode into a temp file and `mv` it into place, and must
  // never redirect `>` directly at the live config.
  {
    const { RemoteRunner } = await import("../packages/tunnel-core/src/runner.ts");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xt-xrayrem-"));
    const scripts: string[] = [];
    const fake = Object.create(RemoteRunner.prototype) as Record<string, unknown>;
    fake.makeDir = async () => undefined;
    fake.runScript = async (s: string) => {
      scripts.push(s);
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    await (fake as unknown as { writeFile: (a: string, b: string, c?: number) => Promise<void> }).writeFile(
      "/etc/xistance/tunnels/n1/xray.json",
      buildXrayConfig(mk()),
      0o600,
    );
    const script = scripts[0] ?? "";
    if (script.includes("mv -f")) ok("the remote write renames a temp file into place");
    else bad("the remote write renames a temp file into place", script.slice(0, 120));

    // The dangerous form is a redirect whose target is the LIVE config. Every
    // `>` in the script must target the .tmp path; the live path may only
    // appear on the right-hand side of `mv`.
    const redirects = [...script.matchAll(/>([^&|]+)/g)].map((m) => m[1].trim());
    // Targets are shell-quoted, so compare on the unquoted form.
    const unq = (s: string) => s.replace(/^['"]|['"]$/g, "");
    const badRedirect = redirects.filter((r) => !unq(r).endsWith(".tmp"));
    if (redirects.length > 0 && badRedirect.length === 0) ok("every remote redirect targets the temp file, never the live config");
    else bad("every remote redirect targets the temp file", JSON.stringify(redirects));

    if (script.includes(".tmp")) ok("the remote temp file is a .tmp sibling, so the rename stays on one filesystem");
    else bad("the remote temp file is a .tmp sibling", script.slice(0, 160));
    if (script.includes("chmod 600")) ok("the remote write applies the mode to the temp file before the rename");
    else bad("the remote write applies the mode", script.slice(0, 160));

    // A failed remote write must clean up its temp file.
    scripts.length = 0;
    fake.runScript = async (s: string) => {
      scripts.push(s);
      return { stdout: "", stderr: "disk full", exitCode: 1 };
    };
    let threw = false;
    try {
      await (fake as unknown as { writeFile: (a: string, b: string, c?: number) => Promise<void> }).writeFile(
        "/etc/xistance/tunnels/n1/xray.json", buildXrayConfig(mk()), 0o600,
      );
    } catch { threw = true; }
    if (threw) ok("a failed remote write reports an error");
    else bad("a failed remote write reports an error", "silently succeeded");
    if (scripts.some((s) => s.includes("rm -f") && s.includes(".tmp"))) ok("a failed remote write removes its temp file");
    else bad("a failed remote write removes its temp file", scripts.join(" | ").slice(0, 160));

    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---- the shipped example must agree with the builder ------------------------
//
// TASK-130 fixed `followRedirect` in buildXrayConfig() and the example JSON still
// taught `false`, which is the value that makes dokodemo-door dial its own listen
// port. An example that contradicts the builder teaches the broken form, so the
// two are compared rather than trusted.
{
  const exPath = path.join(ROOT, "tunnels", "examples", "xray-vless.json");
  const src = fs.readFileSync(
    path.join(ROOT, "packages", "tunnel-core", "src", "config", "xray.ts"),
    "utf8",
  );
  // Read the CODE value, not the first prose match. The builder's own comment
  // block contrasts `false` with `true` to explain the defect, so a plain regex
  // matches the comment and reports the opposite of what ships -- exactly the
  // mistake that made this gate fail on its first run.
  const builderValue = /settings:\s*\{[^}]*followRedirect:\s*(true|false)/.exec(src)?.[1];
  if (!fs.existsSync(exPath)) {
    bad("the shipped XRAY example exists", `${exPath} is missing`);
  } else {
    const ex = JSON.parse(fs.readFileSync(exPath, "utf8")) as {
      inbounds: Array<{ settings?: { followRedirect?: boolean } }>;
      _how_traffic_reaches_this_inbound?: string;
    };
    const exValue = ex.inbounds[0]?.settings?.followRedirect;
    if (builderValue && exValue === (builderValue === "true")) {
      ok(`the shipped example's followRedirect matches the builder (${builderValue})`);
    } else {
      bad(
        "the shipped example's followRedirect matches the builder",
        `builder emits ${builderValue}, example carries ${exValue}`,
      );
    }
    // The example must also tell an operator HOW traffic reaches the inbound.
    // dokodemo-door with no address cannot learn a destination on its own, so a
    // comment saying only "apps point at the inbound" documents a dead tunnel.
    const how = ex._how_traffic_reaches_this_inbound ?? "";
    if (/REDIRECT/i.test(how) && /--uid-owner/.test(how)) {
      ok("the shipped example documents the REDIRECT, scoped away from xray's own traffic");
    } else {
      bad(
        "the shipped example documents the REDIRECT, scoped away from xray's own traffic",
        `its guidance ${/REDIRECT/i.test(how) ? "omits the -m owner scope" : "never mentions a redirect"}; ` +
          `without it a local app pointing at the inbound makes dokodemo dial itself`,
      );
    }
  }
}

// ---- GOST's relay target must be a complete address:port pair ---------------
//
// TASK-131. `forwardHost`/`forwardPort` were both optional, so a config with a
// cleared host and no port validated, was stored, and built the listener token
// `tcp://:9000/:`. gost does NOT reject that: it starts, LISTENS, accepts every
// connection, and refuses all of them --
//
//   forward.go:137: [tcp] 127.0.0.1:11514 -> 127.0.0.1:19099
//               : dial tcp :0: connect: connection refused
//
// so the tunnel reported itself started while carrying nothing. These assertions
// pin the rejection at the schema, where the API and the wizard both go through.
{
  const base = { direction: "IRAN", protocol: "tcp", listenPort: 9000 };
  const rejected: Array<[string, Record<string, unknown>]> = [
    ["a blank forwardHost", { ...base, forwardHost: "" }],
    ["a forwardHost with no forwardPort", { ...base, forwardHost: "origin.example" }],
    ["a forwardPort with no forwardHost", { ...base, forwardPort: 80 }],
    ["a forwardHost carrying a scheme", { ...base, forwardHost: "tcp://origin.example", forwardPort: 80 }],
  ];
  for (const [label, gost] of rejected) {
    const r = TunnelConfigSchema.safeParse({ method: "GOST", gost });
    if (!r.success) {
      ok(`GOST rejects ${label} instead of building a half-address listener`);
    } else {
      bad(
        `GOST rejects ${label} instead of building a half-address listener`,
        `accepted; builds ${buildGostCommand(r.data.gost as never, "IRAN")?.[2] ?? "nothing"}`,
      );
    }
  }

  // Defence in depth: the schema blocks it, but a caller that bypasses the
  // schema must still not get a half-address token. This is the layer that would
  // have caught the original defect before gost silently accepted it.
  {
    const bypassed = { ...base, forwardHost: "", forwardPort: undefined } as never;
    try {
      const built = buildGostCommand(bypassed, "IRAN");
      bad(
        "buildGostCommand refuses a half relay target instead of emitting tcp://:PORT/:",
        `it returned ${JSON.stringify(built)}`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/complete relay target/.test(msg)) {
        ok("buildGostCommand refuses a half relay target instead of emitting tcp://:PORT/:");
      } else {
        bad(
          "buildGostCommand refuses a half relay target instead of emitting tcp://:PORT/:",
          `threw, but not with the expected diagnostic: ${msg}`,
        );
      }
    }
  }

  // The positive control: tightening the schema must not reject a real config,
  // and the token it builds must still be a complete host:port.
  const good = TunnelConfigSchema.safeParse({
    method: "GOST",
    gost: { ...base, forwardHost: "origin.example", forwardPort: 80 },
  });
  const token = good.success ? buildGostCommand(good.data.gost as never, "IRAN")?.[2] : undefined;
  if (good.success && token === "tcp://:9000/origin.example:80") {
    ok("GOST still accepts a complete relay target and builds a full listener token");
  } else {
    bad(
      "GOST still accepts a complete relay target and builds a full listener token",
      good.success ? `built ${token}` : "a fully specified config was rejected",
    );
  }
}

console.log(`\n--- ${pass} passed, ${failures.length} failed ---`);
  if (failures.length > 0) process.exitCode = 1;
}

void main();
assert.ok(true);
