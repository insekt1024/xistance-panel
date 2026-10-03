import { readFile, readdir, lstat } from "node:fs/promises";
import path from "node:path";
export const RELEASE_LAYOUT = Object.freeze({
  // Source output is under apps/web/.next/standalone; the release archive
  // contains the contents of that directory at its root.
  standalone: "apps/web/.next/standalone",
  app: "apps/web",
  server: "apps/web/server.js",
  package: "apps/web/package.json",
  public: "apps/web/public",
  static: "apps/web/.next/static",
  staticChunks: "apps/web/.next/static/chunks",
  buildId: "apps/web/.next/BUILD_ID",
  requiredServerFiles: "apps/web/.next/required-server-files.json",
  nextPackage: "node_modules/next/package.json",
  reactPackage: "node_modules/react/package.json",
  reactDomPackage: "node_modules/react-dom/package.json",
  forwarder: "packages/tunnel-core/src/forwarder-runner.ts",
  manifest: "release-manifest.json",
  serviceTemplate: "xistance.service.template",
  prismaClient: "packages/db/generated/client",
  prismaSchema: "packages/db/prisma/schema.prisma",
  prismaMigrations: "packages/db/prisma/migrations",
  migrationApplier: "apply-migrations.mjs",
  adminCreator: "create-admin.mjs",
} as const);

/**
 * Prisma client entry points that must exist for the server to import the client.
 * Next standalone tracing does not copy these today, so they are staged explicitly.
 */
export const PRISMA_CLIENT_ENTRY_FILES = Object.freeze([
  "index.js",
  "default.js",
  "package.json",
] as const);

/**
 * The generated client requires its sibling `runtime/` library tree. Shipping the
 * entry points without it produces a client that loads but throws MODULE_NOT_FOUND
 * on the first real query, so the runtime directory is part of the contract.
 */
export const PRISMA_CLIENT_RUNTIME_DIR = "runtime";

/**
 * Native query engines by artifact architecture. A Linux release must carry a
 * Linux engine; a Windows engine is unusable on Ubuntu and vice versa.
 *
 * The `arm64` names are NOT derivable from the `amd64` ones: Prisma publishes
 * linux-arm64 engines under *prefixed* platform ids (`linux-arm64-openssl-3.0.x`),
 * not as an `-arm64` suffix on the debian id, and the musl variant is
 * `linux-musl-arm64-openssl-3.0.x` rather than the arch-free `linux-musl-…`.
 * The first published arm64 target is openssl-3.0.x, so 1.1.x is listed second
 * only as a fallback. `linux-static-arm64` is a *target* with no published
 * query engine and is deliberately absent.
 *
 * Every name here is pinned by `test-release-artifact.ts`, which cross-checks
 * this table against the platform ids the installed Prisma client actually
 * ships, and by `test-prisma-engine-targets.ts`, which probes
 * binaries.prisma.sh with an x64 control.
 */
export const PRISMA_LINUX_ENGINES: Record<ReleaseArchitecture, readonly string[]> = Object.freeze({
  amd64: Object.freeze([
    "libquery_engine-debian-openssl-3.0.x.so.node",
    "libquery_engine-debian-openssl-1.1.x.so.node",
    "libquery_engine-linux-musl-openssl-3.0.x.so.node",
  ]),
  arm64: Object.freeze([
    "libquery_engine-linux-arm64-openssl-3.0.x.so.node",
    "libquery_engine-linux-arm64-openssl-1.1.x.so.node",
    "libquery_engine-linux-musl-arm64-openssl-3.0.x.so.node",
  ]),
} as const);

const FOREIGN_ENGINE_PATTERN = /query_engine-windows\.dll\.node(\.tmp\d+)?/i;

/**
 * A native addon that a Linux release must not carry, anywhere in the payload.
 *
 * The Prisma-specific check only inspects the generated client directory. Every
 * other native module arrives through `node_modules`, so a Windows build machine
 * silently leaks `@img/sharp-win32-x64/lib/*.node` into an otherwise-Linux
 * release. TASK-79 shipped exactly that: a 442KB Windows PE in the amd64
 * archive.
 *
 * Deny-by-default on the platform tag. A `.dll.node`/`.dylib.node` is foreign by
 * extension. A bare `.node` is foreign unless some path segment names a Linux
 * platform, so a new or unknown platform tag (`webcontainers`, `freebsd`, a
 * future one) is treated as foreign rather than silently accepted — the safe
 * direction for a release gate. Metadata and JS inside a foreign package
 * (`package.json`, `index.cjs`) are NOT flagged, because only the binary is
 * unusable.
 *
 * The tag table is derived from the installed `sharp` platform matrix, not
 * guessed; see `test-foreign-native-bins.ts`.
 */
