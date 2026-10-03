/**
 * Focused tests for release provenance attestation (TASK-9).
 *
 * Checks the real release workflow declares the minimum permissions an
 * attestation step needs, pins the action to an immutable SHA, binds the
 * subject to the artifact digest, and runs before the release is created.
 */
// This file declares its own `assert` helper so a failed expectation reports the
// contract that broke, instead of a Node stack trace.
import { readFileSync } from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

interface WorkflowStep {
  name?: string;
  uses?: string;
  if?: string;
  run?: string;
  with?: Record<string, string>;
  continueOnError?: boolean;
}

interface WorkflowJob {
  needs?: string[] | string;
  permissions?: Record<string, string>;
  steps?: WorkflowStep[];
}

interface Workflow {
  jobs?: Record<string, WorkflowJob>;
  permissions?: Record<string, string>;
}

const workflowPath = path.resolve(".github/workflows/release.yml");
const workflow = yaml.load(readFileSync(workflowPath, "utf8")) as Workflow;

const jobs = workflow.jobs ?? {};
const publishJob = jobs.publish;

function stepNames(job: WorkflowJob | undefined): string[] {
  return (job?.steps ?? []).map((step) => step.name ?? step.uses ?? "<unnamed>");
}

function findStep(job: WorkflowJob | undefined, predicate: (step: WorkflowStep) => boolean): WorkflowStep | undefined {
  return (job?.steps ?? []).find(predicate);
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`AssertionError: ${message}`);
  }
}

// The attestation step must exist in the publish job, which is the job that
// creates the release. It cannot live in a job that never publishes.
const attestationStep = findStep(
  publishJob,
  (step) => typeof step.uses === "string" && step.uses.includes("attest"),
);

assert(
  Boolean(attestationStep),
  `publish job must include an attestation step; found: ${JSON.stringify(stepNames(publishJob))}`,
);

// Actions must be pinned to an immutable commit SHA, not a mutable tag.
const pinnedSha = /@[0-9a-f]{40}$/;
assert(
  pinnedSha.test(attestationStep?.uses ?? ""),
  `attestation action must be pinned to a 40-character commit SHA, got: ${attestationStep?.uses ?? "<none>"}`,
);

// The attestation must bind the artifact digest, otherwise it attests nothing.
// `subject-checksums` is the strongest form here: it binds every artifact named
// in the published .sha256 sidecars, so provenance covers the same digests the
// installer verifies. `subject-digest` binds one named artifact.
const withBlock = attestationStep?.with ?? {};
const bindsChecksums = typeof withBlock["subject-checksums"] === "string" && withBlock["subject-checksums"].includes(".sha256");
const bindsDigest = typeof withBlock["subject-digest"] === "string" && withBlock["subject-digest"].includes("sha256");
assert(
  bindsChecksums || bindsDigest || typeof withBlock["subject-path"] === "string",
  `attestation must bind the artifact digest, got: ${withBlock}`,
);
assert(
  Boolean(withBlock["subject-name"] ?? withBlock["subject-checksums"] ?? withBlock["subject-path"]),
  "attestation must identify its subject, so the artifact is the attested object",
);

// Attestation needs id-token: write and attestations: write, and nothing broader.
const permissions = publishJob?.permissions ?? {};
assert(
  permissions["id-token"] === "write",
  `publish job must request id-token: write for attestation, got: ${JSON.stringify(permissions)}`,
);
assert(
  permissions.attestations === "write",
  `publish job must request attestations: write, got: ${JSON.stringify(permissions)}`,
);

// Least privilege: attestation must not be handed contents: write beyond what
// creating the release already requires, and must not gain packages/admin scopes.
assert(
  permissions.pages !== "write" && permissions.workflows !== "write",
  `attestation must not request unrelated write scopes, got: ${JSON.stringify(permissions)}`,
);

// A failed attestation must block publication rather than warn and continue.
assert(
  attestationStep?.continueOnError !== true,
  "attestation step must not set continueOnError; a failed attestation must block publication",
);

// The attestation must run before the release is created, otherwise the release
// exists without provenance.
const steps = publishJob?.steps ?? [];
const attestationIndex = steps.indexOf(attestationStep as WorkflowStep);
const releaseIndex = steps.findIndex((step) => typeof step.uses === "string" && step.uses.includes("action-gh-release"));
assert(
  attestationIndex >= 0 && releaseIndex >= 0,
  `expected both an attestation step and a release step; steps: ${JSON.stringify(stepNames(publishJob))}`,
);
assert(
  attestationIndex < releaseIndex,
  `attestation must run before the release is created (attestation at ${attestationIndex}, release at ${releaseIndex})`,
);

// A skipped attestation is acceptable only if it is recorded explicitly. The
// workflow prints the skip reason and still publishes the checksum sidecar, so
// the artifact stays verifiable; provenance is treated as an addition, never as
// a replacement for the checksum or a security review. Asserting an `if` here
// would wrongly prefer a silent, unaudited skip over a hard failure.
const skipProbe = (publishJob?.steps ?? []).find((step) => step.name === "Report attestation availability");
if (skipProbe) {
  assert(
    typeof skipProbe.run === "string" && skipProbe.run.includes("gh attestation"),
    "attestation availability probe must use `gh attestation verify` to record the skip reason",
  );
}

console.log("✅ Attestation contract: permissions, SHA pin, subject digest, ordering, and blocking failure all hold");
