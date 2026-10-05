// Does the payload the ICMP wizard builds actually validate?
//
// The wizard constructs `icmp` in JSX-free code paths that typecheck but are
// never executed by another suite. A wizard that builds a config the server
// rejects would fail only at runtime, on a user's click -- so this feeds the
// exact object the wizard builds through the real schema.
import { TunnelConfigSchema } from "../packages/types/src/index.js";

// Mirrors buildPayload() in tunnel-wizard.tsx for method === "ICMP".
function wizardPayload(state) {
  return {
    method: "ICMP",
    icmp: {
      sock5: state.sock5,
      protocol: state.protocol,
      listenAddr: state.listenAddr,
      ...(state.sock5 ? {} : { targetHost: state.targetHost, targetPort: state.targetPort }),
      key: state.key,
      encryption: state.encryption,
      ...(state.encryption === "none" ? {} : { encryptionKey: state.encryptionKey }),
      maxConn: 0,
      icmpListen: "0.0.0.0",
      timeoutSecs: 60,
    },
  };
}

const base = {
  sock5: false,
  protocol: "tcp",
  listenAddr: ":1080",
  targetHost: "",
  targetPort: 80,
  key: 123456,
  encryption: "none",
  encryptionKey: "",
};

let pass = 0;
let fail = 0;
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`      ok   ${name}`);
    pass++;
  } else {
    console.log(`      FAIL ${name}${detail ? `\n           ${detail}` : ""}`);
    fail++;
  }
}

// The default wizard state has an empty targetHost, which the schema must
// refuse -- an empty host would build `target: ":80"`, a tunnel that starts and
// then refuses every connection. The wizard's own validateConfig() catches this
// before submit; the schema is the backstop.
const withTarget = wizardPayload({ ...base, targetHost: "198.51.100.5", targetPort: 8080 });
const r1 = TunnelConfigSchema.safeParse(withTarget);
check(
  "the ICMP wizard payload validates against the real schema",
  r1.success,
  r1.success ? "" : JSON.stringify(r1.error.issues.slice(0, 2)),
);

const r2 = TunnelConfigSchema.safeParse(wizardPayload(base));
check(
  "an empty targetHost is refused (would otherwise build target=':80')",
  !r2.success,
);

const r3 = TunnelConfigSchema.safeParse(
  wizardPayload({ ...base, targetHost: "198.51.100.5", targetPort: 8080, encryption: "aes256" }),
);
check(
  "an encryption algorithm with no passphrase is refused",
  !r3.success,
);

const r4 = TunnelConfigSchema.safeParse(
  wizardPayload({ ...base, targetHost: "198.51.100.5", targetPort: 8080, sock5: true }),
);
check(
  "SOCKS5 mode with no target validates (the wizard drops it)",
  r4.success,
  r4.success ? "" : JSON.stringify(r4.error.issues.slice(0, 2)),
);

const r5 = TunnelConfigSchema.safeParse(
  wizardPayload({ ...base, targetHost: "198.51.100.5", targetPort: 8080, encryption: "chacha20", encryptionKey: "cGFzc3" }),
);
check("SOCKS5-style base64 passphrase validates when paired with an algorithm", r5.success);

// The import dialog is the other entry point: a user pastes a config and the
// dialog derives the method from the config SHAPE, then the server validates it
// against the same union. Both halves are exercised here with the exact shape
// buildIcmpClientConfig() emits, because a paste that derives the wrong method
// is rejected with a message about a method the user never chose.

// Mirrors deriveMethod() in import-dialog.tsx.
function deriveMethod(cfg) {
  if (!cfg || typeof cfg !== "object") return null;
  const c = cfg;
  for (const k of ["backhaul", "frp", "gost", "icmp", "ssh", "direct", "reverse", "xray", "xui"]) {
    if (c[k] !== undefined) return k.toUpperCase();
  }
  if (Array.isArray(c.portForwards)) return "PORT_FORWARD";
  return null;
}

// r1.success is asserted above, so its narrowed `data` is the validated config.
// Rebuilding the paste from it keeps this typed without an `any` cast.
if (!r1.success) throw new Error("the ICMP wizard payload must validate");
const pasted = { method: "ICMP", icmp: r1.data.icmp };
check("a pasted ICMP config derives ICMP from its shape", deriveMethod(pasted) === "ICMP");
check("a pasted ICMP config validates against the same union", TunnelConfigSchema.safeParse(pasted).success);

console.log(`--- ${pass} passed, ${fail} failed ---`);
process.exit(fail > 0 ? 1 : 0);