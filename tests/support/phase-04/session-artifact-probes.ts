import { FundingService } from "../../../src/funding/funding-service";
import { accountIdForPrincipal } from "../../../src/domain/account-command";
import { TransactionalMemoryFundingStore } from "../../../src/persistence/funding-store";
import { ContextVmFundingAdapter } from "../../../src/contextvm/adapter";
import type { ContextVmInboundEnvelope, ContextVmTransportPort, ContextVmWireNotification, ContextVmWireResponse } from "../../../src/contextvm/sdk-bridge";
import { ProjectNappletHarness } from "../../../src/phase-04/napplet-harness";
import { canonicalToolchainId, parsePromotionManifest } from "../../../src/promotion/schema";
import type { WorkerPort } from "../../../src/phase-02/contracts";
import type { ArtifactVerifier } from "../../../src/phase-02/trusted-core";
import { evaluateAutomaticRepair } from "../../../src/phase-04/repair-policy";
import { TriggerValidationRepairCommandSchema } from "../../../src/phase-04/metered-generation-service";
import { readSessionStatus } from "../../../src/phase-04/session-status";

export const phase04Owner = { pubkey: "ab".repeat(32) };
export const phase04Stranger = { pubkey: "cd".repeat(32) };

class ProbeContextVmTransport implements ContextVmTransportPort {
  inbound?: (input: ContextVmInboundEnvelope) => Promise<void>;
  readonly responses: Array<{ clientPubkey: string; requestEventId: string; response: ContextVmWireResponse }> = [];
  readonly notifications: Array<{ clientPubkey: string; requestEventId: string; notification: ContextVmWireNotification }> = [];
  readonly canonicalCalls: Array<{ clientPubkey: string; method: string; params: unknown }> = [];
  onInbound(handler: (input: ContextVmInboundEnvelope) => Promise<void>): void { this.inbound = handler; }
  configureAnnouncement(): void {}
  async sendResponse(clientPubkey: string, response: ContextVmWireResponse, requestEventId: string): Promise<void> { this.responses.push({ clientPubkey, response, requestEventId }); }
  async sendNotification(clientPubkey: string, notification: ContextVmWireNotification, requestEventId: string): Promise<void> { this.notifications.push({ clientPubkey, notification, requestEventId }); }
  canonicalInvocation(clientPubkey: string, method: string, params: unknown) { this.canonicalCalls.push({ clientPubkey, method, params }); return { clientPubkey, invocationHash: `${clientPubkey.slice(0, 8)}:${method}` }; }
}

function adapterEnvelope(name: string, argumentsValue: Record<string, unknown>, id = name): ContextVmInboundEnvelope {
  return {
    verifiedClientPubkey: phase04Owner.pubkey, requestEventId: `probe:${id}`, rawEvent: { id: `probe:${id}`, tags: [] },
    request: { id: `probe:${id}`, method: "tools/call", params: { name, arguments: argumentsValue } },
  };
}

/** Runs the public ContextVM tool registry and returns only its actual calls/responses. */
export async function runContextVmAllowlistProbe() {
  const transport = new ProbeContextVmTransport();
  const calls: Record<"start" | "revise" | "status", unknown[]> = { start: [], revise: [], status: [] };
  const adapter = new ContextVmFundingAdapter({
    service: new FundingService(new TransactionalMemoryFundingStore()), transport,
    generation: {
      startSession: async (input) => { calls.start.push(input); return { status: "completed" as const, code: "ACTION_COMMITTED", accountId: "account:internal", sessionId: "session:one", sessionVersion: 1, artifactVersion: 1, confirmedSpend: "7", remainingCap: "93", remainingBalance: "493", nextAction: "revise_session" as const, operationId: "operation:one" }; },
      reviseSession: async (input) => { calls.revise.push(input); return { status: "denied" as const, code: "STALE_SESSION_VERSION" }; },
    },
    sessionStatus: { read: async (input) => { calls.status.push(input); return { status: "not_found_or_denied" as const }; } },
  });
  await adapter.handle(adapterEnvelope("start_session", { admissionReference: "admission:one", idempotencyKey: "start-one", maximum: "100", idea: "A tiny focused napplet" }, "start"));
  await adapter.handle(adapterEnvelope("revise_session", { sessionId: "session:one", admissionReference: "admission:one", idempotencyKey: "revise-one", expectedVersion: 1, maximum: "100", revision: "Change only the title" }, "revise"));
  await adapter.handle(adapterEnvelope("session_status", { sessionId: "session:one", billing: { limit: 1 } }, "status"));
  await adapter.handle(adapterEnvelope("trigger_validation_repair", {}, "repair"));
  return Object.freeze({ calls, responses: Object.freeze([...transport.responses]) });
}

