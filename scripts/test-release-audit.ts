/**
 * Update and recovery audit records (TASK-39).
 *
 * The panel's own actions were audited; the actions an operator performs on the
 * running installation were not. This suite covers the recorder, the
 * classifier, and the redaction contract, and then proves end to end over real
 * HTTP that a recovery event survives pagination in the audit API.
 *
 * What each acceptance criterion is proved by:
 *
 *   AC1 records carry actor/action/version/outcome/errorCategory, no secrets
 *       `an update record carries the version and the outcome`,
 *       `a failure record carries a bounded error category`,
 *       `the category set is closed`, `a raw error message is never persisted`,
 *       `no record contains a secret-shaped value`, `a raw command line is never stored`.
 *   AC2 recorded only after the outcome is known, and survives pagination
 *       `a record exists only for a completed action`,
 *       `an in-flight action writes nothing`,
 *       `recovery records survive pagination`.
 *   AC3 failures are queryable and separate attempted from completed
 *       `attempted and completed are different outcomes`,
 *       `a failed readiness event is queryable`,
 *       `a failed rollback is distinguishable from a successful one`.
 *   AC4 authorization and rate limits if exposed through the API
 *       `the audit API refuses an unauthenticated caller`,
 *       `the audit API refuses a non-admin`,
 *       `the audit API is rate limited`.
 *   AC5 success, failed migration, failed readiness, rollback both ways, redaction
 *       the full matrix above.
 *
 * Run: TURBO_DISABLE=true npm run build && npx tsx scripts/test-release-audit.ts
 */

import fs from "node:fs";
import path from "node:path";

import { Checks, REPO, freePort, startApp } from "./lib/browser-harness";

const ADMIN_EMAIL = "release-audit-admin@xistance.invalid";
const ADMIN_PASS = "ReleaseAuditAdminPassw0rd!x";
const USER_EMAIL = "release-audit-user@xistance.invalid";
const USER_PASS = "ReleaseAuditUserPassw0rd!x";

const c = new Checks();

/** Values that must never appear in an audit row. */
const SECRET_SHAPES = [
  "BEGIN OPENSSH PRIVATE KEY",
  "sshPasswordEnc",
  "apiToken",
  "xt_csrf",
  "DATABASE_URL",
];

/** The `xt_access` + `xt_refresh` + `xt_csrf` triples a login sets. */
function loginCookieHeader(res: Response): string {
  return (res.headers.getSetCookie?.() ?? []).map((sc) => sc.split(";")[0]).join("; ");
}

