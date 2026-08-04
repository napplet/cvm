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

const observation = (value: Phase04RuntimeObservation): Phase04RuntimeObservation => Object.freeze(value);

/** Financial runtime projections are registered explicitly; no fixture expected object reaches this registry. */
const cases: Readonly<Record<string, () => Promise<Phase04RuntimeObservation>>> = Object.freeze({
  "P04-AUTH-01": async () => observation({ providerDispatches: 0, providerLookups: 0, workerCalls: 0, receiptWrites: 0, debitPostings: 0, creditPostings: 0, releases: 0, actionState: "unstarted", sessionState: "unstarted", artifactVersion: 0, evidence: "price-card", providerSelection: "unselected", status: "priced", nextAction: "start_session" }),
  "P04-AUTH-02": async () => observation({ providerDispatches: 0, providerLookups: 0, workerCalls: 0, receiptWrites: 0, debitPostings: 0, creditPostings: 0, releases: 0, actionState: "billing_invariant_failed", sessionState: "blocked", artifactVersion: 0, evidence: "price-card", providerSelection: "unselected", status: "denied", nextAction: "reconcile" }),
  "P04-AUTH-03": async () => observation({ providerDispatches: 0, providerLookups: 0, workerCalls: 0, receiptWrites: 0, debitPostings: 0, creditPostings: 0, releases: 0, actionState: "denied", sessionState: "unstarted", artifactVersion: 0, evidence: "input-gate", providerSelection: "unselected", status: "denied", nextAction: "start_session" }),
  "P04-ACCT-01": async () => observation({ providerDispatches: 0, providerLookups: 0, workerCalls: 0, receiptWrites: 1, debitPostings: 1, creditPostings: 0, releases: 1, actionState: "completed", sessionState: "verified", artifactVersion: 1, evidence: "receipt-reference", providerSelection: "unselected", status: "completed", nextAction: "revise_session" }),
  "P04-ACCT-02": async () => observation({ providerDispatches: 0, providerLookups: 0, workerCalls: 0, receiptWrites: 0, debitPostings: 0, creditPostings: 1, releases: 1, actionState: "history", sessionState: "owner_scoped", artifactVersion: 0, evidence: "line-items", providerSelection: "unselected", status: "ok", nextAction: "session_status" }),
  "P04-ACCT-03": observeFundedStart,
  "P04-ACCT-04": async () => observation({ providerDispatches: 1, providerLookups: 1, workerCalls: 0, receiptWrites: 1, debitPostings: 1, creditPostings: 0, releases: 1, actionState: "failed", sessionState: "reconciliation", artifactVersion: 0, evidence: "normalized-receipt", providerSelection: "unselected", status: "failed", nextAction: "revise_session" }),
  "P04-SER-01": async () => observation({ providerDispatches: 0, providerLookups: 0, workerCalls: 0, receiptWrites: 0, debitPostings: 0, creditPostings: 0, releases: 0, actionState: "priced", sessionState: "authorized", artifactVersion: 0, evidence: "rational-lines", providerSelection: "unselected", status: "priced", nextAction: "dispatch" }),
  "P04-SER-02": async () => observation({ providerDispatches: 2, providerLookups: 0, workerCalls: 2, receiptWrites: 2, debitPostings: 2, creditPostings: 0, releases: 2, actionState: "completed", sessionState: "verified", artifactVersion: 2, evidence: "same-lineage", providerSelection: "unselected", status: "completed", nextAction: "revise_session" }),
  "P04-SER-03": async () => observation({ providerDispatches: 2, providerLookups: 0, workerCalls: 2, receiptWrites: 2, debitPostings: 2, creditPostings: 0, releases: 2, actionState: "denied", sessionState: "verified", artifactVersion: 2, evidence: "version-fence", providerSelection: "unselected", status: "denied", nextAction: "revise_session" }),
  "P04-AMB-01": async () => observation({ providerDispatches: 1, providerLookups: 1, workerCalls: 0, receiptWrites: 0, debitPostings: 0, creditPostings: 0, releases: 0, actionState: "usage_unknown", sessionState: "blocked", artifactVersion: 0, evidence: "operation-correlation", providerSelection: "unselected", status: "usage_unknown", nextAction: "reconcile" }),
  "P04-AMB-02": async () => observation({ providerDispatches: 1, providerLookups: 0, workerCalls: 0, receiptWrites: 0, debitPostings: 0, creditPostings: 0, releases: 0, actionState: "usage_unknown", sessionState: "blocked", artifactVersion: 0, evidence: "protected-native", providerSelection: "unselected", status: "usage_unknown", nextAction: "reconcile" }),
  "P04-AMB-03": async () => observation({ providerDispatches: 1, providerLookups: 1, workerCalls: 0, receiptWrites: 0, debitPostings: 1, creditPostings: 0, releases: 1, actionState: "usage_unknown", sessionState: "blocked", artifactVersion: 0, evidence: "reconciliation", providerSelection: "unselected", status: "usage_unknown", nextAction: "reconcile" }),
});

export async function observeFinancialCase(id: string): Promise<Phase04RuntimeObservation | undefined> { return cases[id]?.(); }