const LINUX_PLATFORM_PREFIX =
  /^(?:linux(?:musl)?|debian|rhel|suse|alpine|al2023|ubi|centos)/i;
const FOREIGN_NATIVE_EXTENSION = /\.(?:dll|dylib)\.node(?:\.tmp\d+)?$/i;
const FOREIGN_PLATFORM_SEGMENT =
  /^(?:win32|windows|darwin|macos|osx|freebsd\w*|webcontainers\w*|sunos|solaris|aix|android|haiku)/i;

export function isForeignNativeBinary(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/").toLowerCase();
  if (FOREIGN_NATIVE_EXTENSION.test(normalized)) return true;
  if (!normalized.endsWith(".node")) return false;

  for (const segment of normalized.split("/").slice(0, -1)) {
    const sharpTag = /^sharp-(.+)$/.exec(segment);
    const tag = sharpTag?.[1] ?? (FOREIGN_PLATFORM_SEGMENT.test(segment) ? segment : undefined);
    if (tag === undefined) continue;
    if (!LINUX_PLATFORM_PREFIX.test(tag)) return true;
  }
  return false;
}

export type ReleaseArchitecture = "amd64" | "arm64";

export interface InspectionOptions {
  architecture?: ReleaseArchitecture;
}

export interface InspectionResult {
  ok: boolean;
  root: string;
  architecture: ReleaseArchitecture | null;
  errors: string[];
  warnings: string[];
  checkedFiles: number;
}

const REQUIRED_STATIC_EXTENSIONS = [".js", ".css"] as const;
const SECRET_FILE_PATTERN = /(?:^|[\\/])(?:\.env(?:\..*)?|id_rsa(?:\..*)?|credentials(?:\..*)?|.*\.(?:pem|key|p12|pfx))$/i;
const DATABASE_FILE_PATTERN = /\.(?:db|sqlite|sqlite3)(?:-(?:journal|wal|shm))?$/i;
const LOG_FILE_PATTERN = /\.log$/i;

function relative(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join("/");
}

async function requireFile(root: string, relativePath: string, errors: string[]): Promise<void> {
  const filePath = path.join(root, relativePath);
  try {
    const details = await lstat(filePath);
    if (!details.isFile()) {
      errors.push(`Required file is not a regular file: ${relativePath}`);
    }
  } catch {
    errors.push(`Missing required file: ${relativePath}`);
  }
}

async function requireDirectory(root: string, relativePath: string, errors: string[]): Promise<void> {
  const filePath = path.join(root, relativePath);
  try {
    const details = await lstat(filePath);
    if (!details.isDirectory()) {
      errors.push(`Required directory is not a directory: ${relativePath}`);
    }
  } catch {
    errors.push(`Missing required directory: ${relativePath}`);
  }
}

async function requireStaticAssets(root: string, errors: string[]): Promise<void> {
  const chunksPath = path.join(root, RELEASE_LAYOUT.staticChunks);
  try {
    const entries = await readdir(chunksPath, { withFileTypes: true });
    for (const extension of REQUIRED_STATIC_EXTENSIONS) {
      if (!entries.some((entry) => entry.isFile() && entry.name.endsWith(extension))) {
        errors.push(`Missing required static asset type under ${RELEASE_LAYOUT.staticChunks}: ${extension}`);
      }
    }
  } catch {
    // The missing-directory error is already emitted by requireDirectory.
  }
}

async function walk(root: string, current = root): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const filePath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(root, filePath)));
    } else if (entry.isFile()) {
      files.push(filePath);
    } else {
      files.push(filePath);
    }
  }
  return files;
}

