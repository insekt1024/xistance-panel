import { cp, copyFile, mkdir, mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  inspectReleaseArtifact,
  isForeignNativeBinary,
  PRISMA_LINUX_ENGINES,
  RELEASE_LAYOUT,
  type ReleaseArchitecture,
} from "./inspect-release-artifact.ts";
import { rewriteBuildMachinePaths } from "./rewrite-build-paths.ts";
import { stageReleaseAssets } from "./stage-release-assets.ts";

export interface StageReleaseArtifactOptions {
  repoRoot?: string;
  destination: string;
  architecture?: ReleaseArchitecture;
  prismaClientSource?: string;
  /**
   * Standalone tree to stage from. Defaults to the in-repo Next output, which is
   * only correct when the build ran on the same architecture as the artifact.
   * A release built on another host (or another architecture) must point this
   * at that build's standalone tree, or the artifact silently inherits engines
   * and traced native modules from the wrong architecture.
   */
  standaloneRoot?: string;
}

const DEFAULT_PRISMA_CLIENT_SOURCE = "packages/db/generated/client";
const DEFAULT_PRISMA_SCHEMA_SOURCE = "packages/db/prisma/schema.prisma";
const DEFAULT_PRISMA_MIGRATIONS_SOURCE = "packages/db/prisma/migrations";
const DEFAULT_MIGRATION_APPLIER_SOURCE = "scripts/apply-migrations.mjs";
const DEFAULT_ADMIN_CREATOR_SOURCE = "scripts/create-admin.mjs";

/**
 * Files that make the generated Prisma client runnable on the target host.
 * Next standalone tracing copies none of these, so they are staged explicitly.
 * `required` files must exist; the rest are copied when present.
 */
const PRISMA_CLIENT_REQUIRED_FILES = ["index.js", "default.js", "package.json"] as const;

/**
 * Everything else in the generated client is copied as-is, except engines for
 * foreign platforms. The client requires its sibling `runtime/` tree, so a
 * hand-listed file set is not sufficient.
 */
const PRISMA_CLIENT_SKIP_PATTERN =
  /(^|[\\/])\.bin([\\/]|$)|\.tsbuildinfo$|~$|\.node\.tmp\d+$|\.node\.tmp/i;

const SECRET_FILE_PATTERN = /(?:^|\/)(?:\.env(?:\..*)?|id_rsa(?:\..*)?|credentials(?:\..*)?|[^/]+\.(?:pem|key|p12|pfx))$/i;
const DATABASE_FILE_PATTERN = /\.(?:db|sqlite|sqlite3)(?:-(?:journal|wal|shm))?$/i;
const LOG_FILE_PATTERN = /\.log$/i;

function normalizedRelative(standaloneRoot: string, filePath: string): string {
  return path.relative(standaloneRoot, filePath).split(path.sep).join("/");
}

function standaloneRelative(relativePath: string): string {
  return relativePath;
}

function shouldCopy(standaloneRoot: string, filePath: string): boolean {
  const relativePath = normalizedRelative(standaloneRoot, filePath);
  if (!relativePath || relativePath === ".") return true;
  const lower = relativePath.toLowerCase();
  const segments = lower.split("/");

  if (segments.includes(".git")) return false;
  if (lower.startsWith("apps/web/.next/cache/")) return false;
  if (lower.startsWith("node_modules/.cache/") || lower.startsWith("node_modules/.bin/")) return false;
  if (lower === "tunnels/tunnels" || lower.startsWith("tunnels/tunnels/")) return false;
  if (lower.startsWith("tunnels/") && segments.includes("logs")) return false;
  if (lower.endsWith("/.env") || lower.startsWith(".env") || SECRET_FILE_PATTERN.test(lower)) return false;
  if (DATABASE_FILE_PATTERN.test(lower) || LOG_FILE_PATTERN.test(lower)) return false;
  if (lower.endsWith(".tsbuildinfo") || lower === "agents.md" || lower.endsWith("/agents.md")) return false;
  if (lower.endsWith("next.config.ts") || lower.endsWith("eslint.config.mjs") || lower.endsWith("postcss.config.mjs")) return false;
  // A native binary built for another OS is unusable on the target and means the
  // build ran on the wrong platform. Staging on Windows leaked
  // @img/sharp-win32-x64 (a 442KB PE) into the amd64 payload. Prune it here so
  // the artifact is clean, and let inspection catch anything that slips past.
  if (isForeignNativeBinary(relativePath)) return false;
  return true;
}

