/**
 * Focused tests for the zero-build migration applier.
 *
 * The release artifact ships the Prisma client but not the Prisma CLI, so
 * `prisma migrate deploy` is unavailable on the target host. This applier uses
 * `node:sqlite` (Node 22+) to apply the same SQL the migrations directory
 * contains. These tests run it as a real child process against real databases.
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

// `node:sqlite` ships with Node 22+ but its types are not present in this
// repository's TypeScript version. It is loaded through createRequire with an
// explicit local shape, so the tests typecheck and still exercise the real
// module at runtime.
interface SqliteStatement {
  all(): unknown[];
  get(): unknown;
  run(...params: unknown[]): unknown;
}
interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}
interface SqliteModule {
  DatabaseSync: new (path: string) => SqliteDatabase;
}
const { DatabaseSync } = createRequire(__filename)("node:sqlite") as SqliteModule;

const repoRoot = path.resolve(__dirname, "..");
const script = path.join(repoRoot, "scripts", "apply-migrations.mjs");
const realMigrations = path.join(repoRoot, "packages", "db", "prisma", "migrations");

const workRoot = mkdtempSync(path.join(os.tmpdir(), "xistance-migrate-"));

function run(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? -1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

function tableNames(databasePath: string): string[] {
  const db = new DatabaseSync(databasePath);
  try {
    return db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((row) => String((row as { name: string }).name));
  } finally {
    db.close();
  }
}

function copyMigrations(name: string): string {
  const target = path.join(workRoot, name);
  mkdirSync(target, { recursive: true });
  for (const entry of ["migration_lock.toml", "20260823214332_init"]) {
    const from = path.join(realMigrations, entry);
    if (!existsSync(from)) continue;
    if (statSync(from).isDirectory()) {
      mkdirSync(path.join(target, entry), { recursive: true });
      writeFileSync(
        path.join(target, entry, "migration.sql"),
        readFileSync(path.join(from, "migration.sql"), "utf8"),
        "utf8",
      );
    } else {
      writeFileSync(path.join(target, entry), readFileSync(from, "utf8"), "utf8");
    }
  }
  return target;
}

try {
  // -------------------------------------------------------------------------
  // The real migration creates every table the app queries, including Tunnel —
  // the table whose absence made the VPS health check report the database as
  // unreachable.
  // -------------------------------------------------------------------------
  const database = path.join(workRoot, "app.db");
  const first = run(["--database", `file:${database}`, "--migrations", realMigrations]);
  assert.equal(first.status, 0, `migration must apply: ${first.stderr}`);

  const names = tableNames(database);
  for (const table of ["User", "Session", "Node", "Tunnel", "PortForward", "Setting", "_prisma_migrations"]) {
    assert.ok(names.includes(table), `expected table ${table}; got ${names.join(", ")}`);
  }

  const db = new DatabaseSync(database);
  try {
    // The exact query that failed on the VPS with P2021.
    const tunnelCount = db.prepare('SELECT count(*) AS c FROM "Tunnel"').get() as { c: number };
    assert.equal(Number(tunnelCount.c), 0, "Tunnel must be queryable");
    const userCount = db.prepare('SELECT count(*) AS c FROM "User"').get() as { c: number };
    assert.equal(Number(userCount.c), 0, "User must be queryable");
  } finally {
    db.close();
  }

  // -------------------------------------------------------------------------
  // Re-running is a no-op, not a second application.
  // -------------------------------------------------------------------------
  const second = run(["--database", `file:${database}`, "--migrations", realMigrations]);
  assert.equal(second.status, 0, `re-run must succeed: ${second.stderr}`);
  assert.match(second.stdout, /0 applied/, `re-run must apply nothing; got: ${second.stdout}`);

  // -------------------------------------------------------------------------
  // A database whose recorded migration no longer matches the artifact is
  // refused rather than silently diverging.
  // -------------------------------------------------------------------------
  const drifted = copyMigrations("drifted");
  const initPath = path.join(drifted, "20260823214332_init", "migration.sql");
  writeFileSync(initPath, `${readFileSync(initPath, "utf8")}\nCREATE TABLE Drift (id TEXT);\n`, "utf8");
  const driftRun = run(["--database", `file:${database}`, "--migrations", drifted]);
  assert.equal(driftRun.status, 1, "a checksum mismatch must exit non-zero");
  assert.match(driftRun.stderr, /different checksum/, `must explain the drift; got: ${driftRun.stderr}`);
  assert.ok(
    !tableNames(database).includes("Drift"),
    "a refused migration must not have applied anything",
  );

  // -------------------------------------------------------------------------
  // A failing migration leaves no half-applied schema.
  // -------------------------------------------------------------------------
  const broken = copyMigrations("broken");
  const brokenInit = path.join(broken, "20260823214332_init", "migration.sql");
  writeFileSync(
    brokenInit,
    `${readFileSync(brokenInit, "utf8")}\nCREATE TABLE Half (id TEXT);\nCREATE TABLE Half (id TEXT);\n`,
    "utf8",
  );
  const freshDatabase = path.join(workRoot, "fresh.db");
  const brokenRun = run(["--database", `file:${freshDatabase}`, "--migrations", broken]);
  assert.equal(brokenRun.status, 1, "a failing migration must exit non-zero");
  assert.match(brokenRun.stderr, /rolled back/, `must report the rollback; got: ${brokenRun.stderr}`);
  assert.ok(
    !tableNames(freshDatabase).includes("Half"),
    "a rolled-back migration must not leave its tables behind",
  );

  // -------------------------------------------------------------------------
  // The parent directory is created for a first install, where the data dir
  // does not exist yet.
  // -------------------------------------------------------------------------
  const nested = path.join(workRoot, "not", "yet", "created", "app.db");
  const nestedRun = run(["--database", `file:${nested}`, "--migrations", realMigrations]);
  assert.equal(nestedRun.status, 0, `a missing parent directory must be created: ${nestedRun.stderr}`);

  // -------------------------------------------------------------------------
  // A missing migrations directory is reported, and it is a FAILURE when the
  // caller named it.
  //
  // This previously asserted exit 0. That encoded the real defect TASK-85 found:
  // the applier printed "no migrations found" and exited 0, so an installer
  // checking only the exit status concluded the schema was current when nothing
  // had been applied. The first symptom arrived much later, from a live server,
  // as "no such table: User" with the installer long gone.
  //
  // The distinction the applier now draws: a BARE invocation on a tree with
  // nothing to apply is a legitimate no-op, but an invocation that explicitly
  // named a directory and found nothing there is an error -- the caller has
  // stated where the migrations are and the answer was "not here".
  // -------------------------------------------------------------------------
  const emptyRun = run(["--database", `file:${nested}`, "--migrations", path.join(workRoot, "nope")]);
  assert.equal(emptyRun.status, 1, "an explicitly named but absent migrations directory must fail");
  assert.match(
    `${emptyRun.stdout}${emptyRun.stderr}`,
    /no migrations found.*passed explicitly/s,
    "the failure must say the directory was named explicitly, not merely that it was empty",
  );

  // The bare invocation must FIND the repository's own migrations.
  //
  // This assertion previously required `no migrations found` from a bare run --
  // which passed only because the default path was broken in TWO ways at once:
  // `new URL(import.meta.url).pathname` produced `/E:/...` on Windows, which
  // `path.dirname` reduced to `/E:`, and `path.join` then DISCARDED the first
  // argument because the second was absolute, yielding
  // `...\scripts\packages\db\prisma\migrations`. No such directory, zero
  // migrations, "nothing to apply", exit 0.
  //
  // So the test pinned the defect. A bare run now resolves
  // `<repo>/packages/db/prisma/migrations` and APPLIES them; asserting otherwise
  // would keep the silent-success failure this script exists to prevent -- the
  // server would come up against a database that was never created.
  const bareRun = run(["--database", `file:${nested}`]);
  assert.equal(
    bareRun.status,
    0,
    `a bare invocation must succeed and apply the repo migrations; got: ${bareRun.stderr || bareRun.stdout}`,
  );
  assert.match(
    bareRun.stdout,
    /applied \d|migrations up to date/,
    `a bare invocation must APPLY the repository migrations, not report none found: ${bareRun.stdout.trim()}`,
  );
  assert.doesNotMatch(
    bareRun.stdout,
    /no migrations found/,
    "a bare invocation found none, so the default path is wrong again",
  );

  // And the schema it created must actually be there -- the real proof that the
  // default resolves, rather than a string match on a message.
  {
    const probe = run(["--database", `file:${nested}`]);
    assert.equal(probe.status, 0);
    const db = new DatabaseSync(nested);
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((r) => r.name);
    db.close();
    assert.ok(
      tables.includes("User") && tables.includes("_prisma_migrations"),
      `the bare run must create the schema; tables present: ${tables.join(", ")}`,
    );
  }

  // -------------------------------------------------------------------------
  // The applier is usable without the Prisma CLI: nothing here shells out to
  // npx, prisma, or a build step. Comments are stripped first, because the file
  // *documents* that it does none of these and that prose must not read as a
  // violation.
  const raw = readFileSync(script, "utf8");
  // Strip both `#` and block comments, because the file's header documents in a
  // /** */ block exactly which Prisma commands it avoids, and that prose must
  // not be read as an invocation.
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/#.*$/, ""))
    .join("\n");
  for (const forbidden of ["prisma db push", "prisma migrate", "npx ", "next build"]) {
    assert.ok(!code.includes(forbidden), `applier must not invoke: ${forbidden}`);
  }
  assert.ok(raw.includes("node:sqlite"), "applier must use node:sqlite");

  console.log("✅ Migration applier: schema creation, idempotency, drift refusal, and rollback all hold");
} finally {
  rmSync(workRoot, { recursive: true, force: true });
}
