/**
 * Apply pending Prisma migrations with the generated client only.
 *
 * The release artifact ships the Prisma *client* but deliberately does not ship
 * the Prisma CLI, the query engine binaries used by `prisma migrate`, or
 * ts-node. A zero-build install therefore cannot run `prisma db push` or
 * `prisma migrate deploy`; it can, however, open the SQLite database directly
 * with `node:sqlite` (available since Node 22) and execute the same SQL files
 * that the migrations directory already contains.
 *
 * Safety properties:
 *   - the same migration is never applied twice;
 *   - each statement runs in a transaction, so a failure leaves no half-applied
 *     schema;
 *   - an existing database is migrated in place and never dropped;
 *   - a database created by this tool records its migrations in the same
 *     `_prisma_migrations` table the Prisma CLI uses, so a later `prisma`
 *     invocation agrees about what has been applied.
 *
 * Usage:
 *   node apply-migrations.mjs [--database <file>] [--migrations <dir>]
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function parseArgs(argv) {
  const options = { database: process.env.DATABASE_URL ?? "", migrations: "" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--database") options.database = argv[i + 1] ?? "";
    else if (argv[i] === "--migrations") options.migrations = argv[i + 1] ?? "";
  }
  return options;
}

/**
 * Turn a `file:` URL or a plain path into an absolute filesystem path.
 * Only SQLite file URLs are supported, which is the documented default.
 */
function resolveDatabasePath(raw) {
  if (!raw) throw new Error("no database path was provided");
  let value = raw.trim();
  if (value.startsWith("file:")) {
    // Drop the scheme. `file:./x.db`, `file:/x.db` and `file:///x.db` are all
    // accepted; only the path portion is meaningful.
    value = value.slice("file:".length).replace(/^\/\/(\/)?/, "/");
  }
  if (!value) throw new Error(`could not read a filesystem path from DATABASE_URL: ${raw}`);
  return path.resolve(value);
}

/**
 * Split a migration file into individual statements.
 *
 * Deliberately simple and conservative: statements are separated on a semicolon
 * that ends a line, which is how Prisma emits migrations. Comment-only lines are
 * dropped. A semicolon inside a string literal would need a real SQL parser;
 * the shipped migrations contain none, and `assertNoAmbiguousSplit` documents
 * that assumption rather than hiding it.
 */
function splitStatements(sql) {
  const statements = [];
  let current = "";
  for (const line of sql.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("--") || trimmed === "") {
      // A comment may follow a statement terminator; otherwise skip it.
      if (current.trim() !== "") current += "\n";
      continue;
    }
    current += `${line}\n`;
    if (trimmed.endsWith(";")) {
      const statement = current.trim().replace(/;$/, "").trim();
      if (statement !== "") statements.push(statement);
      current = "";
    }
  }
  const tail = current.trim();
  if (tail !== "") statements.push(tail);
  return statements;
}

function checksumOf(sql) {
  return createHash("sha256").update(sql).digest("hex");
}

function readMigrations(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(directory, entry.name))
    .filter((dir) => existsSync(path.join(dir, "migration.sql")))
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b)))
    .map((dir) => ({
      name: path.basename(dir),
      sql: readFileSync(path.join(dir, "migration.sql"), "utf8"),
    }));
}

function ensureMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
      "id" TEXT PRIMARY KEY NOT NULL,
      "checksum" TEXT NOT NULL,
      "finished_at" DATETIME,
      "migration_name" TEXT NOT NULL,
      "logs" TEXT,
      "rolled_back_at" DATETIME,
      "started_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function appliedMigrations(db) {
  const rows = db.prepare('SELECT "migration_name", "checksum" FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL').all();
  return new Map(rows.map((row) => [String(row.migration_name), String(row.checksum)]));
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  // Default to the migrations directory NEXT TO THIS SCRIPT, not to the
  // process's working directory. The release layout puts this script at the
  // release root, so that is the only location that is correct regardless of
  // where the caller happens to be. A cwd-relative default only works when the
  // caller has already cd'd to the release root -- and when it has not, this
  // function found zero migrations, printed "nothing to apply", and exited 0.
  // A silent success on a release whose schema was never created is far worse
  // than a failure: the next symptom is "no such table: User" from a live
  // server, with the installer long gone.
  //
  // An explicit --migrations still wins, and is what release-install.sh passes.
  //
  // Derive the script's own directory from the URL, NOT from `.pathname`. On
  // Windows a `file://` URL's pathname is `/E:/code/...`, so `path.dirname` on it
  // yields `/E:` and `path.join` with an absolute second argument DISCARDS the
  // first -- producing `E:\E:\code\...\scripts\packages\db\prisma\migrations`.
  // That directory does not exist, so `readMigrations` found nothing, the script
  // printed "nothing to apply" and exited 0, and the caller carried on with a
  // database that had never been created. The silent-success failure mode this
  // function exists to prevent, reached by a different route.
  //
  // `fileURLToPath` handles the platform correctly; it is not optional here.
  const migrationsDir = path.resolve(
    options.migrations ||
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "packages/db/prisma/migrations"),
  );
  const databasePath = resolveDatabasePath(options.database);
  const migrations = readMigrations(migrationsDir);

  if (migrations.length === 0) {
    // Do not report success. A caller that supplied --migrations has told us
    // where they are, so an empty directory there is an error worth stopping
    // for; a bare invocation is a first run on a tree with nothing to apply.
    if (options.migrations) {
      process.stderr.write(
        `no migrations found in ${migrationsDir}, which was passed explicitly. ` +
          `Refusing to report success: the release's schema would be missing.\n`,
      );
      return 1;
    }
    process.stdout.write(`no migrations found in ${migrationsDir}; nothing to apply\n`);
    return 0;
  }

  // A first install has no data directory yet, so the database's parent has to
  // exist before SQLite will create the file.
  mkdirSync(path.dirname(databasePath), { recursive: true });

  const db = new DatabaseSync(databasePath);
  try {
    ensureMigrationsTable(db);
    const already = appliedMigrations(db);

    let appliedCount = 0;
    for (const migration of migrations) {
      const checksum = checksumOf(migration.sql);
      const previous = already.get(migration.name);
      if (previous !== undefined) {
        if (previous !== checksum) {
          process.stderr.write(
            `migration ${migration.name} was already applied with a different checksum; ` +
              "refusing to continue because the database and the artifact disagree\n",
          );
          return 1;
        }
        continue;
      }

      const statements = splitStatements(migration.sql);
      db.exec("BEGIN");
      try {
        for (const statement of statements) {
          db.exec(statement);
        }
        // `exec` cannot bind parameters, so the bookkeeping row is written with
        // a prepared statement. The id is a synthetic unique value; Prisma only
        // uses it as a primary key.
        db.prepare(
          `INSERT INTO "_prisma_migrations" ("id","checksum","finished_at","migration_name","started_at") ` +
            `VALUES (?, ?, CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP)`,
        ).run(`${migration.name}-${checksum.slice(0, 16)}`, checksum, migration.name);
      } catch (error) {
        db.exec("ROLLBACK");
        process.stderr.write(
          `migration ${migration.name} failed and was rolled back: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        return 1;
      }
      // The INSERT above is part of the open transaction; commit it.
      db.exec("COMMIT");
      appliedCount += 1;
      process.stdout.write(`applied ${migration.name}\n`);
    }

    process.stdout.write(
      `migrations up to date (${appliedCount} applied, ${migrations.length} total)\n`,
    );
    return 0;
  } finally {
    db.close();
  }
}

try {
  process.exit(main());
} catch (error) {
  process.stderr.write(`migration failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