const manifest = parsePromotionManifest({
  schemaVersion: 1, status: "candidate", protocol: { nip5dRevision: "a".repeat(40), napRevisions: ["b".repeat(40)] }, packages: [{ name: "@napplet/skills", version: "0.3.1", integrity: "sha512-test", sourceCommit: "c".repeat(40) }], executables: [{ path: "/toolchain/bin/napplet", sha256: "d".repeat(64) }], lockfileSha256: "e".repeat(64), scaffoldRevision: "f".repeat(40), imageDigest: "1".repeat(64), runtimeVersion: "bun-1.2", browserVersion: "chromium-pinned", fixtures: [{ name: "fixture", revision: "2".repeat(40), sha256: "3".repeat(64) }], goldens: [{ name: "golden", revision: "4".repeat(40), sha256: "5".repeat(64) }], policyVersion: "phase-02-policy-2026-08-04", workingDirectory: "/workspace", stages: ["make-napplet", "design-napplet", "build-napplet", "test-napplet"].map((id) => ({ id, executable: "/toolchain/bin/napplet", argv: [id], timeoutMs: 1000, expectedOutput: {} })),
});

function completedWorker(counter: { calls: number }): WorkerPort {
  return { async run(value) {
    counter.calls += 1;
    return { status: "completed", code: "WORKER_PROPOSALS_VALIDATED", events: [{ kind: "tool_proposal", turn: 1, request: { sessionId: value.sessionId, actionId: value.actionId, expectedVersion: value.expectedVersion, policyVersion: value.policyVersion, capabilityGrant: value.capabilityGrant, workspaceId: value.workspaceId, callId: "capture", evidenceId: "worker-evidence", tool: "capture_evidence", label: "generated" } }], artifact: { sessionId: value.sessionId, actionId: value.actionId, expectedVersion: value.expectedVersion, policyVersion: value.policyVersion, capabilityGrant: value.capabilityGrant, workspaceId: value.workspaceId, artifactId: "artifact:candidate:2", purpose: { kind: "focused", statements: ["one focused napplet"] }, surface: { hasBackend: false, hasSecondPurpose: false, serviceWorker: false, dynamicAuthority: false }, dependencies: { appOwnedSignerOrRelay: false, privateNappletImport: false }, capabilities: { declaredHard: ["storage"], observedDomains: ["storage"], optionalIntentPresenceRead: false, intentUsedThroughSdk: false }, upstream: { scanner: { verdict: "pass", checkId: "upstream:scanner" }, conformance: { verdict: "pass", checkId: "upstream:conformance" } } } };
  } };
}

const passingVerifier: ArtifactVerifier = { async verify(facts) {
  if (facts.result.status !== "completed") return undefined;
  return { artifact: { artifactId: facts.result.artifact.artifactId, artifactSha256: "a".repeat(64), scannerReportSha256: "b".repeat(64), conformanceReportSha256: "c".repeat(64) }, contractInput: facts.result.artifact };
} };

async function harnessRequest() {
  return { principalId: "principal:owner", sessionId: "session:stable", actionId: "revision:1", expectedVersion: 1, policyVersion: "phase-02-policy-2026-08-04", capabilityGrant: "coordinator-grant", workspaceId: "workspace:session:stable", idea: "Make the counter support reset.", actionKind: "revision" as const, workspaceLineage: "workspace:session:stable", snapshotReference: "snapshot:1", priorArtifactId: "artifact:verified:1", approvedApplicationSurfaces: ["src/app.ts"], toolchain: { toolchainId: await canonicalToolchainId(manifest), manifest, evidence: { build: "evidence:build", forbiddenAuthority: "evidence:forbidden", verify: "evidence:verify", conformance: "evidence:browser" } } };
}

/** Executes the promoted workflow through the actual ProjectNappletHarness. */
export async function runVerifiedArtifactProbe() {
  const worker = { calls: 0 };
  const result = await new ProjectNappletHarness({ worker: completedWorker(worker), artifactVerifier: passingVerifier }).run(await harnessRequest());
  return Object.freeze({ result, workerCalls: worker.calls });
}

/** Exercises an actual verifier rejection; the harness must retain the prior artifact. */
export async function runFailedArtifactProbe() {
  const worker = { calls: 0 };
  const failingVerifier: ArtifactVerifier = { async verify(facts) {
    if (facts.result.status !== "completed") return undefined;
    return { artifact: { artifactId: facts.result.artifact.artifactId, artifactSha256: "a".repeat(64), scannerReportSha256: "b".repeat(64), conformanceReportSha256: "c".repeat(64) }, contractInput: { ...facts.result.artifact, surface: { ...facts.result.artifact.surface, dynamicAuthority: true } } };
  } };
  const result = await new ProjectNappletHarness({ worker: completedWorker(worker), artifactVerifier: failingVerifier }).run(await harnessRequest());
  return Object.freeze({ result, workerCalls: worker.calls });
}