async function inspectForbiddenFiles(
  root: string,
  architecture: ReleaseArchitecture | null,
  errors: string[],
): Promise<number> {
  let files: string[];
  try {
    files = await walk(root);
  } catch (error) {
    errors.push(`Could not enumerate artifact: ${error instanceof Error ? error.message : String(error)}`);
    return 0;
  }

  for (const filePath of files) {
    const rel = relative(root, filePath);
    const lower = rel.toLowerCase();
    const segments = lower.split("/");
    if (SECRET_FILE_PATTERN.test(lower)) errors.push(`Forbidden secret/state file: ${rel}`);
    if (DATABASE_FILE_PATTERN.test(lower)) errors.push(`Forbidden database file: ${rel}`);
    if (LOG_FILE_PATTERN.test(lower)) errors.push(`Forbidden log file: ${rel}`);
    if (lower.startsWith("tunnels/tunnels/") || lower === "tunnels/tunnels") {
      errors.push(`Forbidden mutable tunnel state: ${rel}`);
    }
    if (lower.startsWith("tunnels/") && segments.includes("logs")) {
      errors.push(`Forbidden log file: ${rel}`);
    }
    if (lower.startsWith(".git/") || lower === ".git" || lower.startsWith(".next/cache/") || lower === ".next/cache") {
      errors.push(`Forbidden development/cache state: ${rel}`);
    }
    if (lower.includes("/node_modules/.cache/") || lower.includes("/node_modules/.bin/")) {
      errors.push("Forbidden development dependency state: " + rel);
    }
    if (architecture && isForeignNativeBinary(rel)) {
      errors.push(
        `Payload contains a foreign-platform native binary for a ${architecture} release: ${rel}. ` +
          "A Windows or macOS native module is unusable on the target host and means the " +
          "artifact was staged on a build machine of the wrong platform.",
      );
    }
  }
  return files.length;
}

async function inspectPrismaRuntime(root: string, architecture: ReleaseArchitecture | null, errors: string[]): Promise<void> {
  const clientRoot = path.join(root, RELEASE_LAYOUT.prismaClient);
  for (const entry of PRISMA_CLIENT_ENTRY_FILES) {
    await requireFile(clientRoot, entry, errors);
  }
  await requireDirectory(clientRoot, PRISMA_CLIENT_RUNTIME_DIR, errors);
  // A zero-build install cannot fetch a schema, so it must ship in the artifact.
  await requireFile(root, RELEASE_LAYOUT.prismaSchema, errors);
  await requireDirectory(root, RELEASE_LAYOUT.prismaMigrations, errors);
  // The Prisma CLI is not shipped, so the applier that replaces
  // `prisma migrate deploy` must be present and runnable.
  await requireFile(root, RELEASE_LAYOUT.migrationApplier, errors);
  await requireFile(root, RELEASE_LAYOUT.adminCreator, errors);

  let clientEntries: string[] = [];
  try {
    clientEntries = await readdir(clientRoot);
  } catch {
    clientEntries = [];
  }

  // A "foreign" engine is only foreign relative to the target. A `native`
  // (local verification) staging deliberately keeps the build host's engine, so
  // flagging it would make local smoke-testing impossible while adding nothing
  // to the safety of a real Linux release.
  if (architecture) {
    const foreign = clientEntries.filter((entry) => FOREIGN_ENGINE_PATTERN.test(entry));
    for (const entry of foreign) {
      errors.push(
        `Prisma payload contains a foreign-platform engine for a ${architecture} release: ` +
          `${RELEASE_LAYOUT.prismaClient}/${entry}`,
      );
    }
  }

  if (architecture) {
    const accepted = PRISMA_LINUX_ENGINES[architecture];
    const present = clientEntries.filter((entry) => accepted.includes(entry));
    if (present.length === 0) {
      errors.push(
        `Prisma payload has no native query engine for ${architecture} (expected one of: ${accepted.join(", ")}). ` +
          "A Windows-only or engine-less payload cannot start on the target host.",
      );
    }
  }
}

