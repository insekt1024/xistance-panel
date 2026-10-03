/**
 * Create the initial super-admin for a zero-build install.
 *
 * `seed.ts` is TypeScript and imports the Prisma client, so it cannot run from
 * the release artifact. This does the one thing a fresh install actually needs
 * — an account to log in with — using `node:sqlite` and the identical
 * scrypt scheme that `verifyPassword` in seed.ts expects:
 *
 *   scrypt:16384:8:1:<salt base64>:<hash base64>
 *
 * Using the same scheme matters: an admin created here must authenticate
 * against the application's existing password verification, not a new format.
 *
 * Usage:
 *   node create-admin.mjs --database <file> --email <email> --password <pw>
 *
 * Re-running is safe: an existing account is never overwritten.
 */
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function parseArgs(argv) {
  const options = {
    database: process.env.DATABASE_URL ?? "",
    email: process.env.XT_ADMIN_EMAIL ?? "admin@xistance.local",
    password: process.env.XT_ADMIN_PASSWORD ?? "",
    resetPassword: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--database") options.database = argv[i + 1] ?? "";
    else if (argv[i] === "--email") options.email = argv[i + 1] ?? "";
    else if (argv[i] === "--password") options.password = argv[i + 1] ?? "";
    else if (argv[i] === "--reset-password") options.resetPassword = true;
  }
  return options;
}

function resolveDatabasePath(raw) {
  if (!raw) throw new Error("no database path was provided");
  let value = raw.trim();
  if (value.startsWith("file:")) {
    value = value.slice("file:".length).replace(/^\/\/(\/)?/, "/");
  }
  if (!value) throw new Error(`could not read a filesystem path from DATABASE_URL: ${raw}`);
  return path.resolve(value);
}

/**
 * Hash a password exactly as packages/db/prisma/seed.ts does.
 * The parameters are part of the stored format and must not drift.
 */
export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt:16384:8:1:${salt.toString("base64")}:${hash.toString("base64")}`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.password) {
    process.stderr.write("an admin password is required (--password or XT_ADMIN_PASSWORD)\n");
    return 2;
  }
  if (!options.email || !options.email.includes("@")) {
    process.stderr.write(`invalid admin email: ${options.email}\n`);
    return 2;
  }

  const databasePath = resolveDatabasePath(options.database);
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  try {
    const existing = db
      .prepare("SELECT id FROM \"User\" WHERE \"email\" = ?")
      .get(options.email);
    if (existing) {
      // Install must stay idempotent: a re-run never rewrites a password that
      // may already be in use. --reset-password is the explicit, separate
      // escape hatch for the real case this hides -- an admin who has lost
      // the password and cannot sign in to change it.
      if (!options.resetPassword) {
        process.stdout.write(`admin ${options.email} already exists; not modified\n`);
        return 0;
      }
      const now = new Date().toISOString();
      db.prepare("UPDATE \"User\" SET \"passwordHash\" = ?, \"updatedAt\" = ? WHERE id = ?")
        .run(hashPassword(options.password), now, existing.id);
      process.stdout.write(`reset password for ${options.email}\n`);
      return 0;
    }

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO "User" ("id","email","name","passwordHash","role","quota","locale","active","createdAt","updatedAt") ` +
        `VALUES (?, ?, ?, ?, 'SUPER_ADMIN', 5, 'en', 1, ?, ?)`,
    ).run(
      // Must be a UUID. `User.id` is `@default(uuid())`, and Prisma validates
      // the format on every query that reads the row: a 32-char hex id made
      // every user query fail with P2023 "Conversion failed: input contains
      // invalid characters", which surfaced as the app's generic error
      // boundary on every page that touches users. Login still worked -- it
      // reads with raw SQL -- which is exactly why it survived to release.
      randomUUID(),
      options.email,
      "Super Admin",
      hashPassword(options.password),
      now,
      now,
    );

    process.stdout.write(`created super admin: ${options.email}\n`);
    return 0;
  } finally {
    db.close();
  }
}

try {
  process.exit(main());
} catch (error) {
  process.stderr.write(`admin creation failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