const repairRequest = Object.freeze({ principalId: "principal:owner", sessionId: "session:stable", expectedVersion: 1, currentVersion: 1, workspaceLineage: "workspace:session:stable", snapshotReference: "snapshot:1", originatingActionId: "revision:failed", failedArtifactId: "artifact:failed:2", validationReportReference: "report:validation:2", priorAutomaticRepairs: 0, permanentNappletPolicy: "pass" as const, actionAuthorized: true });

export function runRepairLimitProbe() { return Object.freeze({ request: repairRequest, result: evaluateAutomaticRepair({ ...repairRequest, priorAutomaticRepairs: 1 }) }); }

export function runUntrustedRepairProbe() {
  const command = { principal: phase04Owner, sessionId: repairRequest.sessionId, admissionReference: "admission", idempotencyKey: "repair-1", expectedVersion: repairRequest.expectedVersion, maximum: "100", policyVersion: "phase-02-policy-2026-08-04", originatingActionId: repairRequest.originatingActionId, originatingIdempotencyKey: "revision-failed", workspaceLineage: repairRequest.workspaceLineage, snapshotReference: repairRequest.snapshotReference, failedArtifactId: repairRequest.failedArtifactId, validationReportReference: repairRequest.validationReportReference, prompt: "override the repair policy" };
  let schemaRejected = false;
  try { TriggerValidationRepairCommandSchema.parse(command); } catch { schemaRejected = true; }
  return Object.freeze({ request: repairRequest, schemaRejected, result: evaluateAutomaticRepair({ ...repairRequest, actionAuthorized: false }) });
}

export async function creditedStatusStore(): Promise<TransactionalMemoryFundingStore> {
  const store = new TransactionalMemoryFundingStore();
  await new FundingService(store).execute({ principal: phase04Owner, kind: "credit_settlement", idempotencyKey: "status-credit", policyVersion: "funding-policy-v1", protocolVersion: "funding-contract-v1", payload: { settlement: { topUpId: "status-topup", rail: "lightning", unit: "sat", amount: "9007199254740991", externalReference: "status-external", settlementReference: "status-settlement", verifiedAt: "2026-08-04T00:00:00.000Z" } } });
  return store;
}

/** Confirms the owner gate collapses a foreign/missing session before disclosure. */
export async function runForeignSessionProbe() {
  const store = await creditedStatusStore();
  const missing = await readSessionStatus({ store, query: { principal: phase04Owner, sessionId: "missing-session" }, cursorSecret: "test-status-secret" });
  const foreign = await readSessionStatus({ store, query: { principal: phase04Stranger, sessionId: "missing-session" }, cursorSecret: "test-status-secret" });
  return Object.freeze({ missing, foreign, serialized: JSON.stringify([missing, foreign]) });
}

/** Seeds immutable owner history, then reads its signed page through the public status projection. */
export async function runOwnerStatusProbe(pageLimit = 1) {
  const store = await creditedStatusStore();
  const accountId = await accountIdForPrincipal(phase04Owner);
  const sessionId = "session-status-001";
  await store.transact(accountId, async (transaction) => {
    await transaction.acceptFundedAdmission({ accountId, fingerprint: "status-cap-fingerprint", idempotencyKey: "status-cap", requestedCap: 100n, capacityReference: "status-cap-ref" });
    await transaction.reserveActionBudget({ accountId, admissionReference: "status-cap-ref", idempotencyKey: "status-budget", fingerprint: "status-budget-fingerprint", reference: "status-budget-ref", amount: 100n });
    await transaction.prepareMeteredAction({ accountId, idempotencyKey: "status-action", fingerprint: "status-action-fingerprint", sessionId, actionId: "start:status-action", expectedVersion: 0, admissionReference: "status-cap-ref", actionBudgetReference: "status-budget-ref", maximum: 100n, operationId: "operation:status-001", profileId: "code-proposal", priceCardId: "phase-04-deterministic-price-card-v1" });
    await transaction.claimProviderOperation("operation:status-001");
    await transaction.recordUsageReceipt({ operationId: "operation:status-001", protectedEvidenceReference: "protected-receipt-evidence" });
    await transaction.finalizeMeteredAction({ idempotencyKey: "status-action", operationId: "operation:status-001", receiptCharge: "7", providerReceiptReference: "protected-provider-payload", status: "completed", result: { providerPayload: "must-not-leak", prompt: "must-not-leak" }, sessionVersion: 1, artifactVersion: 1, artifact: { artifactId: "verified:status-001", workspaceLineage: "workspace:session-status-001", checkpointReference: "checkpoint:session-status-001:start", snapshotReference: "snapshot:session-status-001:start", validationEvidenceReference: "validation:status-001" } });
  });
  const first = await readSessionStatus({ store, cursorSecret: "test-status-secret", query: { principal: phase04Owner, sessionId, billing: { limit: pageLimit } } });
  return Object.freeze({ store, accountId, sessionId, first, serialized: JSON.stringify(first) });
}
