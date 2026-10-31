import { z } from "zod";
import { ImmutableObjectReferenceSchema, type ObjectStorePort } from "../continuity/object-store";

import { validateAuthorizationReceipt, validateAuthorizationRequest } from "../release/authorization";
import type { ProductionSourceBuildVerifier } from "../release/deployment/production-session-runtime";
import { canonicalJson } from "../promotion/schema";
import { ProductionWorkerJobClient } from "../worker-adapters/production-job-client";
import { PRODUCTION_WORKER_POLICY } from "../worker-adapters/production-worker-policy";
import { ProductionArtifactVerifier, readVerifiedProductionArtifactFile } from "./artifact-verifier";
import type { ProductionConfig } from "./config";
import type { ProductionGenerationRuntime } from "./generation-runtime";
import type { MountedProductionSessionRecord } from "./mounted-session-record";
import { assertMountedSourceBuildPlan, bindMountedSourceBuildExecution, type MountedSourceBuildExecution } from "./source-build-plan";
import type { ProductionReadyCapacityPort } from "./worker-capacity";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u).transform(value => value.toLowerCase());
const Request = z.object({
  authority: z.literal("production-real"), operationId: z.string().regex(/^[a-z][a-z0-9:_-]{2,127}$/u),
  kind: z.enum(["edge.security.build", "edge.security.hostile", "edge.security.browser", "edge.security.signer", "edge.supply.primary", "edge.supply.secondary", "edge.supply.attestation", "edge.payment.contextvm", "edge.payment.cep8", "edge.payment.model", "edge.publication.source", "edge.publication.submit", "edge.publication.reconcile"]),
  candidateSha256: Digest, topologySha256: Digest, payload: z.record(z.string(), z.unknown()), observation: z.unknown().optional(),
}).strict();
const BuildPayload = z.object({ candidateId: Digest, image: z.string().min(1).max(1_024) }).strict();
const EdgePayload = z.object({ candidateId: Digest }).passthrough();
const NativeEdgeCertification = z.object({ version: z.literal(2), candidateSha256: Digest, topologySha256: Digest, hostile: z.object({ filesystemDenied: z.literal(true), networkDenied: z.literal(true), noInboundPorts: z.literal(true), nonRoot: z.literal(true), minimalCapabilities: z.literal(true) }).strict(), cgroup: z.object({ cpuQuotaMicros: z.number().int().positive(), cpuPeriodMicros: z.number().int().positive(), memoryMaxBytes: z.number().int().positive().max(2_048 * 1024 * 1024), pidsMax: z.number().int().positive().max(256) }).strict(), imageToolchain: z.object({ format: z.literal("immutable-image-files-v1"), sha256: Digest, files: z.array(z.object({ path: z.string().regex(/^\/toolchain\//u), sha256: Digest }).strict()).length(6) }).strict(), provider: z.object({ state: z.literal("verified"), originalOperationId: z.string().min(1), resourceId: z.string().min(1), image: z.string().regex(/^.+@sha256:[a-f0-9]{64}$/iu), sessionLeaseSha256: Digest, toolchainMeasurementSha256: Digest, expiresAtEpochMs: z.number().int().positive(), observedAtEpochMs: z.number().int().positive(), hardStop: z.object({ kind: z.literal("provider-enforced"), policyVersion: z.string().min(1), maximumLifetimeMs: z.number().int().positive().max(1_200_000) }).strict(), observedTermination: z.object({ state: z.enum(["not-observed", "observed"]), observedAtEpochMs: z.number().int().positive().optional() }).strict() }).strict(), supply: z.object({ format: z.literal("installed-package-inventory-v1"), primary: z.object({ aggregateSha256: Digest, lockSha256: Digest, commandEvidenceSha256: Digest, installed: z.object({ format: z.literal("installed-package-inventory-v1"), sha256: Digest, packages: z.array(z.object({ name: z.string().min(1), version: z.string().min(1), packageJsonSha256: Digest }).strict()).min(1) }).strict() }).strict(), secondary: z.object({ aggregateSha256: Digest, lockSha256: Digest, commandEvidenceSha256: Digest, installed: z.object({ format: z.literal("installed-package-inventory-v1"), sha256: Digest, packages: z.array(z.object({ name: z.string().min(1), version: z.string().min(1), packageJsonSha256: Digest }).strict()).min(1) }).strict() }).strict() }).strict() }).strict();
const DryRun = z.object({ manifests: z.array(z.unknown()).length(1) }).passthrough();
const Workspace = z.object({
  version: z.literal(1),
  source: z.object({ files: z.array(z.object({ path: z.string(), content: z.string() }).strict()).min(1).max(3) }).passthrough(),
  artifact: z.object({ files: z.array(z.object({ path: z.string(), sha256: Digest, size: z.number().int().nonnegative().max(16_777_216), bytesBase64: z.string().max(22_369_624) }).strict()).min(1).max(256) }).passthrough(),
}).passthrough();
export const MountedSourceBuildResultSchema = z.object({ candidateId: Digest, sealedArtifactSha256: Digest, manifestSha256: Digest, capabilitiesSha256: Digest, aggregateSha256: Digest, jobId: Digest, workerOperationId: z.string().regex(/^capacity-[a-f0-9]{40}$/u), capacityReference: z.string().regex(/^capacity:[a-f0-9]{64}$/u) }).strict();
const StoredEvidence = z.object({ key: z.string().min(1).max(512), checksum: Digest, result: MountedSourceBuildResultSchema }).strict();
export type MountedSourceBuildResult = z.infer<typeof MountedSourceBuildResultSchema>;
const ImmutableReference = ImmutableObjectReferenceSchema;
export const MountedSourceBuildEvidenceSchema = z.object({
  version: z.literal(1),
  artifact: z.object({ sealedObjectSha256: Digest, aggregateSha256: Digest, files: z.array(z.object({ path: z.string().max(256).regex(/^[A-Za-z0-9._/-]+$/u).refine(value => value.split("/").every(part => part !== "" && part !== "." && part !== "..")), sha256: Digest, size: z.number().int().nonnegative().max(16_777_216), bytesBase64: z.string().max(22_369_624) }).strict()).min(1).max(256) }).strict(),
  receipts: z.object({ manifest: z.unknown(), manifestSha256: Digest, capabilities: z.object({ content: z.string().max(30_000), capabilitiesSha256: Digest }).strict(), workerArtifactSha256: Digest, commandEvidenceSha256: Digest, edgeCertification: NativeEdgeCertification.optional() }).strict(),
  operation: z.object({ operationId: z.string().min(1), planJobId: Digest, authorizationRequestSha256: Digest, topologySha256: Digest }).merge(MountedSourceBuildResultSchema).strict(),
}).strict();
export type MountedSourceBuildEvidence = z.infer<typeof MountedSourceBuildEvidenceSchema>;
const sha256 = (value: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
const MAX_EVIDENCE_BYTES = 24 * 1_024 * 1_024;

function abortAfter(ms: number): Readonly<{ signal: AbortSignal; dispose(): void }> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), ms);
  return Object.freeze({ signal: controller.signal, dispose: () => clearTimeout(timer) });
}

function selectNativeEdgeObservation(kind: string, result: MountedSourceBuildResult, edge: unknown): unknown {
  if (kind === "edge.security.build") return result;
  const observed = NativeEdgeCertification.parse(edge);
  if (observed.supply.primary.aggregateSha256 !== observed.supply.secondary.aggregateSha256 || observed.supply.primary.lockSha256 !== observed.supply.secondary.lockSha256) throw new Error("PRODUCTION_EDGE_REPRODUCTION_REQUIRED");
  if (kind === "edge.security.hostile") return Object.freeze({ candidateId: result.candidateId, sealedArtifactSha256: result.sealedArtifactSha256, manifestSha256: result.manifestSha256, capabilitiesSha256: result.capabilitiesSha256, aggregateSha256: result.aggregateSha256, nativeObservation: observed.hostile });
  if (kind === "edge.supply.primary") return Object.freeze({ candidateId: result.candidateId, build: "primary" as const, nativeObservation: observed.supply.primary });
  if (kind === "edge.supply.secondary") return Object.freeze({ candidateId: result.candidateId, build: "secondary" as const, nativeObservation: observed.supply.secondary });
  if (kind === "edge.supply.attestation") return Object.freeze({ candidateId: result.candidateId, nativeObservation: Object.freeze({ sbomFormat: observed.supply.format, primary: observed.supply.primary, secondary: observed.supply.secondary }) });
  throw new Error("PRODUCTION_EDGE_ORIGINAL_VERIFIER_REQUIRED");
}

/** Durable evidence is claimed before immutable upload. A fresh process can
 * only observe the exact original after an acknowledgement is lost. */
export async function resumeMountedSourceBuildEvidence(input: Readonly<{
  journal: ProductionGenerationRuntime["dependencies"]["jobJournal"];
  artifactStore: ObjectStorePort;
  candidateSha256: string;
  run: MountedSourceBuildExecution;
}>): Promise<Readonly<{ status: "passed"; artifactReceipt: Readonly<{ evidenceObject: unknown }> }> & MountedSourceBuildResult | undefined> {
  const stored = await input.journal.read<unknown>(`source-build-evidence:${input.run.jobId}`);
  if (!stored) return undefined;
  const value = StoredEvidence.parse(stored.value);
  const identity = sha256(canonicalJson(value));
  if (stored.identitySha256 !== identity || value.result.candidateId !== input.candidateSha256 || value.result.workerOperationId !== input.run.workerOperationId) {
    throw new Error("PRODUCTION_SOURCE_BUILD_EVIDENCE_BINDING_REQUIRED");
  }
  const evidenceObject = await input.artifactStore.observeExactByKey({ key: value.key, checksum: value.checksum });
  if (!evidenceObject) throw new Error("PRODUCTION_SOURCE_BUILD_PERSISTENCE_UNKNOWN");
  return Object.freeze({ status: "passed" as const, ...value.result, artifactReceipt: Object.freeze({ evidenceObject }) });
}

/** Reads the immutable source-build receipt after its durable original has
 * already been claimed. Consumers get verified bytes from object storage,
 * never large build payloads from a PostgreSQL journal row. */
export async function readMountedSourceBuildEvidence(input: Readonly<{
  journal: ProductionGenerationRuntime["dependencies"]["jobJournal"];
  artifactStore: ObjectStorePort;
  candidateSha256: string;
  run: MountedSourceBuildExecution;
}>): Promise<Readonly<{ result: MountedSourceBuildResult; evidenceObject: z.infer<typeof ImmutableReference>; evidence: MountedSourceBuildEvidence }>> {
  const resumed = await resumeMountedSourceBuildEvidence(input);
  if (!resumed) throw new Error("PRODUCTION_SOURCE_BUILD_EVIDENCE_UNAVAILABLE");
  const evidenceObject = ImmutableReference.parse(resumed.artifactReceipt.evidenceObject);
  const bytes = await input.artifactStore.readExact(evidenceObject);
  if (!bytes || bytes.byteLength > MAX_EVIDENCE_BYTES || sha256(bytes) !== evidenceObject.checksum) throw new Error("PRODUCTION_SOURCE_BUILD_EVIDENCE_BYTES_REQUIRED");
  const evidence = MountedSourceBuildEvidenceSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  const { operationId: _operationId, planJobId: _planJobId, authorizationRequestSha256: _authorizationRequestSha256, topologySha256: _topologySha256, ...result } = evidence.operation;
  const { status: _status, artifactReceipt: _artifactReceipt, ...resumedResult } = resumed;
  const sealedFiles = evidence.artifact.files.map(file => {
    const decoded = Buffer.from(file.bytesBase64, "base64");
    if (decoded.toString("base64") !== file.bytesBase64 || decoded.byteLength !== file.size || sha256(decoded) !== file.sha256) throw new Error("PRODUCTION_SOURCE_BUILD_EVIDENCE_FILE_CHANGED");
    return { path: file.path, sha256: file.sha256, bytes: file.size };
  });
  if (new Set(sealedFiles.map(file => file.path)).size !== sealedFiles.length
    || sha256(JSON.stringify(sealedFiles)) !== evidence.artifact.sealedObjectSha256
    || sha256(sealedFiles.map(file => `${file.sha256} /${file.path}\n`).sort().join("")) !== evidence.artifact.aggregateSha256
    || evidence.artifact.sealedObjectSha256 !== resumedResult.sealedArtifactSha256
    || evidence.artifact.aggregateSha256 !== resumedResult.aggregateSha256
    || sha256(canonicalJson(evidence.receipts.manifest)) !== evidence.receipts.manifestSha256
    || evidence.receipts.manifestSha256 !== resumedResult.manifestSha256
    || sha256(evidence.receipts.capabilities.content) !== evidence.receipts.capabilities.capabilitiesSha256
    || evidence.receipts.capabilities.capabilitiesSha256 !== resumedResult.capabilitiesSha256) throw new Error("PRODUCTION_SOURCE_BUILD_EVIDENCE_CONTENT_BINDING_REQUIRED");
  if (evidence.operation.topologySha256 !== input.run.topologySha256 || evidence.operation.candidateId !== input.candidateSha256 || evidence.operation.workerOperationId !== input.run.workerOperationId
    || evidence.operation.authorizationRequestSha256 !== input.run.authorizationRequestSha256
    || evidence.operation.operationId !== input.run.operationId
    || canonicalJson(result) !== canonicalJson(MountedSourceBuildResultSchema.parse(resumedResult))) {
    throw new Error("PRODUCTION_SOURCE_BUILD_EVIDENCE_BINDING_REQUIRED");
  }
  return Object.freeze({ result: MountedSourceBuildResultSchema.parse(resumedResult), evidenceObject, evidence });
}

export async function persistMountedSourceBuildEvidence(input: Readonly<{
  journal: ProductionGenerationRuntime["dependencies"]["jobJournal"];
  artifactStore: ObjectStorePort;
  run: MountedSourceBuildExecution;
  value: Readonly<{ key: string; checksum: string; result: MountedSourceBuildResult }>;
  bytes: Uint8Array;
}>): Promise<unknown> {
  const value = StoredEvidence.parse(input.value);
  if (input.bytes.byteLength > MAX_EVIDENCE_BYTES || value.checksum !== sha256(input.bytes)) throw new Error("PRODUCTION_SOURCE_BUILD_EVIDENCE_LIMIT");
  const identity = sha256(canonicalJson(value));
  const claimed = await input.journal.claim(`source-build-evidence:${input.run.jobId}`, identity, value);
  if (!claimed.claimed) {
    if (claimed.record.identitySha256 !== identity || canonicalJson(claimed.record.value) !== canonicalJson(value)) throw new Error("PRODUCTION_SOURCE_BUILD_EVIDENCE_BINDING_REQUIRED");
    const observed = await input.artifactStore.observeExactByKey({ key: value.key, checksum: value.checksum });
    if (!observed) throw new Error("PRODUCTION_SOURCE_BUILD_PERSISTENCE_UNKNOWN");
    return observed;
  }
  try {
    const persisted = await input.artifactStore.createImmutable({ key: value.key, bytes: input.bytes });
    if (persisted.key !== value.key || persisted.checksum !== value.checksum) throw new Error("PRODUCTION_SOURCE_BUILD_EVIDENCE_BINDING_REQUIRED");
    return persisted;
  } catch {
    const observed = await input.artifactStore.observeExactByKey({ key: value.key, checksum: value.checksum });
    if (observed) return observed;
    throw new Error("PRODUCTION_SOURCE_BUILD_PERSISTENCE_UNKNOWN");
  }
}

/** Cleanup is separately journaled from evidence. If the provider loses its
 * acknowledgement, recovery observes that original and never dispatches a
 * second termination. */
export async function releaseMountedSourceBuildCapacity(input: Readonly<{
  journal: ProductionGenerationRuntime["dependencies"]["jobJournal"];
  capacity: Pick<ProductionReadyCapacityPort, "release" | "observeRelease">;
  run: MountedSourceBuildExecution;
  record: Readonly<{ intentReference: string; reference: string; workerOperationId: string }>;
}>): Promise<void> {
  const value = { intentReference: input.record.intentReference, reference: input.record.reference, workerOperationId: input.record.workerOperationId };
  const identity = sha256(canonicalJson(value));
  const claimed = await input.journal.claim(`source-build-cleanup:${input.run.jobId}`, identity, value);
  if (claimed.claimed) {
    await input.capacity.release({ intentReference: input.record.intentReference, reference: input.record.reference });
    return;
  }
  if (claimed.record.identitySha256 !== identity || canonicalJson(claimed.record.value) !== canonicalJson(value)) throw new Error("PRODUCTION_SOURCE_BUILD_CLEANUP_BINDING_REQUIRED");
  await observeMountedSourceBuildCapacityCleanup(input);
}

/** Query-only cleanup recovery. An absent cleanup original is intentionally a
 * no-op: evidence reads must never start a worker release. */
export async function observeMountedSourceBuildCapacityCleanup(input: Readonly<{
  journal: ProductionGenerationRuntime["dependencies"]["jobJournal"];
  capacity: Pick<ProductionReadyCapacityPort, "observeRelease">;
  run: MountedSourceBuildExecution;
  record: Readonly<{ intentReference: string; reference: string; workerOperationId: string }>;
}>): Promise<void> {
  const value = { intentReference: input.record.intentReference, reference: input.record.reference, workerOperationId: input.record.workerOperationId };
  const identity = sha256(canonicalJson(value));
  const stored = await input.journal.read<unknown>(`source-build-cleanup:${input.run.jobId}`);
  if (!stored) return;
  if (stored.identitySha256 !== identity || canonicalJson(stored.value) !== canonicalJson(value)) throw new Error("PRODUCTION_SOURCE_BUILD_CLEANUP_BINDING_REQUIRED");
  const observed = await input.capacity.observeRelease({ intentReference: input.record.intentReference, reference: input.record.reference });
  if (observed.status !== "terminated") throw new Error("PRODUCTION_SOURCE_BUILD_CLEANUP_UNKNOWN");
}

/** The sealed worker path for the exact golden source. It is receipt-bound,
 * uses original-operation journals for every effect, and never turns a stored
 * preapproval digest or a caller-provided observation into a pass result. */
export function createMountedProductionSourceBuildVerifier(input: Readonly<{
  config: ProductionConfig;
  record: MountedProductionSessionRecord;
  authorization: ProductionGenerationRuntime["authorization"];
  dependencies: ProductionGenerationRuntime["dependencies"];
  now?: () => number;
}>): ProductionSourceBuildVerifier {
  const execution = input.record.execution, build = execution.protected.sourceBuild, plan = assertMountedSourceBuildPlan(build.plan, { candidateSha256: input.config.candidateSha256, topologySha256: input.config.topologySha256, provider: input.record.workerCandidate.provider, publication: { server: input.config.publication.uploadServer } });
  if (build.candidateSha256 !== input.config.candidateSha256 || build.topologySha256 !== input.config.topologySha256 || build.image !== input.config.worker.image
    || build.sourceSha256 !== execution.materialization.source.sourceSha256 || input.record.workerCandidate.sourceSha256 !== build.sourceSha256
    || input.record.workerCandidate.provider !== execution.workerSelection.provider) throw new Error("PRODUCTION_SOURCE_BUILD_BINDING_REQUIRED");
  const provider = input.record.workerCandidate.provider, capacity = input.dependencies.certificationCapacities[provider];
  const workerRequest = (run: MountedSourceBuildExecution) => Object.freeze({ sessionId: run.sessionId, actionId: run.actionId, expectedVersion: 0, policyVersion: "production-certification-source-build-v1", capabilityGrant: "production-certification-source-build", workspaceId: `workspace:${run.operationId}`, sourceProposalReference: `proposal:sha256:${run.proposalSha256}`, sourceProposalSha256: run.proposalSha256, sourceProposalFiles: run.files.map(file => ({ ...file })) });

  const exactCapacity = (record: Awaited<ReturnType<typeof capacity.inspect>>, run: MountedSourceBuildExecution) => {
    if (!record || record.provider !== provider || record.workerOperationId !== run.workerOperationId || record.expectedSessionBindingDigest !== run.sessionBindingDigest || record.intentReference !== run.capacityIntentReference) throw new Error("PRODUCTION_SOURCE_BUILD_WORKER_BINDING_REQUIRED");
    const now = (input.now ?? Date.now)();
    if (record.deadlineEpochMs <= now || record.deadlineEpochMs > now + PRODUCTION_WORKER_POLICY.totalLifetimeMs) throw new Error("PRODUCTION_SOURCE_BUILD_WORKER_LIFETIME_REQUIRED");
    return record;
  };

  return Object.freeze({ authority: "production-real", async verify(raw: unknown): Promise<unknown> {
    const command = Request.parse(raw);
    if (command.candidateSha256 !== input.config.candidateSha256 || command.topologySha256 !== input.config.topologySha256) throw new Error("PRODUCTION_SOURCE_BUILD_SCOPE_REQUIRED");
    const nativeKind = command.kind === "edge.security.build" || command.kind === "edge.security.hostile"
      || command.kind === "edge.supply.primary" || command.kind === "edge.supply.secondary" || command.kind === "edge.supply.attestation";
    if (!nativeKind) throw new Error("PRODUCTION_EDGE_ORIGINAL_VERIFIER_REQUIRED");
    if (command.kind === "edge.security.build") {
      const payload = BuildPayload.parse(command.payload);
      if (payload.candidateId !== input.config.candidateSha256 || payload.image !== build.image) throw new Error("PRODUCTION_SOURCE_BUILD_PAYLOAD_REQUIRED");
    } else {
      const payload = EdgePayload.parse(command.payload);
      if (payload.candidateId !== input.config.candidateSha256) throw new Error("PRODUCTION_SOURCE_BUILD_PAYLOAD_REQUIRED");
    }
    const request = await validateAuthorizationRequest(input.authorization.request);
    const receipt = await validateAuthorizationReceipt({ request, receipt: input.authorization.receipt, nowMs: (input.now ?? Date.now)() });
    if (request.authorizationRequestSha256 !== input.authorization.authorizationRequestSha256 || receipt.authorizationReceiptSha256 !== input.authorization.authorizationReceiptSha256
      || request.candidateSha256 !== input.config.candidateSha256 || request.topologySha256 !== input.config.topologySha256 || receipt.candidateSha256 !== input.config.candidateSha256 || receipt.topologySha256 !== input.config.topologySha256
      || !request.providerScopes.some(scope => scope.provider === provider) || !request.orderedEffects.some(effect => effect.provider === provider && effect.operation === "verify_integration")) throw new Error("PRODUCTION_SOURCE_BUILD_AUTHORIZATION_REQUIRED");
    const run = bindMountedSourceBuildExecution(plan, { authorizationRequestSha256: request.authorizationRequestSha256 });
    const prior = await resumeMountedSourceBuildEvidence({ journal: input.dependencies.jobJournal, artifactStore: input.dependencies.artifactStore, candidateSha256: input.config.candidateSha256, run });
    if (prior) {
      const record = await capacity.inspect({ intentReference: run.capacityIntentReference });
      if (record) {
        if (record.workerOperationId !== run.workerOperationId || record.expectedSessionBindingDigest !== run.sessionBindingDigest || record.intentReference !== run.capacityIntentReference) throw new Error("PRODUCTION_SOURCE_BUILD_WORKER_BINDING_REQUIRED");
        await observeMountedSourceBuildCapacityCleanup({ journal: input.dependencies.jobJournal, capacity, run, record });
      }
      if (command.kind === "edge.security.build") return prior;
      const evidence = await readMountedSourceBuildEvidence({ journal: input.dependencies.jobJournal, artifactStore: input.dependencies.artifactStore, candidateSha256: input.config.candidateSha256, run });
      return selectNativeEdgeObservation(command.kind, evidence.result, evidence.evidence.receipts.edgeCertification);
    }

    let record = await capacity.inspect({ intentReference: run.capacityIntentReference });
    if (record) {
      record = exactCapacity(record, run);
      const observed = await capacity.observe({ intentReference: run.capacityIntentReference, expectedSessionBindingDigest: run.sessionBindingDigest, reference: record.reference });
      if (observed.status !== "available") throw new Error("PRODUCTION_SOURCE_BUILD_WORKER_UNAVAILABLE");
    } else {
      const reserved = await capacity.reserveNow({ intentReference: run.capacityIntentReference, expectedSessionBindingDigest: run.sessionBindingDigest });
      if (reserved.status !== "available") throw new Error("PRODUCTION_SOURCE_BUILD_WORKER_UNAVAILABLE");
      record = exactCapacity(await capacity.inspect({ intentReference: run.capacityIntentReference }), run);
    }
    const job = new ProductionWorkerJobClient({ provider, workerOperationId: record.workerOperationId, clients: input.dependencies.workers, workerJournal: input.dependencies.workerJournal, jobJournal: input.dependencies.jobJournal, toolchainSha256: input.config.worker.toolchainSha256, edgeCertification: { candidateSha256: input.config.candidateSha256, topologySha256: input.config.topologySha256 }, publication: plan.publication, now: input.now });
    const requestForWorker = workerRequest(run);
    const initial = await job.start(requestForWorker);
    if (initial.state === "unknown") throw new Error("PRODUCTION_SOURCE_BUILD_ORIGINAL_UNKNOWN");
    const timeout = abortAfter(10 * 60 * 1_000); let completed;
    try { completed = initial.state === "completed" ? initial : await job.wait(requestForWorker, timeout.signal); } finally { timeout.dispose(); }
    if (completed.state !== "completed") throw new Error(`PRODUCTION_SOURCE_BUILD_NONPASS:${completed.state}`);
    const materialized = await job.materializeArtifact(requestForWorker, { ownerId: input.config.candidateSha256, accountId: `certification:${input.config.candidateSha256}` });
    try {
      const { cleanup: _cleanup, ...facts } = materialized;
      const artifact = await new ProductionArtifactVerifier().verify(facts);
      const workspace = Workspace.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await job.exportWorkspace(requestForWorker, sha256(canonicalJson(run))))));
      if (canonicalJson(workspace.source.files) !== canonicalJson(plan.files) || canonicalJson(workspace.source.publication ?? null) !== canonicalJson(plan.publication ?? null)) throw new Error("PRODUCTION_SOURCE_BUILD_WORKSPACE_BINDING_REQUIRED");
      const capabilities = workspace.source.files.find(file => file.path === "src/capabilities.json");
      if (!capabilities) throw new Error("PRODUCTION_SOURCE_BUILD_CAPABILITIES_REQUIRED");
      const dryRun = DryRun.parse(JSON.parse(materialized.commandEvidence[7]!.stdout));
      const manifestSha256 = sha256(canonicalJson(dryRun.manifests[0]!)), capabilitiesSha256 = sha256(capabilities.content);
      const edgeCertification = NativeEdgeCertification.parse(artifact.edgeCertification);
      if (edgeCertification.candidateSha256 !== input.config.candidateSha256 || edgeCertification.topologySha256 !== input.config.topologySha256 || edgeCertification.provider.originalOperationId !== record.workerOperationId || edgeCertification.provider.image !== build.image || edgeCertification.provider.toolchainMeasurementSha256 !== edgeCertification.imageToolchain.sha256 || edgeCertification.provider.expiresAtEpochMs <= edgeCertification.provider.observedAtEpochMs) throw new Error("PRODUCTION_EDGE_NATIVE_BINDING_REQUIRED");
      const files = await Promise.all(artifact.files.map(async file => ({ path: file.path, sha256: file.sha256, size: file.bytes, bytesBase64: Buffer.from(await readVerifiedProductionArtifactFile(artifact.distRoot, file)).toString("base64") })));
      if (canonicalJson(workspace.artifact.files) !== canonicalJson(files)) throw new Error("PRODUCTION_SOURCE_BUILD_ARTIFACT_INVENTORY_REQUIRED");
      if (edgeCertification.supply.primary.aggregateSha256 !== sha256(canonicalJson(files)) || edgeCertification.supply.primary.installed.sha256 !== edgeCertification.supply.secondary.installed.sha256) throw new Error("PRODUCTION_EDGE_PRIMARY_ARTIFACT_BINDING_REQUIRED");
      const result = MountedSourceBuildResultSchema.parse({ candidateId: input.config.candidateSha256, sealedArtifactSha256: artifact.sealedObjectSha256, manifestSha256, capabilitiesSha256, aggregateSha256: artifact.aggregateSha256, jobId: completed.jobId, workerOperationId: record.workerOperationId, capacityReference: record.reference });
      const evidence = new TextEncoder().encode(canonicalJson({ version: 1, artifact: { sealedObjectSha256: artifact.sealedObjectSha256, aggregateSha256: artifact.aggregateSha256, files }, receipts: { manifest: dryRun.manifests[0]!, manifestSha256, capabilities: { content: capabilities.content, capabilitiesSha256 }, workerArtifactSha256: completed.artifactSha256, commandEvidenceSha256: artifact.verificationEvidenceSha256, edgeCertification }, operation: { operationId: run.operationId, planJobId: plan.jobId, authorizationRequestSha256: run.authorizationRequestSha256, topologySha256: input.config.topologySha256, ...result } }));
      const stored = StoredEvidence.parse({ key: `certification/source-build/${input.config.candidateSha256}/${run.jobId}/evidence.json`, checksum: sha256(evidence), result });
      const evidenceObject = await persistMountedSourceBuildEvidence({ journal: input.dependencies.jobJournal, artifactStore: input.dependencies.artifactStore, run, value: stored, bytes: evidence });
      await releaseMountedSourceBuildCapacity({ journal: input.dependencies.jobJournal, capacity, run, record });
      const passed = Object.freeze({ status: "passed" as const, ...result, artifactReceipt: Object.freeze({ evidenceObject }) });
      return command.kind === "edge.security.build" ? passed : selectNativeEdgeObservation(command.kind, result, edgeCertification);
    } finally { await materialized.cleanup(); }
  } });
}