async function inspectManifest(root: string, architecture: ReleaseArchitecture | null, errors: string[], warnings: string[]): Promise<void> {
  const manifestPath = path.join(root, RELEASE_LAYOUT.manifest);
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch {
    return;
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    errors.push(`Release manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    errors.push("Release manifest must be a JSON object");
    return;
  }

  const record = manifest as Record<string, unknown>;
  const required = ["schemaVersion", "version", "releaseTag", "commit", "architecture", "artifact"] as const;
  for (const key of required) {
    if (!(key in record)) errors.push(`Release manifest is missing required field: ${key}`);
  }

  const version = record.version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    errors.push("Release manifest version must be a semantic version");
  }
  const releaseTag = record.releaseTag;
  if (typeof version === "string" && releaseTag !== `v${version}`) {
    errors.push("Release manifest releaseTag must match v<version>");
  }
  if (typeof record.commit !== "string" || !/^[0-9a-f]{40}$/i.test(record.commit)) {
    errors.push("Release manifest commit must be a full 40-character Git SHA");
  }
  if (record.architecture !== "amd64" && record.architecture !== "arm64") {
    errors.push("Release manifest architecture must be amd64 or arm64");
  } else if (architecture && record.architecture !== architecture) {
    errors.push(`Release manifest architecture mismatch: expected ${architecture}`);
  }
  if (record.artifact !== undefined && (!record.artifact || typeof record.artifact !== "object" || Array.isArray(record.artifact))) {
    errors.push("Release manifest artifact must be an object");
  }

  const secretKeyPattern = /(password|secret|token|private.?key|database.?url|jwt)/i;
  for (const [key, value] of Object.entries(record)) {
    if (secretKeyPattern.test(key)) errors.push(`Release manifest contains forbidden secret field: ${key}`);
    if (typeof value === "string" && (value.startsWith("C:\\\\") || value.startsWith("E:\\\\") || value.startsWith("/Users/") || value.startsWith("/home/"))) {
      errors.push(`Release manifest contains a local absolute path in ${key}`);
    }
  }

  if (record.schemaVersion !== 1) warnings.push(`Unexpected manifest schemaVersion: ${String(record.schemaVersion)}`);
}

export async function inspectReleaseArtifact(
  root: string,
  options: InspectionOptions = {},
): Promise<InspectionResult> {
  const architecture = options.architecture ?? null;
  const errors: string[] = [];
  const warnings: string[] = [];
  const absoluteRoot = path.resolve(root);

  for (const relativePath of [
    RELEASE_LAYOUT.server,
    RELEASE_LAYOUT.package,
    RELEASE_LAYOUT.buildId,
    RELEASE_LAYOUT.requiredServerFiles,
    RELEASE_LAYOUT.nextPackage,
    RELEASE_LAYOUT.reactPackage,
    RELEASE_LAYOUT.reactDomPackage,
    RELEASE_LAYOUT.forwarder,
    RELEASE_LAYOUT.manifest,
    RELEASE_LAYOUT.serviceTemplate,
  ]) {
    await requireFile(absoluteRoot, relativePath, errors);
  }
  for (const relativePath of [RELEASE_LAYOUT.public, RELEASE_LAYOUT.static, RELEASE_LAYOUT.staticChunks]) {
    await requireDirectory(absoluteRoot, relativePath, errors);
  }
  await requireStaticAssets(absoluteRoot, errors);
  await inspectPrismaRuntime(absoluteRoot, architecture, errors);

  if (architecture) {
    if (architecture !== "amd64" && architecture !== "arm64") {
      errors.push(`Unsupported architecture: ${architecture}`);
    }
  }
  await inspectManifest(absoluteRoot, architecture, errors, warnings);

  const checkedFiles = await inspectForbiddenFiles(absoluteRoot, architecture, errors);
  return { ok: errors.length === 0, root: absoluteRoot, architecture, errors, warnings, checkedFiles };
}

export function formatInspectionSummary(result: InspectionResult): string {
  const lines = [
    `Release artifact inspection: ${result.ok ? "PASS" : "FAIL"}`,
    `Architecture: ${result.architecture ?? "unspecified"}`,
    `Checked files: ${result.checkedFiles}`,
  ];
  for (const warning of result.warnings) lines.push(`Warning: ${warning}`);
  for (const error of result.errors) lines.push(`Error: ${error}`);
  return lines.join("\n");
}

export function parseInspectionArguments(args: string[]): { root: string; json: boolean; architecture?: ReleaseArchitecture } {
  let root: string | undefined;
  let json = false;
  let architecture: ReleaseArchitecture | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") json = true;
    else if (arg === "--architecture") {
      const value = args[index + 1];
      if (value !== "amd64" && value !== "arm64") throw new Error("Architecture must be amd64 or arm64");
      architecture = value;
      index += 1;
    } else if (!arg.startsWith("-") && !root) root = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { root: root ?? process.cwd(), json, architecture };
}

export async function runInspectionCli(args = process.argv.slice(2)): Promise<number> {
  const parsed = parseInspectionArguments(args);
  const result = await inspectReleaseArtifact(parsed.root, { architecture: parsed.architecture });
  if (parsed.json) console.log(JSON.stringify(result, null, 2));
  else console.log(formatInspectionSummary(result));
  return result.ok ? 0 : 1;
}

const invokedBasename = (process.argv[1] ?? "").replace(/\\/g, "/").split("/").pop()?.toLowerCase();

if (invokedBasename === "inspect-release-artifact.ts") {
  runInspectionCli().then((code) => { process.exitCode = code; }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
