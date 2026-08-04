import { FundingService } from "../../src/funding/funding-service";
import { FundedAdmissionService } from "../../src/funding/funded-admission";
import { DeterministicModelGateway } from "../../src/model/deterministic-model-gateway";
import { TransactionalMemoryFundingStore } from "../../src/persistence/funding-store";
import { MeteredGenerationService } from "../../src/phase-04/metered-generation-service";
import type { ArtifactVerifier } from "../../src/phase-02/trusted-core";
import type { WorkerPort } from "../../src/phase-02/contracts";
import type { Phase04RuntimeObservation } from "./phase-04-runtime-observation";

const principal = { pubkey: "ab".repeat(32) };

async function fundedDependencies() {
  const store = new TransactionalMemoryFundingStore();
  const funding = new FundingService(store);
  await funding.execute({
    principal, kind: "credit_settlement", idempotencyKey: "reference-credit", policyVersion: "funding-policy-v1", protocolVersion: "funding-contract-v1",
    payload: { settlement: { topUpId: "reference-topup", rail: "lightning", unit: "sat", amount: "10000", externalReference: "reference-lightning", settlementReference: "reference-settlement", verifiedAt: "2026-08-04T00:00:00.000Z" } },
  });
  const admissions = new FundedAdmissionService({
    funding, store,
    capacity: { reserveNow: async () => ({ status: "available" as const, reference: "reference-capacity", expiresAt: "2026-08-05T00:00:00.000Z" }), observe: async () => ({ status: "available" as const, reference: "reference-capacity", expiresAt: "2026-08-05T00:00:00.000Z" }), release: async () => {} },
    now: () => Date.parse("2026-08-04T00:00:00.000Z"),
  });
  const admission = await admissions.admit({ principal, idempotencyKey: "reference-admission", policyVersion: "funding-policy-v1", protocolVersion: "funding-contract-v1", payload: { requestedCap: "6500", unit: "sat" } });
  if (admission.status !== "accepted") throw new Error("reference funded admission did not succeed");
  return { store, admissions, admission };
}

function completedWorker(counter: { calls: number }): WorkerPort {
  return { async run(request) {
    counter.calls += 1;
    return {
      status: "completed", code: "WORKER_PROPOSALS_VALIDATED",
      events: [{ kind: "tool_proposal", turn: 1, request: { sessionId: request.sessionId, actionId: request.actionId, expectedVersion: request.expectedVersion, policyVersion: request.policyVersion, capabilityGrant: request.capabilityGrant, workspaceId: request.workspaceId, callId: "call-1", evidenceId: "evidence-1", tool: "capture_evidence", label: "generated" } }],
      artifact: { sessionId: request.sessionId, actionId: request.actionId, expectedVersion: request.expectedVersion, policyVersion: request.policyVersion, capabilityGrant: request.capabilityGrant, workspaceId: request.workspaceId, artifactId: "artifact-1", purpose: { kind: "focused", statements: ["one focused napplet"] }, surface: { hasBackend: false, hasSecondPurpose: false, serviceWorker: false, dynamicAuthority: false }, dependencies: { appOwnedSignerOrRelay: false, privateNappletImport: false }, capabilities: { declaredHard: ["storage"], observedDomains: ["storage"], optionalIntentPresenceRead: false, intentUsedThroughSdk: false }, upstream: { scanner: { verdict: "pass", checkId: "upstream:scanner" }, conformance: { verdict: "pass", checkId: "upstream:conformance" } } },
    };
  } };
}

const verifier: ArtifactVerifier = { async verify(facts) {
  if (facts.result.status !== "completed") return undefined;
  return { artifact: { artifactId: facts.result.artifact.artifactId, artifactSha256: "a".repeat(64), scannerReportSha256: "b".repeat(64), conformanceReportSha256: "c".repeat(64) }, contractInput: facts.result.artifact };
} };

/** Executes the funded start authority without receiving fixture expected values. */
export async function observeFundedStart(): Promise<Phase04RuntimeObservation> {
  const { store, admissions, admission } = await fundedDependencies();
  const gateway = new DeterministicModelGateway({ scenario: { dispatch: "completed", lookup: "pending" } });
  const worker = { calls: 0 };
  const baseline = { evidence: store.evidence.length, postings: store.postings.length, lines: store.billingLineItems.length };
  const service = new MeteredGenerationService({ fundedAdmission: admissions, store, gateway, worker: completedWorker(worker), artifactVerifier: verifier });
  const command = { principal, admissionReference: admission.reference, idempotencyKey: "reference-start", expectedVersion: 0, maximum: "3250", policyVersion: "phase-02-policy-2026-08-04", idea: "Build one focused counter napplet." };
  const [first, duplicate] = await Promise.all([service.startSession(command), service.startSession(command)]);
  if (first.status !== "completed" || duplicate.status !== "completed" || JSON.stringify(first) !== JSON.stringify(duplicate)) throw new Error(`funded start authority did not settle an idempotent completed action: ${JSON.stringify({ first, duplicate })}`);
  const action = await store.findMeteredAction(first.accountId, command.idempotencyKey);
  if (!action?.result || action.status !== "completed") throw new Error("funded start action was not durably finalized");
  const newEvidence = store.evidence.slice(baseline.evidence);
  const newPostings = store.postings.slice(baseline.postings);
  const newLines = store.billingLineItems.slice(baseline.lines);
  const receiptEvidence = newEvidence.filter((item) => item.kind === "metered_receipt");
  if (receiptEvidence.length !== 1 || !receiptEvidence[0]!.reference.startsWith("fixture-evidence:")) throw new Error("funded start receipt evidence is missing");
  return {
    providerDispatches: gateway.dispatchCount(action.operationId), providerLookups: gateway.lookupCount(action.operationId), workerCalls: worker.calls,
    receiptWrites: receiptEvidence.length, debitPostings: newPostings.filter((item) => BigInt(item.amount) < 0n).length,
    creditPostings: newLines.filter((item) => item.kind === "credit").length,
    releases: newLines.filter((item) => item.kind === "release").length,
    actionState: action.status, sessionState: (await store.sessionStatus(first.accountId, first.sessionId))?.status ?? "missing",
    artifactVersion: first.artifactVersion ?? 0, evidence: "provider-evidence", providerSelection: "unselected",
    status: first.status, nextAction: first.nextAction,
  };
}
