import { z } from "zod";

import { canonicalJson } from "../promotion/schema";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u).transform(value => value.toLowerCase());
const SourceFile = z.object({
  path: z.enum(["src/main.ts", "src/styles.css", "src/capabilities.json"]),
  content: z.string().min(1).max(30_000),
}).strict();
const SourceBuildPlan = z.object({
  version: z.literal(1),
  fixture: z.literal("fixtures/minimal"),
  candidateSha256: Digest,
  topologySha256: Digest,
  provider: z.enum(["modal", "fly"]),
  proposalSha256: Digest,
  operationId: z.string().regex(/^source-build:[a-f0-9]{64}$/u),
  capacityIntentReference: z.string().regex(/^capacity-intent:[a-f0-9]{64}$/u),
  sessionBindingDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  workerOperationId: z.string().regex(/^capacity-[a-f0-9]{40}$/u),
  sessionId: z.string().regex(/^source-build:[a-f0-9]{64}$/u),
  actionId: z.string().regex(/^source-build:[a-f0-9]{64}$/u),
  jobId: Digest,
  files: z.array(SourceFile).min(3).max(3),
}).strict().superRefine((value, context) => {
  if (new Set(value.files.map(file => file.path)).size !== value.files.length) {
    context.addIssue({ code: "custom", message: "PRODUCTION_SOURCE_BUILD_FILES_INVALID" });
  }
});

export type MountedSourceBuildPlan = z.infer<typeof SourceBuildPlan>;
export type MountedSourceBuildBinding = Readonly<{ candidateSha256: string; topologySha256: string; provider: "modal" | "fly" }>;
export type MountedSourceBuildExecution = Readonly<Pick<MountedSourceBuildPlan, "proposalSha256" | "files" | "candidateSha256" | "topologySha256" | "provider"> & { authorizationRequestSha256: string; operationId: string; capacityIntentReference: string; sessionBindingDigest: string; workerOperationId: string; sessionId: string; actionId: string; jobId: string }>;

const sourceSha256 = (value: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(value).digest("hex");

/*
 * This is the repository's checked-in `fixtures/minimal` golden napplet,
 * normalized into the narrow worker proposal format.  It deliberately has no
 * dynamic capability or model input: the protected build exercises the pinned
 * toolchain and real Chromium conformance without turning preapproval into
 * generation, funding, or a worker effect.
 */
const MINIMAL_GOLDEN_SOURCE = Object.freeze([
  Object.freeze({
    path: "src/main.ts" as const,
    content: "import { runtimeHasDomain } from './domain-availability.js';\nimport './styles.css';\n\nconst root = document.querySelector<HTMLElement>('#app');\nif (!root) throw new Error('napplet root missing');\nvoid runtimeHasDomain('theme');\nconst main = document.createElement('main');\nconst heading = document.createElement('h1');\nheading.textContent = 'Focused napplet';\nconst detail = document.createElement('p');\ndetail.textContent = 'One purpose, no delegated authority.';\nmain.append(heading, detail);\nroot.replaceChildren(main);\n",
  }),
  Object.freeze({ path: "src/styles.css" as const, content: "html, body, #app { height: 100%; }\nmain { max-width: 42rem; margin: 2rem auto; font-family: sans-serif; }\n" }),
  Object.freeze({ path: "src/capabilities.json" as const, content: "{\"required\":[],\"optional\":[]}\n" }),
]);

/**
 * Materializes a completely local, deterministic source plan.  It performs no
 * provider or journal I/O; the first worker claim is intentionally deferred to
 * the receipt-bound verifier.
 */
export function materializeMountedSourceBuildPlan(binding: MountedSourceBuildBinding): MountedSourceBuildPlan {
  const candidateSha256 = Digest.parse(binding.candidateSha256);
  const topologySha256 = Digest.parse(binding.topologySha256);
  const provider = z.enum(["modal", "fly"]).parse(binding.provider);
  const files = MINIMAL_GOLDEN_SOURCE.map(file => ({ ...file }));
  // Match ProductionSourceProposalStore and the model boundary exactly: a
  // proposal digest is over its `{ files }` envelope, never a bare array.
  const proposalSha256 = sourceSha256(canonicalJson({ files }));
  const operationId = `source-build:${sourceSha256(canonicalJson({ candidateSha256, topologySha256, provider, proposalSha256, fixture: "fixtures/minimal" }))}`;
  const sessionBindingDigest = `sha256:${sourceSha256(canonicalJson({ operationId, candidateSha256, topologySha256, provider, proposalSha256, fixture: "fixtures/minimal" }))}`;
  const capacityIntentReference = `capacity-intent:${sourceSha256(operationId)}`;
  const workerOperationId = `capacity-${sourceSha256(`${capacityIntentReference}:${sessionBindingDigest}`).slice(0, 40)}`;
  const sessionId = operationId;
  const actionId = operationId;
  const jobId = sourceSha256(canonicalJson({ version: 1, operationId, candidateSha256, topologySha256, provider, capacityIntentReference, sessionBindingDigest, workerOperationId, sessionId, actionId, proposalSha256, files }));
  return SourceBuildPlan.parse({ version: 1, fixture: "fixtures/minimal", candidateSha256, topologySha256, provider, proposalSha256, operationId, capacityIntentReference, sessionBindingDigest, workerOperationId, sessionId, actionId, jobId, files });
}

export function assertMountedSourceBuildPlan(value: unknown, binding: MountedSourceBuildBinding): MountedSourceBuildPlan {
  const plan = SourceBuildPlan.parse(value);
  const expected = materializeMountedSourceBuildPlan(binding);
  if (canonicalJson(plan) !== canonicalJson(expected)) throw new Error("PRODUCTION_SOURCE_BUILD_PLAN_BINDING_REQUIRED");
  return plan;
}

/** Binds the immutable preapproval plan to one controller authorization. This
 * separates candidate selection from a particular protected run, so a later
 * receipt cannot attach to an expired worker/job from a previous approval. */
export function bindMountedSourceBuildExecution(plan: MountedSourceBuildPlan, input: Readonly<{ authorizationRequestSha256: string }>): MountedSourceBuildExecution {
  const authorizationRequestSha256 = Digest.parse(input.authorizationRequestSha256);
  const operationId = `source-build:${sourceSha256(canonicalJson({ planJobId: plan.jobId, authorizationRequestSha256 }))}`;
  const sessionBindingDigest = `sha256:${sourceSha256(canonicalJson({ operationId, planJobId: plan.jobId, authorizationRequestSha256, candidateSha256: plan.candidateSha256, topologySha256: plan.topologySha256, provider: plan.provider }))}`;
  const capacityIntentReference = `capacity-intent:${sourceSha256(operationId)}`;
  const workerOperationId = `capacity-${sourceSha256(`${capacityIntentReference}:${sessionBindingDigest}`).slice(0, 40)}`;
  const sessionId = operationId, actionId = operationId;
  const jobId = sourceSha256(canonicalJson({ planJobId: plan.jobId, authorizationRequestSha256, operationId, capacityIntentReference, sessionBindingDigest, workerOperationId, sessionId, actionId }));
  return Object.freeze({ candidateSha256: plan.candidateSha256, topologySha256: plan.topologySha256, provider: plan.provider, proposalSha256: plan.proposalSha256, files: plan.files, authorizationRequestSha256, operationId, capacityIntentReference, sessionBindingDigest, workerOperationId, sessionId, actionId, jobId });
}
