import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
/**
 * Copy the public and Next static trees into the exact locations served by
 * the standalone server. Missing or incomplete build inputs fail the release.
 */
export async function stageReleaseAssets(repoRoot = process.cwd()): Promise<void> {
  const nextDir = path.join(repoRoot, "apps", "web", ".next");
  const standaloneApp = path.join(nextDir, "standalone", "apps", "web");
  const server = path.join(standaloneApp, "server.js");
  const staticSource = path.join(nextDir, "static");
  const staticChunks = path.join(staticSource, "chunks");
  const staticDestination = path.join(standaloneApp, ".next", "static");
  const publicSource = path.join(repoRoot, "apps", "web", "public");
  const publicDestination = path.join(standaloneApp, "public");

  await requireFile(server, "standalone server output");
  await requireDirectory(staticChunks, "Next static chunks");
  await requireFiles(staticChunks, [".js", ".css"], "Next static JS/CSS chunks");
  await requireDirectory(publicSource, "public assets");

  await replaceDirectory(staticSource, staticDestination);
  await replaceDirectory(publicSource, publicDestination);

  await rejectNestedDuplicate(staticDestination, "static");
  await rejectNestedDuplicate(publicDestination, "public");
  await requireDirectory(path.join(staticDestination, "chunks"), "staged static chunks");
  await requireFiles(path.join(staticDestination, "chunks"), [".js", ".css"], "staged static JS/CSS chunks");
  await requireDirectory(publicDestination, "staged public assets");
}

async function replaceDirectory(source: string, destination: string): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  await rm(destination, { recursive: true, force: true });
  try {
    await cp(source, destination, { recursive: true, errorOnExist: true, force: true });
  } catch (error) {
    throw new Error(`Could not stage ${source} into ${destination}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function requireFile(filePath: string, label: string): Promise<void> {
  let details;
  try {
    details = await stat(filePath);
  } catch {
    throw new Error(`Build produced no ${label} (${filePath}).`);
  }
  if (!details.isFile()) throw new Error(`Expected ${label} file (${filePath}).`);
}

async function requireDirectory(directory: string, label: string): Promise<void> {
  let details;
  try {
    details = await stat(directory);
  } catch {
    throw new Error(`Build produced no ${label} (${directory}).`);
  }
  if (!details.isDirectory()) throw new Error(`Expected ${label} directory (${directory}).`);
}

async function requireFiles(directory: string, extensions: string[], label: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  const hasRequiredType = extensions.some((extension) =>
    entries.some((entry) => entry.isFile() && entry.name.endsWith(extension)),
  );
  if (!hasRequiredType) throw new Error(`Build produced no ${label} under ${directory}.`);
}

async function rejectNestedDuplicate(destination: string, name: string): Promise<void> {
  const nested = path.join(destination, name);
  try {
    await stat(nested);
  } catch {
    return;
  }
  throw new Error(`Staged ${name} assets have invalid nested ${name}/${name} layout (${nested}).`);
}

const invokedBasename = (process.argv[1] ?? "").replace(/\\/g, "/").split("/").pop()?.toLowerCase();

if (invokedBasename === "stage-release-assets.ts") {
  stageReleaseAssets(process.argv[2] ?? process.cwd()).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