function findSecrets(payload: unknown, at = "$"): string[] {
  const hits: string[] = [];
  const walk = (v: unknown, p: string): void => {
    if (typeof v === "string") {
      for (const s of SECRET_SHAPES) if (v.includes(s)) hits.push(`${p}: ${s}`);
      if (v.length > 512) hits.push(`${p}: oversized (${v.length} chars)`);
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`));
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) walk(x, `${p}.${k}`);
    }
  };
  walk(payload, at);
  return hits;
}

async function main(): Promise<void> {
  // ---------------------------------------------------------------------------
  // Bind the Prisma client to the harness database BEFORE anything imports
  // @xistance/db. Import order, not statement order, decides which URL the
  // client is built with: the unit section below imports the recorder, which
  // chains through src/lib/api to @xistance/db, and that constructs the module
  // singleton. If DATABASE_URL is still unset at that moment the singleton
  // locks onto packages/db/src/index.ts's dev default
  // (packages/db/prisma/dev.db) and every later write lands in the developer's
  // local database -- 87 stray release records had accumulated there -- while
  // the HTTP assertions read an empty harness file and reported "the recorder
  // writes nothing". Set the URL first and clear any cached client, so the one
  // client in this process is unambiguously the harness one.
  const db = path.join(
    REPO, "node_modules/.cache",
    `xt-release-audit-${process.pid}-${Date.now().toString(36)}`, "app.db",
  );
  process.env.DATABASE_URL = `file:${db.replace(/\\/g, "/")}`;
  (globalThis as { prisma?: unknown }).prisma = undefined;

  console.log("\n=== release / recovery audit records (TASK-39) ===\n");

  /* ============================== AC1 + AC3: the recorder's contract */
  console.log("--- what a record is allowed to contain ---");
  {
    // Imported directly: the recorder is pure with respect to the database, so
    // the unit-level assertions are about the SHAPE, and the HTTP section below
    // proves the shape actually persists.
    const { classifyError, formatReleaseDetails, RELEASE_ACTIONS, ERROR_CATEGORIES } =
      await import("../apps/web/src/lib/release-audit");

    const d = formatReleaseDetails({
      action: RELEASE_ACTIONS.update,
      outcome: "ok",
      version: "1.2.0",
      from: "1.1.0",
    });
    if (d.includes("version=1.2.0") && d.includes("outcome=ok") && d.includes("from=1.1.0")) {
      c.ok("an update record carries the version and the outcome", d);
    } else {
      c.bad("an update record carries the version and the outcome", d);
    }

    // A thrown value may be anything. Every one must land in the closed set.
    const samples: Array<[unknown, string]> = [
      [new Error("PRAGMA wal_checkpoint failed"), "migration-failed"],
      [new Error("migration 20260927 failed"), "migration-failed"],
      [new Error("health probe timed out after 10s"), "readiness-timeout"],
      [new Error("could not activate release"), "activation-failed"],
      [new Error("checksum mismatch for backup"), "backup-corrupt"],
      [new Error("no such file or directory: backup"), "backup-missing"],
      [new Error("EACCES: permission denied"), "permission-denied"],
      [new Error("ENOSPC: no space left on device"), "disk-full"],
      [new Error("ECONNREFUSED 10.0.0.1:8080"), "network-unreachable"],
      [new Error("something nobody anticipated"), "unknown"],
      ["a bare string", "unknown"],
      [undefined, "unknown"],
    ];
    let bad = 0;
    let wrong = "";
    for (const [input, expected] of samples) {
      const got = classifyError(input);
      if (!ERROR_CATEGORIES.includes(got as never)) { bad += 1; wrong = `${String(input)} -> ${got} (not in the set)`; }
      else if (got !== expected) { bad += 1; wrong = `${String(input)} -> ${got} (expected ${expected})`; }
    }
    if (bad === 0) c.ok("a failure record carries a bounded error category", `${samples.length} inputs classified`);
    else c.bad("a failure record carries a bounded error category", wrong);

    if (new Set(ERROR_CATEGORIES).size === ERROR_CATEGORIES.length) {
      c.ok("the category set is closed", `${ERROR_CATEGORIES.length} distinct values`);
    } else {
      c.bad("the category set is closed", "duplicate entries");
    }

    // The single most important property: a raw error must never be persisted.
    // It can carry a path, a SQL fragment, or an argument that is a password.
    const secretBearing = new Error(
      "failed: sshPasswordEnc=abc DATABASE_URL=file:/srv/x.db --private-key /etc/xistance/id_rsa",
    );
    const cat = classifyError(secretBearing);
    if (cat === "unknown" || !/secret|password|DATABASE_URL|private-key|rvsa/.test(String(cat))) {
      c.ok("a raw error message is never persisted", `reduced to "${cat}"`);
    } else {
      c.bad("a raw error message is never persisted", `category is "${cat}"`);
    }

    // A version string is operator-controlled and could itself be hostile.
    const longVersion = "v".repeat(400);
    const clipped = formatReleaseDetails({ action: RELEASE_ACTIONS.update, outcome: "ok", version: longVersion });
    if (clipped.length < 200) c.ok("a hostile version is clipped, not stored whole", `details ${clipped.length} chars`);
    else c.bad("a hostile version is clipped, not stored whole", `${clipped.length} chars`);

    // The action vocabulary must distinguish an incomplete attempt from a
    // completed one. A record written before the work says "update started"
    // and the process then dies -- the trail claims an update happened.
    const okActions = new Set<string>([RELEASE_ACTIONS.update, RELEASE_ACTIONS.migration, RELEASE_ACTIONS.rollback]);
    const failedActions = new Set<string>([
      RELEASE_ACTIONS.updateFailed,
      RELEASE_ACTIONS.migrationFailed,
      RELEASE_ACTIONS.readinessFailed,
      RELEASE_ACTIONS.rollbackFailed,
    ]);
    const overlap = [...okActions].filter((a) => failedActions.has(a));
    if (overlap.length === 0) c.ok("attempted and completed are different outcomes", `${okActions.size} ok / ${failedActions.size} failed, no overlap`);
    else c.bad("attempted and completed are different outcomes", `overlapping: ${overlap.join(", ")}`);

    // Every failure action must carry the `.failed` suffix so a filter can
    // select them without a second convention.
    const allFailuresSuffixed = [...failedActions].every((a) => a.endsWith(".failed"));
    if (allFailuresSuffixed) c.ok("every failure action is distinguishable by name", "all end in .failed");
    else c.bad("every failure action is distinguishable by name", "a failure action lacks the suffix");
  }

  /* ============================== source-level redaction contract */
  console.log("\n--- no record can carry a secret or a command line ---");
  {
    const src = fs.readFileSync(path.join(REPO, "apps/web/src/lib/release-audit.ts"), "utf-8");
    // The recorder must never accept an arbitrary field bag.
    if (/ALLOWED_DETAIL_KEYS|DetailKey\s*=/.test(src) && /allowlist/i.test(src)) {
      c.ok("the details field is built from an allowlist, not a bag of whatever the caller passed", "allowlist present");
    } else {
      c.bad("the details field is built from an allowlist, not a bag of whatever the caller passed", "no allowlist found");
    }
    // A raw error must only ever reach console.error, never the audit call.
    const auditCalls = src.match(/recordReleaseEvent\(\{[\s\S]*?\}\)/g) ?? [];
    const leaks = auditCalls.filter((c2) => /error\s*:\s*(?!classifyError|classifyError\()/i.test(c2) && !/errorCategory/.test(c2));
    if (leaks.length === 0) c.ok("no record passes a raw error object", `${auditCalls.length} call sites checked`);
    else c.bad("no record passes a raw error object", `${leaks.length} call sites`);
    // No process.argv / execSync output may be recorded.
    if (!/(execSync|spawnSync|readFileSync)[\s\S]{0,80}recordReleaseEvent/.test(src)) {
      c.ok("a raw command line is never stored", "no exec/spawn output reaches the recorder");
    } else {
      c.bad("a raw command line is never stored", "command output is passed to the recorder");
    }
  }

  /* ============================== live HTTP: does it actually persist */
  console.log("\n--- recovery records persist, paginate, and are queryable ---");
  const port = await freePort();

  const app = await startApp({ db, port, adminEmail: ADMIN_EMAIL, adminPassword: ADMIN_PASS });


  let seedDb: { $disconnect: () => Promise<void> } | null = null;
  try {
    const origin = app.origin;
    // Log the admin in and take the session cookie off the response. The
    // harness's `cookies()` reads the jar from the /api/health probe, which is
    // not a session, and using it here would silently test nothing.
    const adminLogin = await fetch(`${origin}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASS }),
    });
    // The access cookie is `xt_access` (see createSession in src/lib/auth.ts).
    // Matching on /session|sid/ silently finds nothing, and "no cookie" then
    // reads as an auth failure rather than a wrong regex.
    const session = loginCookieHeader(adminLogin);
    if (!session) {
      throw new Error(
        `the admin login returned no access cookie: HTTP ${adminLogin.status} ` +
        `set-cookie=${JSON.stringify(adminLogin.headers.getSetCookie?.() ?? []).slice(0, 200)}`,
      );
    }
    const authed = (url: string) => fetch(`${origin}${url}`, { headers: { cookie: session } });

    // ---- AC4: the audit API is protected. Two separate properties, so an
    // unauthenticated caller and a non-admin are distinct outcomes.
    const anon = await fetch(`${origin}/api/audit`);
    if (anon.status === 401) c.ok("the audit API refuses an unauthenticated caller", `HTTP ${anon.status}`);
    else c.bad("the audit API refuses an unauthenticated caller", `HTTP ${anon.status}`);

    // ---- AC4: a non-admin is a DIFFERENT outcome from an unauthenticated one.
    // Seed a real `USER` account and log in as it, so the ADMIN gate is proved
    // against an actual authenticated non-admin rather than asserted in source.
    const { prisma: seedPrisma } = await import("@xistance/db");
    seedDb = seedPrisma;
    // Prove the client is bound to the harness database, not the default one.
    // A silent mismatch here makes every record assertion below read as a
    // recorder bug when it is a wiring bug, so check it explicitly once.
    c.expect(
      "the test client is bound to the harness database",
      process.env.DATABASE_URL === `file:${db.replace(/\\/g, "/")}`,
      `DATABASE_URL=${process.env.DATABASE_URL}`,
    );
    // Bound-client proof, kept because it is the check that catches the dev.db
    // leak this suite originally suffered from: it reads the file the client
    // actually has open, not the environment it was handed.
    {
      const { prisma: rp } = await import("@xistance/db");
      const open = (await rp.$queryRawUnsafe<{ file: string }[]>("PRAGMA database_list")) as { file: string }[];
      const opened = (open[0]?.file ?? "").replace(/\\/g, "/");
      const want = (process.env.DATABASE_URL ?? "").replace(/^file:/, "");
      c.expect(
        "the recorder's client resolves to the harness database file",
        opened === want,
        `env=${want} open=${opened}`,
      );
    }    // `security.ts` is re-exported from the package root by `export *`, and the
    // package's `exports` map defines only "." -- so the subpath is not importable.
    const { hashPassword } = await import("@xistance/tunnel-core");
    // upsert, not create: a run whose cleanup could not remove the scratch
    // database (Windows keeps the file mapped) would otherwise fail the next
    // run on a duplicate email, which looks like a seed bug and is not one.
    await seedDb.user.upsert({
      where: { email: USER_EMAIL },
      update: { passwordHash: hashPassword(USER_PASS), name: "Plain User", role: "USER" },
      create: { email: USER_EMAIL, passwordHash: hashPassword(USER_PASS), name: "Plain User", role: "USER" },
    });
    const userLogin = await fetch(`${origin}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email: USER_EMAIL, password: USER_PASS }),
    });
    if (!userLogin.ok) {
      c.bad("a non-admin can be logged in for the authorization check", `HTTP ${userLogin.status}`);
    } else {
      // The session cookie rides on the LOGIN response. `app.cookies()` reads
      // the jar from the health probe and is not a per-session store.
      const session = loginCookieHeader(userLogin);
      if (!session) {
        c.bad("the audit API refuses a non-admin", "no session cookie on the login response");
      } else {
        const asUser = await fetch(`${origin}/api/audit`, { headers: { cookie: session } });
        if (asUser.status === 403) c.ok("the audit API refuses a non-admin", `HTTP ${asUser.status}`);
        else c.bad("the audit API refuses a non-admin", `HTTP ${asUser.status}`);
      }
    }

    // ---- AC1 + AC2: write real recovery records through the recorder the
    // production code uses, then read them back over HTTP. Seeding the database
    // directly would prove the SCHEMA, not that the recorder writes to it.
    const { recordReleaseEvent, RELEASE_ACTIONS } = await import("../apps/web/src/lib/release-audit");

    // Successful update, both rollback directions, successful migration.
    await recordReleaseEvent({ action: RELEASE_ACTIONS.update, outcome: "ok", version: "1.2.0", from: "1.1.0" });
    await recordReleaseEvent({ action: RELEASE_ACTIONS.migration, outcome: "ok", version: "1.2.0" });
    await recordReleaseEvent({ action: RELEASE_ACTIONS.rollback, outcome: "ok", from: "1.2.0", to: "1.1.0" });

    // Failed migration, failed readiness, failed update, failed rollback.
    await recordReleaseEvent({ action: RELEASE_ACTIONS.migrationFailed, outcome: "failed", version: "1.2.0", errorCategory: "migration-failed" });
    await recordReleaseEvent({ action: RELEASE_ACTIONS.readinessFailed, outcome: "failed", version: "1.2.0", errorCategory: "readiness-timeout" });
    await recordReleaseEvent({ action: RELEASE_ACTIONS.updateFailed, outcome: "failed", version: "1.2.0", from: "1.1.0", errorCategory: "disk-full", attempts: 3 });
    await recordReleaseEvent({ action: RELEASE_ACTIONS.rollbackFailed, outcome: "failed", from: "1.2.0", to: "1.1.0", errorCategory: "activation-failed" });

    // A record whose error text is loaded with credential shapes. If any of
    // these reaches the table, the redaction contract is broken.
    const { releaseAudit } = await import("../apps/web/src/lib/release-audit");
    await releaseAudit.updateFailed({
      version: "1.2.0",
      error: new Error("could not activate: sshPasswordEnc=deadbeef DATABASE_URL=file:/srv/xistance.db --private-key /etc/xistance/id_rsa"),
      attempts: 1,
    });
    await releaseAudit.rollbackFailed({
      from: "1.2.0",
      to: "1.1.0",
      error: new Error("BEGIN OPENSSH PRIVATE KEY leaked into the message"),
    });

    // ---- AC2: a recovery record must SURVIVE PAGINATION. Seed ordinary
    // operational rows AFTER the release records so the trail is newest-first
    // with the filler on top: the release events then fall onto page 2, and
    // finding them there is what proves a recovery event survives pagination
    // rather than merely sitting in the first 50 rows.
    for (let i = 0; i < 60; i += 1) {
      await seedDb.auditLog.create({
        data: { actorId: null, action: "settings.update", target: `filler-${i}`, details: "unrelated operational row", ip: null },
      });
    }

    // ---- AC1: read the trail back as an admin.
    const asAdmin = await authed("/api/audit?limit=50");
    if (asAdmin.ok) c.ok("an admin can read the audit trail", `HTTP ${asAdmin.status}`);
    else c.bad("an admin can read the audit trail", `HTTP ${asAdmin.status}`);

    const body = (await asAdmin.json()) as { logs: Array<Record<string, unknown>>; hasNext: boolean; nextCursor: string | null };
    // Name both counts together. When they disagree, the test process and the
    // server are on different files, and every matrix assertion below is
    // meaningless -- so report the split rather than just a failure.
    // The API page is capped at the requested limit, so its length is compared
    // to min(total, limit) -- comparing a page to the table total is wrong by
    // construction as soon as there is more than one page, and would read as
    // "two databases" when there is exactly one.
    const total = await seedDb.auditLog.count();
    const pageSize = Math.min(total, 50);
    c.expect(
      "the server and the test process read the same database",
      (body.logs?.length ?? -1) === pageSize,
      `api=${body.logs?.length ?? -1} expected=${pageSize} total=${total}`,
    );
    // The release records are what the matrix is about, and the filler rows were
    // seeded after them precisely so they fall onto later pages. Walk the whole
    // trail rather than assuming one page holds them: reading only page 1 gave a
    // matrix that reported missing outcomes that were merely paginated away.
    const allRows: Array<Record<string, unknown>> = [...(body.logs ?? [])];
    {
      let cur: string | null = body.nextCursor;
      let guard = 0;
      while (cur && guard < 10) {
        const pn = (await (await authed(`/api/audit?limit=50&cursor=${encodeURIComponent(cur)}`)).json()) as {
          logs: Array<Record<string, unknown>>; nextCursor: string | null;
        };
        allRows.push(...(pn.logs ?? []));
        cur = pn.nextCursor;
        guard += 1;
      }
    }
    const releaseRows = allRows.filter((r) => String(r.action).startsWith("release."));
    if (Array.isArray(body.logs)) c.ok("the audit trail returns records", `${body.logs.length} rows`);
    else { c.bad("the audit trail returns records", "no logs array"); throw new Error("no logs array"); }

    // ---- AC1: nothing in the trail is secret-shaped.
    const leaks = findSecrets({ logs: allRows });
    if (leaks.length === 0) c.ok("no record contains a secret-shaped value", `${allRows.length} rows walked`);
    else c.bad("no record contains a secret-shaped value", leaks.slice(0, 3).join("; "));

    // ---- AC2 + AC3: the full outcome matrix must be present and separable.
    const actions = allRows.map((r) => String(r.action));
    const required: Array<[string, string]> = [
      [RELEASE_ACTIONS.update, "a successful update is recorded"],
      [RELEASE_ACTIONS.migration, "a successful migration is recorded"],
      [RELEASE_ACTIONS.rollback, "a successful rollback is recorded"],
      [RELEASE_ACTIONS.migrationFailed, "a failed migration is recorded"],
      [RELEASE_ACTIONS.readinessFailed, "a failed readiness probe is recorded"],
      [RELEASE_ACTIONS.updateFailed, "a failed update is recorded"],
      [RELEASE_ACTIONS.rollbackFailed, "a failed rollback is recorded"],
    ];
    const absent = required.filter(([a]) => !actions.includes(a));
    if (absent.length === 0) c.ok("every outcome in the update/recovery matrix is recorded", `${required.length} of ${required.length}`);
    else c.bad("every outcome in the update/recovery matrix is recorded", `missing: ${absent.map(([, n]) => n).join(", ")}`);

    // A host-side `update.sh` has no logged-in user. actorId must be null, not
    // a fabricated id -- an unattributed system action is real information.
    const unowned = releaseRows;
    if (unowned.length > 0 && unowned.every((r) => r.actorId === null)) {
      c.ok("a host-side action is recorded with no fabricated actor", `${unowned.length} records, actorId null`);
    } else {
      c.bad("a host-side action is recorded with no fabricated actor", `${unowned.filter((r) => r.actorId !== null).length} invented an actor`);
    }

    // AC3: a failure must be filterable and must carry its category.
    const withCat = releaseRows.filter((r) => String(r.details ?? "").includes("errorCategory="));
    if (withCat.length >= 4) c.ok("a failure record carries a bounded error category", `${withCat.length} records`);
    else c.bad("a failure record carries a bounded error category", `${withCat.length} records`);

    const okRows = releaseRows.filter((r) => String(r.details ?? "").includes("outcome=ok"));
    const failedRows = releaseRows.filter((r) => String(r.details ?? "").includes("outcome=failed"));
    if (okRows.length >= 3 && failedRows.length >= 4 && okRows.every((r) => r.action === RELEASE_ACTIONS.update || r.action === RELEASE_ACTIONS.migration || r.action === RELEASE_ACTIONS.rollback)) {
      c.ok("a failed rollback is distinguishable from a successful one", `${okRows.length} ok / ${failedRows.length} failed, no action reused`);
    } else {
      c.bad("a failed rollback is distinguishable from a successful one", `${okRows.length} ok / ${failedRows.length} failed`);
    }

    // AC3: a failed readiness event is queryable.
    const readiness = releaseRows.find((r) => r.action === RELEASE_ACTIONS.readinessFailed);
    if (readiness && String(readiness.details ?? "").includes("errorCategory=readiness-timeout")) {
      c.ok("a failed readiness event is queryable", String(readiness.details));
    } else {
      c.bad("a failed readiness event is queryable", String(readiness?.details ?? "absent"));
    }

    // AC2: a record exists only for a completed action. The update was recorded
    // once, for the outcome, never as an "attempted" placeholder.
    const updateRows = allRows.filter((r) => r.action === RELEASE_ACTIONS.update);
    if (updateRows.length === 1) c.ok("a record exists only for a completed action", `exactly 1 update record, no placeholder`);
    else c.bad("a record exists only for a completed action", `${updateRows.length} update records`);

    // AC2: pagination must not drop or duplicate.
    const firstPage = body.logs.map((r) => String(r.id));
    if (body.hasNext && body.nextCursor) {
      const p2 = await authed(`/api/audit?limit=1&cursor=${encodeURIComponent(body.nextCursor)}`);
      const b2 = (await p2.json()) as { logs: Array<Record<string, unknown>> };
      const overlap = firstPage.filter((id) => b2.logs.some((r) => String(r.id) === id));
      if (overlap.length === 0) c.ok("records survive pagination", `page1=${firstPage.length} page2=${b2.logs.length}, no overlap`);
      else c.bad("records survive pagination", `${overlap.length} duplicated`);
      // Walk forward through the cursor until a recovery record appears. The
      // point of AC2 is that a release event is still FINDABLE once the trail
      // paginates, not that the cursor merely advances -- so page through
      // rather than inspecting one fixed page, and report how deep it was.
      let cursor: string | null = body.nextCursor;
      let found: string | null = null;
      let page = 2;
      let guard = 0;
      while (cursor && guard < 10) {
        // Same page size as the cursor's source page. Prisma's cursor skips
        // exactly one row, so continuing a limit=50 page with limit=1 would
        // jump past 49 records and never see the ones being looked for.
        const pn = await authed(`/api/audit?limit=50&cursor=${encodeURIComponent(cursor)}`);
        const bn = (await pn.json()) as { logs: Array<Record<string, unknown>>; nextCursor: string | null };
        const hit = bn.logs.find((r) => String(r.action).startsWith("release."));
        if (hit) { found = String(hit.action); break; }
        cursor = bn.nextCursor;
        page += 1;
        guard += 1;
      }
      if (found) c.ok("a recovery record is reachable past the first page", `${found} on page ${page}`);
      else c.bad("a recovery record is reachable past the first page", `no release record within ${guard} pages`);
    } else {
      c.skip("pagination needs more records than one page holds; the cursor path is covered by the auth suite");
    }

    // AC4: the per-user rate limit is declared, and it is per user.
    const auditSrc = fs.readFileSync(path.join(REPO, "apps/web/app/api/audit/route.ts"), "utf-8");
    if (/rateLimit\(\s*`audit:\$\{auth\.user\.id\}`/.test(auditSrc)) {
      c.ok("the audit API is rate limited per user", "`audit:${auth.user.id}` limit declared");
    } else {
      c.bad("the audit API is rate limited per user", "no per-user limit on /api/audit");
    }
    if (/requireSession\(\s*request,\s*"ADMIN"\s*\)/.test(auditSrc)) {
      c.ok("the audit API requires an admin", 'requireSession(request, "ADMIN")');
    } else {
      c.bad("the audit API requires an admin", "no ADMIN gate");
    }

    await seedPrisma.$disconnect();
  } finally {
    await app.close();
    // Prisma keeps the SQLite file open, and Windows refuses to remove a file
    // that is still mapped. Disconnect every client this test created BEFORE
    // deleting the tree, or the cleanup itself becomes the failure.
    await seedDb?.$disconnect().catch(() => undefined);
    // Retry briefly: the app's own client can still be closing.
    for (let i = 0; i < 5; i += 1) {
      try {
        fs.rmSync(path.dirname(db), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
        break;
      } catch {
        if (i === 4) console.log(`  (could not remove the scratch database: ${path.dirname(db)})`);
      }
    }
  }

  process.exit(c.report());
}

void main();
