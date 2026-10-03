/**
 * Focused tests for the zero-build admin creator.
 *
 * The critical property is interoperability: an admin created by
 * `create-admin.mjs` must authenticate against the application's real
 * `verifyPassword` from packages/db/prisma/seed.ts. This test imports that
 * actual function rather than reimplementing it, so a change to the password
 * scheme on either side fails here.
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

interface SqliteStatement {
  all(): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
}
interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}
const { DatabaseSync } = createRequire(__filename)("node:sqlite") as {
  DatabaseSync: new (path: string) => SqliteDatabase;
};

const repoRoot = path.resolve(__dirname, "..");
const applier = path.join(repoRoot, "scripts", "apply-migrations.mjs");
const creator = path.join(repoRoot, "scripts", "create-admin.mjs");
const migrations = path.join(repoRoot, "packages", "db", "prisma", "migrations");

const workRoot = mkdtempSync(path.join(os.tmpdir(), "xistance-admin-"));

function run(script: string, args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failure.status ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

async function main(): Promise<void> {
  const database = path.join(workRoot, "app.db");
  const adminEmail = "admin@xistance.local";
  const adminPassword = "Sup3rSecret!pw";

  try {
    const migrated = run(applier, ["--database", `file:${database}`, "--migrations", migrations]);
    assert.equal(migrated.status, 0, `migrations must apply: ${migrated.stderr}`);

    // ---------------------------------------------------------------------
    // The admin is created and is a SUPER_ADMIN.
    // ---------------------------------------------------------------------
    const created = run(creator, [
      "--database", `file:${database}`,
      "--email", adminEmail,
      "--password", adminPassword,
    ]);
    assert.equal(created.status, 0, `admin creation must succeed: ${created.stderr}`);

    const db = new DatabaseSync(database);
    let row: { email: string; passwordHash: string; role: string; active: number };
    try {
      row = db
        .prepare('SELECT "email","passwordHash","role","active" FROM "User" WHERE "email" = ?')
        .get(adminEmail) as typeof row;
    } finally {
      db.close();
    }
    assert.equal(row.email, adminEmail, "the admin row must exist");
    assert.equal(row.role, "SUPER_ADMIN", "the first account must be a SUPER_ADMIN");

    // ---------------------------------------------------------------------
    // Interoperability with the application's real password verification.
    //
    // seed.ts runs its own top-level seeding on import, so the default
    // database must point at a migrated, seeded database or the import throws
    // P2021 before verifyPassword is ever reached. The default file is used
    // and created if missing; the test database itself is separate.
    // ---------------------------------------------------------------------
    const seedDb = process.env.XT_SEED_TEST_DB ?? path.join(repoRoot, ".data", "app.db");
    if (!existsSync(seedDb)) {
      mkdirSync(path.dirname(seedDb), { recursive: true });
      const prepared = run(applier, [
        "--database", `file:${seedDb}`,
        "--migrations", migrations,
      ]);
      assert.equal(prepared.status, 0, `the seed database must migrate: ${prepared.stderr}`);
    }
    process.env.DATABASE_URL = `file:${seedDb}`;
    const seed = await import("../packages/db/prisma/seed.ts");
    assert.equal(
      seed.verifyPassword(adminPassword, row.passwordHash),
      true,
      "the created admin must authenticate against the real verifyPassword",
    );
    assert.equal(
      seed.verifyPassword("not-the-password", row.passwordHash),
      false,
      "a wrong password must not authenticate",
    );
    assert.equal(
      seed.hashPassword(adminPassword).startsWith("scrypt:16384:8:1:"),
      true,
      "the stored scheme must remain the one seed.ts produces",
    );

    // ---------------------------------------------------------------------
    // Re-running never overwrites an existing account or its password.
    // ---------------------------------------------------------------------
    const before = row.passwordHash;
    const again = run(creator, [
      "--database", `file:${database}`,
      "--email", adminEmail,
      "--password", "a-different-password",
    ]);
    assert.equal(again.status, 0, "re-running must succeed");
    assert.match(again.stdout, /already exists/, "re-running must report the existing account");

    const dbAfter = new DatabaseSync(database);
    let after: { passwordHash: string; count: number };
    try {
      after = dbAfter
        .prepare('SELECT "passwordHash", (SELECT count(*) FROM "User") AS count FROM "User" WHERE "email" = ?')
        .get(adminEmail) as typeof after;
    } finally {
      dbAfter.close();
    }
    assert.equal(after.passwordHash, before, "an existing admin password must not be reset");
    assert.equal(Number(after.count), 1, "re-running must not create a duplicate account");

    // ---------------------------------------------------------------------
    // A missing or invalid password is refused rather than creating an
    // account nobody can log into.
    // ---------------------------------------------------------------------
    const noPassword = run(creator, ["--database", `file:${database}`, "--email", "other@xistance.local"]);
    assert.notEqual(noPassword.status, 0, "a missing password must exit non-zero");
    assert.match(noPassword.stderr, /password is required/, "must explain the missing password");

    const badEmail = run(creator, [
      "--database", `file:${database}`,
      "--email", "not-an-email",
      "--password", adminPassword,
    ]);
    assert.notEqual(badEmail.status, 0, "an invalid email must exit non-zero");

    // ---------------------------------------------------------------------
    // Two admins get distinct salts, so identical passwords do not produce
    // identical hashes.
    // ---------------------------------------------------------------------
    const second = run(creator, [
      "--database", `file:${database}`,
      "--email", "second@xistance.local",
      "--password", adminPassword,
    ]);
    assert.equal(second.status, 0, `a second admin must be creatable: ${second.stderr}`);
    const dbTwo = new DatabaseSync(database);
    let hashes: string[];
    try {
      hashes = dbTwo
        .prepare('SELECT "passwordHash" FROM "User" ORDER BY "email"')
        .all()
        .map((r) => String((r as { passwordHash: string }).passwordHash));
    } finally {
      dbTwo.close();
    }
    assert.equal(hashes.length, 2, "both admins must exist");
    assert.notEqual(hashes[0], hashes[1], "identical passwords must still hash differently (unique salt)");

    // ---------------------------------------------------------------------
    // --reset-password is the explicit recovery path for a lost admin
    // password. Without it, install idempotency left an admin who could no
    // longer sign in with no way back short of hand-editing the database.
    // ---------------------------------------------------------------------
    const resetPassword = "Rec0very!pass";
    const reset = run(creator, [
      "--database", `file:${database}`,
      "--email", adminEmail,
      "--password", resetPassword,
      "--reset-password",
    ]);
    assert.equal(reset.status, 0, `--reset-password must succeed: ${reset.stderr}`);
    assert.match(reset.stdout, /reset password/, "--reset-password must report the rewrite");

    const dbReset = new DatabaseSync(database);
    let afterReset: { passwordHash: string; count: number };
    try {
      afterReset = dbReset
        .prepare('SELECT "passwordHash", (SELECT count(*) FROM "User") AS count FROM "User" WHERE "email" = ?')
        .get(adminEmail) as typeof afterReset;
    } finally {
      dbReset.close();
    }
    assert.notEqual(
      afterReset.passwordHash,
      before,
      "--reset-password must actually change the stored hash",
    );
    assert.equal(
      Number(afterReset.count),
      2,
      "--reset-password must not create a second row for the same admin",
    );
    assert.equal(
      seed.verifyPassword(resetPassword, afterReset.passwordHash),
      true,
      "the new password must authenticate against the real verifyPassword",
    );
    assert.equal(
      seed.verifyPassword(adminPassword, afterReset.passwordHash),
      false,
      "the old password must stop working after a reset",
    );

    // The reset must not become a default: a plain re-run afterwards is
    // idempotent again and must not rewrite the freshly set password.
    const postReset = run(creator, [
      "--database", `file:${database}`,
      "--email", adminEmail,
      "--password", "yet-another-password",
    ]);
    assert.match(postReset.stdout, /not modified/, "a re-run after a reset must be idempotent again");
    const dbFinal = new DatabaseSync(database);
    let finalRow: { passwordHash: string };
    try {
      finalRow = dbFinal
        .prepare('SELECT "passwordHash" FROM "User" WHERE "email" = ?')
        .get(adminEmail) as typeof finalRow;
    } finally {
      dbFinal.close();
    }
    assert.equal(
      finalRow.passwordHash,
      afterReset.passwordHash,
      "a re-run after a reset must leave the reset password in place",
    );

    console.log("✅ Admin creator: seeding, real verifyPassword interop, idempotency, and reset recovery all hold");
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
}

void main();