async function requireFile(filePath: string, label: string): Promise<void> {
  let details;
  try {
    details = await stat(filePath);
  } catch {
    throw new Error(`Release staging input is missing: ${label} (${filePath}).`);
  }
  if (!details.isFile()) throw new Error(`Release staging input is not a file: ${label} (${filePath}).`);
}

async function requireDirectory(directory: string, label: string): Promise<void> {
  let details;
  try {
    details = await stat(directory);
  } catch {
    throw new Error(`Release staging input is missing: ${label} (${directory}).`);
  }
  if (!details.isDirectory()) throw new Error(`Release staging input is not a directory: ${label} (${directory}).`);
}

async function copyRequiredFile(source: string, destination: string, label: string): Promise<void> {
  await requireFile(source, label);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

interface StagePrismaClientOptions {
  sourceRoot: string;
  destinationRoot: string;
  architecture?: ReleaseArchitecture;
}

/**
 * Stages a runnable Prisma client: the JavaScript entry points plus exactly one
 * native query engine for the target architecture. Engines for other platforms
 * are never copied, so a Windows engine can no longer leak into a Linux release.
 */
async function stagePrismaClient(options: StagePrismaClientOptions): Promise<void> {
  const { sourceRoot, destinationRoot, architecture } = options;
  const exists = await stat(sourceRoot).then((details) => details.isDirectory()).catch(() => false);
  // Absence is reported by inspection, which is the release gate. Throwing here
  // would make an unbootable artifact a staging crash instead of a clear failure.
  if (!exists) return;

  for (const file of PRISMA_CLIENT_REQUIRED_FILES) {
    await requireFile(path.join(sourceRoot, file), `Prisma client ${file}`);
  }

  // The generated client needs its sibling runtime/ tree, so copy the whole
  // directory rather than a hand-listed file set, then fix up the engines.
  await cp(sourceRoot, destinationRoot, {
    recursive: true,
    force: true,
    errorOnExist: false,
    filter: (candidate) => !PRISMA_CLIENT_SKIP_PATTERN.test(path.basename(candidate)),
  });

  const entries = await readdir(sourceRoot);
  const engineSuffixes = architecture ? PRISMA_LINUX_ENGINES[architecture] : [];
  // With an explicit architecture only that architecture's engines are kept.
  // Without one (a local `native` staging) the build host's own engine is kept —
  // including the Windows .dll.node and the macOS .dylib.node, which a
  // Linux-only filter would silently drop and leave with no engine at all.
  const engineCandidates = entries.filter(
    (entry) =>
      /\.(so|dll|dylib)\.node$/.test(entry) &&
      (engineSuffixes.length === 0 || engineSuffixes.includes(entry)),
  );

  if (engineCandidates.length === 0) {
    throw new Error(
      `Generated Prisma client has no native query engine for ${architecture ?? "this platform"} in ${sourceRoot}. ` +
        `Found: ${entries.filter((entry) => /\.node$/.test(entry)).join(", ") || "none"}.`,
    );
  }

  // Next standalone can incidentally copy a foreign-platform engine (for example
  // the Windows engine when built on Windows). Remove any engine that is not
  // valid for this release so a Linux artifact can never carry a Windows binary.
  let stagedEntries: string[] = [];
  try {
    stagedEntries = await readdir(destinationRoot);
  } catch {
    stagedEntries = [];
  }
  const accepted = new Set(engineCandidates);
  for (const entry of stagedEntries) {
    if (accepted.has(entry)) continue;
    if (/\.node(\.tmp\d+)?$/i.test(entry)) {
      await rm(path.join(destinationRoot, entry), { force: true });
    }
  }
}

/** Whether a path is an existing directory. */
async function directoryExists(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

export async function stageReleaseArtifact(options: StageReleaseArtifactOptions): Promise<void> {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const destination = path.resolve(options.destination);
  const standaloneRoot = path.resolve(
    options.standaloneRoot ?? path.join(repoRoot, "apps", "web", ".next", "standalone"),
  );
  const manifestSource = path.join(repoRoot, RELEASE_LAYOUT.manifest);
  const serviceTemplateSource = path.join(repoRoot, "scripts", "xistance.service.template");

  await requireDirectory(standaloneRoot, "Next standalone output");

  // Stage public/ and .next/static into the standalone tree. Next's standalone
  // output excludes both, so without this the artifact boots and then 404s every
  // stylesheet and script -- and requiring a caller to remember a separate
  // `stageReleaseAssets` pass first is a trap, because forgetting it fails with
  // "standalone static chunks is missing", which reads like a broken build.
  //
  // Conditional on the Next build inputs being present. A caller staging a
  // synthetic fixture has its own public/ and static trees already inside the
  // standalone root and is asserting about the copy step, not about Next's
  // build output -- `stageReleaseAssets` rightly refuses to run without a real
  // `.next/static/chunks`, so calling it unconditionally breaks those fixtures.
  // The discriminator is the build input, not the standalone tree, which
  // `requireDirectory` above has already established exists.
  if (await directoryExists(path.join(repoRoot, "apps", "web", ".next", "static", "chunks"))) {
    await stageReleaseAssets(repoRoot);
  }
  await requireFile(path.join(standaloneRoot, standaloneRelative(RELEASE_LAYOUT.server)), "standalone server");
  await requireDirectory(path.join(standaloneRoot, standaloneRelative(RELEASE_LAYOUT.public)), "standalone public assets");
  await requireDirectory(path.join(standaloneRoot, standaloneRelative(RELEASE_LAYOUT.staticChunks)), "standalone static chunks");
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = await mkdtemp(path.join(path.dirname(destination), `.${path.basename(destination)}.tmp-`));
  try {
    await cp(standaloneRoot, temporary, {
      recursive: true,
      force: true,
      errorOnExist: false,
      filter: (filePath) => shouldCopy(standaloneRoot, filePath),
    });
    await copyRequiredFile(manifestSource, path.join(temporary, RELEASE_LAYOUT.manifest), "release manifest");
    await copyRequiredFile(serviceTemplateSource, path.join(temporary, RELEASE_LAYOUT.serviceTemplate), "service template");
    await stagePrismaClient({
      // Default to the standalone tree actually being staged, not the in-repo
      // client: when a build came from another architecture, the in-repo
      // packages/db/generated/client still holds the build host's engines and
      // the artifact would ship the wrong architecture even though the payload
      // around it is correct.
      sourceRoot: path.resolve(
        options.prismaClientSource ??
          (options.standaloneRoot
            ? path.join(options.standaloneRoot, RELEASE_LAYOUT.prismaClient)
            : path.join(repoRoot, DEFAULT_PRISMA_CLIENT_SOURCE)),
      ),
      destinationRoot: path.join(temporary, RELEASE_LAYOUT.prismaClient),
      architecture: options.architecture,
    });
    // Migration input must ship in the artifact: a zero-build install cannot run
    // `prisma generate` or fetch a schema, so the SQL and schema are staged here.
    const prismaSchemaSource = path.join(repoRoot, DEFAULT_PRISMA_SCHEMA_SOURCE);
    await requireFile(prismaSchemaSource, "Prisma schema");
    await copyRequiredFile(
      prismaSchemaSource,
      path.join(temporary, RELEASE_LAYOUT.prismaSchema),
      "Prisma schema",
    );
    const migrationSourceRoot = path.join(repoRoot, DEFAULT_PRISMA_MIGRATIONS_SOURCE);
    if (await stat(migrationSourceRoot).then((d) => d.isDirectory()).catch(() => false)) {
      await cp(migrationSourceRoot, path.join(temporary, RELEASE_LAYOUT.prismaMigrations), {
        recursive: true,
        force: true,
        errorOnExist: false,
      });
    }

    // A zero-build install cannot run `prisma migrate deploy` (the CLI is not in
    // the artifact), so the applier that stands in for it must ship.
    const applierSource = path.join(repoRoot, DEFAULT_MIGRATION_APPLIER_SOURCE);
    await requireFile(applierSource, "migration applier");
    await copyRequiredFile(
      applierSource,
      path.join(temporary, RELEASE_LAYOUT.migrationApplier),
      "migration applier",
    );

    // seed.ts is TypeScript and imports the Prisma client, so the first
    // super-admin is created by a standalone script instead. Without it a fresh
    // install has no account to log in with.
    const adminSource = path.join(repoRoot, DEFAULT_ADMIN_CREATOR_SOURCE);
    await requireFile(adminSource, "admin creator");
    await copyRequiredFile(
      adminSource,
      path.join(temporary, RELEASE_LAYOUT.adminCreator),
      "admin creator",
    );

    // Next bakes the build machine's absolute paths into traced chunks, which would
    // make the artifact non-relocatable. Rewrite them relative to the server cwd.
    await rewriteBuildMachinePaths(temporary, repoRoot);
    const inspection = await inspectReleaseArtifact(temporary, options.architecture ? { architecture: options.architecture } : {});
    if (!inspection.ok) {
      throw new Error(`Staged release artifact failed inspection:\n${inspection.errors.join("\n")}`);
    }
    await rm(destination, { recursive: true, force: true });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

const invokedBasename = (process.argv[1] ?? "").replace(/\\/g, "/").split("/").pop()?.toLowerCase();

if (invokedBasename === "stage-release-artifact.ts") {
  const args = process.argv.slice(2);
  const architectureIndex = args.findIndex((arg) => arg === "--architecture");
  const architecture = architectureIndex === -1 ? undefined : args[architectureIndex + 1];
  const standaloneIndex = args.findIndex((arg) => arg === "--standalone");
  const standaloneRoot = standaloneIndex === -1 ? undefined : args[standaloneIndex + 1];
  const clientIndex = args.findIndex((arg) => arg === "--prisma-client");
  const prismaClientSource = clientIndex === -1 ? undefined : args[clientIndex + 1];
  // `findIndex` returns -1 when a flag is absent, and `-1 + 1 === 0`. The old
  // filter therefore excluded index 0 -- the repo root -- whenever
  // `--prisma-client` was omitted, so the stager reported its usage line and
  // exited 2 for a perfectly valid invocation. Any single absent flag ate the
  // first positional argument.
  //
  // Filter by the parsed VALUE rather than by an index arithmetic that is only
  // meaningful when the flag was actually seen.
  const flagValues = new Set(
    [architectureIndex, standaloneIndex, clientIndex]
      .filter((index) => index !== -1)
      .map((index) => args[index + 1]),
  );
  const positional = args.filter((arg) => !arg.startsWith("--") && !flagValues.has(arg));
  const [repoRoot = process.cwd(), destination] = positional;
  // `native` is accepted explicitly for local verification: it keeps the
  // engine for the build host so the artifact can be booted and smoke-tested
  // before it is re-staged for a release architecture. A release build must
  // still pass amd64 or arm64.
  if (
    !destination ||
    (architectureIndex !== -1 &&
      architecture !== "amd64" &&
      architecture !== "arm64" &&
      architecture !== "native") ||
    (standaloneIndex !== -1 && !standaloneRoot) ||
    (clientIndex !== -1 && !prismaClientSource)
  ) {
    console.error(
      "Usage: stage-release-artifact.ts <repo-root> <destination> [--architecture amd64|arm64|native] [--standalone <dir>] [--prisma-client <dir>]",
    );
    process.exitCode = 2;
  } else {
    // Next's standalone output does not include .next/static or public/ — those
    // are copied separately. Staging the artifact without them produces a
    // release that boots but serves no CSS or JS, so this step is part of
    // producing a usable artifact rather than an optional extra.
    stageReleaseAssets(repoRoot)
      .then(() => {
        // "native" means "no explicit target": keep the build host's engine.
        const target =
          architecture === "native" ? undefined : (architecture as ReleaseArchitecture | undefined);
        return stageReleaseArtifact({
          repoRoot,
          destination,
          architecture: target,
          standaloneRoot,
          prismaClientSource,
        });
      })
      .catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
  }
}
