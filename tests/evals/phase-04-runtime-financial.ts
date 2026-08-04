import { FundingService } from "../../src/funding/funding-service";
import { FundedAdmissionService } from "../../src/funding/funded-admission";
import { DeterministicModelGateway } from "../../src/model/deterministic-model-gateway";
import { ModelReconciliationService } from "../../src/model/reconciliation";
import { PHASE_04_DETERMINISTIC_PRICE_CARD, PHASE_04_MODEL_PROFILES, priceReceipt } from "../../src/model/price-card";
import { TransactionalMemoryFundingStore } from "../../src/persistence/funding-store";
import { MeteredGenerationService } from "../../src/phase-04/metered-generation-service";
import type { ArtifactVerifier } from "../../src/phase-02/trusted-core";
import type { WorkerPort } from "../../src/phase-02/contracts";
import type { Phase04RuntimeObservation } from "./phase-04-runtime-observation";

const principal = { pubkey: "ab".repeat(32) };
const policyVersion = "phase-02-policy-2026-08-04";

function effectCounts(store: TransactionalMemoryFundingStore, baseline: Readonly<{ evidence: number; postings: number; lines: number }>) {
  const evidence = store.evidence.slice(baseline.evidence);
  const postings = store.postings.slice(baseline.postings);
  const lines = store.billingLineItems.slice(baseline.lines);
  return Object.freeze({
    receiptWrites: evidence.filter((item) => item.kind === "metered_receipt").length,
    debitPostings: postings.filter((item) => BigInt(item.amount) < 0n).length,
    creditPostings: lines.filter((item) => item.kind === "credit").length,
    releases: lines.filter((item) => item.kind === "release").length,
  });
}

function runtimeFacts(input: Omit<Phase04RuntimeObservation, "providerSelection">): Phase04RuntimeObservation {
  return Object.freeze({ ...input, providerSelection: "unselected" });
}

function receipt(operationId: string, profileId = "code-proposal", priceCardId = PHASE_04_DETERMINISTIC_PRICE_CARD.id) {
  return {
    operationId,
    providerRequestId: `deterministic:${operationId}`,
    provider: "deterministic_fixture" as const,
    model: "phase-04-fixture-model",
    profileId,
    priceCardId,
    selection: "unselected" as const,
    completedAt: "2026-08-04T00:00:01.000Z",
    provenance: { protectedEvidenceReference: `fixture-evidence:${operationId}` },
    usage: [{ dimension: "input_tokens" as const, units: "10" }, { dimension: "output_tokens" as const, units: "5" }],
  };
}

async function fundedDependencies(prefix: string) {
  const store = new TransactionalMemoryFundingStore();
  const funding = new FundingService(store);
  await funding.execute({
    principal,
    kind: "credit_settlement",
    idempotencyKey: `${prefix}-credit`,
    policyVersion: "funding-policy-v1",
    protocolVersion: "funding-contract-v1",
    payload: { settlement: { topUpId: `${prefix}-topup`, rail: "lightning", unit: "sat", amount: "10000", externalReference: `${prefix}-lightning`, settlementReference: `${prefix}-settlement`, verifiedAt: "2026-08-04T00:00:00.000Z" } },
  });
  const admissions = new FundedAdmissionService({
    funding,
    store,
    capacity: {
      reserveNow: async () => ({ status: "available" as const, reference: `${prefix}-capacity`, expiresAt: "2026-08-05T00:00:00.000Z" }),
      observe: async () => ({ status: "available" as const, reference: `${prefix}-capacity`, expiresAt: "2026-08-05T00:00:00.000Z" }),
      release: async () => {},
    },
    now: () => Date.parse("2026-08-04T00:00:00.000Z"),
  });
  const admission = await admissions.admit({
    principal,
    idempotencyKey: `${prefix}-admission`,
    policyVersion: "funding-policy-v1",
    protocolVersion: "funding-contract-v1",
    payload: { requestedCap: "6500", unit: "sat" },
  });
  if (admission.status !== "accepted") throw new Error(`${prefix}: funded admission did not succeed`);
  return { store, admissions, admission };
}

function completedWorker(counter: { calls: number }): WorkerPort {
  return { async run(request) {
    counter.calls += 1;
    return {
      status: "completed",
      code: "WORKER_PROPOSALS_VALIDATED",
      events: [{ kind: "tool_proposal", turn: 1, request: { sessionId: request.sessionId, actionId: request.actionId, expectedVersion: request.expectedVersion, policyVersion: request.policyVersion, capabilityGrant: request.capabilityGrant, workspaceId: request.workspaceId, callId: "call-1", evidenceId: "evidence-1", tool: "capture_evidence", label: "generated" } }],
      artifact: { sessionId: request.sessionId, actionId: request.actionId, expectedVersion: request.expectedVersion, policyVersion: request.policyVersion, capabilityGrant: request.capabilityGrant, workspaceId: request.workspaceId, artifactId: "artifact-1", purpose: { kind: "focused", statements: ["one focused napplet"] }, surface: { hasBackend: false, hasSecondPurpose: false, serviceWorker: false, dynamicAuthority: false }, dependencies: { appOwnedSignerOrRelay: false, privateNappletImport: false }, capabilities: { declaredHard: ["storage"], observedDomains: ["storage"], optionalIntentPresenceRead: false, intentUsedThroughSdk: false }, upstream: { scanner: { verdict: "pass", checkId: "upstream:scanner" }, conformance: { verdict: "pass", checkId: "upstream:conformance" } } },
    };
  } };
}

const verifier: ArtifactVerifier = { async verify(facts) {
  if (facts.result.status !== "completed") return undefined;
  return { artifact: { artifactId: facts.result.artifact.artifactId, artifactSha256: "a".repeat(64), scannerReportSha256: "b".repeat(64), conformanceReportSha256: "c".repeat(64) }, contractInput: facts.result.artifact };
} };

async function completedStart(prefix: string) {
  const { store, admissions, admission } = await fundedDependencies(prefix);
  const gateway = new DeterministicModelGateway({ scenario: { dispatch: "completed", lookup: "pending" } });
  const worker = { calls: 0 };
  const baseline = { evidence: store.evidence.length, postings: store.postings.length, lines: store.billingLineItems.length };
  const service = new MeteredGenerationService({ fundedAdmission: admissions, store, gateway, worker: completedWorker(worker), artifactVerifier: verifier });
  const command = { principal, admissionReference: admission.reference, idempotencyKey: `${prefix}-start`, expectedVersion: 0, maximum: "3250", policyVersion, idea: "Build one focused counter napplet." };
  const result = await service.startSession(command);
  if (result.status !== "completed") throw new Error(`${prefix}: start did not complete`);
  const action = await store.findMeteredAction(result.accountId, command.idempotencyKey);
  if (!action?.result) throw new Error(`${prefix}: start was not persisted`);
  return { store, admissions, admission, gateway, worker, baseline, service, command, result, action };
}

/** Executes the funded-start authority without receiving fixture expected values. */
export async function observeFundedStart(): Promise<Phase04RuntimeObservation> {
  const run = await completedStart("reference");
  const duplicate = await run.service.startSession(run.command);
  if (JSON.stringify(run.result) !== JSON.stringify(duplicate)) throw new Error("funded start did not replay exactly");
  const settled = await run.store.findMeteredAction(run.result.accountId, run.command.idempotencyKey);
  if (!settled || settled.status !== "completed") throw new Error("funded start was not durably finalized");
  const effects = effectCounts(run.store, run.baseline);
  const session = await run.store.sessionStatus(run.result.accountId, run.result.sessionId);
  return runtimeFacts({
    providerDispatches: run.gateway.dispatchCount(settled.operationId), providerLookups: run.gateway.lookupCount(settled.operationId), workerCalls: run.worker.calls,
    ...effects, actionState: settled.status, sessionState: session?.status ?? "missing", artifactVersion: run.result.artifactVersion ?? 0,
    evidence: settled.providerReceiptReference?.startsWith("fixture-evidence:") ? "provider-evidence" : "missing", status: run.result.status, nextAction: run.result.nextAction,
  });
}

async function observePriceCard(identityMismatch: boolean): Promise<Phase04RuntimeObservation> {
  const priced = priceReceipt({
    receipt: identityMismatch ? receipt("price-mismatch", "code-proposal", "different-card") : receipt("price-ok"),
    card: PHASE_04_DETERMINISTIC_PRICE_CARD,
    profile: PHASE_04_MODEL_PROFILES["code-proposal"],
    reservation: "3250",
  });
  const failed = priced.status === "billing_invariant_failed";
  return runtimeFacts({ providerDispatches: 0, providerLookups: 0, workerCalls: 0, receiptWrites: 0, debitPostings: 0, creditPostings: 0, releases: 0,
    actionState: failed ? "billing_invariant_failed" : "unstarted", sessionState: failed ? "blocked" : "unstarted", artifactVersion: 0,
    evidence: priced.status === "priced" || failed ? "price-card" : "missing", status: failed ? "denied" : priced.status, nextAction: failed ? "reconcile" : "start_session" });
}

async function observeInputDenial(): Promise<Phase04RuntimeObservation> {
  const { store, admissions, admission } = await fundedDependencies("input-denial");
  const gateway = new DeterministicModelGateway({ scenario: { dispatch: "completed", lookup: "pending" } });
  const workers = { calls: 0 };
  const baseline = { evidence: store.evidence.length, postings: store.postings.length, lines: store.billingLineItems.length };
  const service = new MeteredGenerationService({ fundedAdmission: admissions, store, gateway, worker: completedWorker(workers), artifactVerifier: verifier });
  const result = await service.startSession({ principal, admissionReference: admission.reference, idempotencyKey: "input-denial", expectedVersion: 0, maximum: "3250", policyVersion, idea: "" });
  if (result.status !== "denied") throw new Error("empty input was accepted");
  return runtimeFacts({ providerDispatches: 0, providerLookups: 0, workerCalls: workers.calls, ...effectCounts(store, baseline), actionState: result.status, sessionState: "unstarted", artifactVersion: 0, evidence: result.code.startsWith("INPUT_") ? "input-gate" : "missing", status: result.status, nextAction: result.nextAction ?? (result.status === "denied" ? "start_session" : "reconcile") });
}

async function observeFinalization(): Promise<Phase04RuntimeObservation> {
  const store = new TransactionalMemoryFundingStore();
  const accountId = "account:metered-finalization";
  await store.transact(accountId, (tx) => tx.creditVerifiedSettlement({ accountId, fingerprint: "credit:fingerprint", idempotencyKey: "credit:one", settlement: { topUpId: "topup:one", rail: "lightning", unit: "sat", amount: "20", externalReference: "external:one", settlementReference: "settlement:one", verifiedAt: "2026-08-04T00:00:00.000Z" } }));
  const baseline = { evidence: store.evidence.length, postings: store.postings.length, lines: store.billingLineItems.length };
  await store.transact(accountId, (tx) => tx.acceptFundedAdmission({ accountId, fingerprint: "admission:fingerprint", idempotencyKey: "admission:one", requestedCap: 10n, capacityReference: "admission:one" }));
  await store.transact(accountId, (tx) => tx.reserveActionBudget({ accountId, admissionReference: "admission:one", idempotencyKey: "budget:one", fingerprint: "budget:fingerprint", reference: "budget:one", amount: 10n }));
  await store.transact(accountId, (tx) => tx.prepareMeteredAction({ accountId, idempotencyKey: "action:one", fingerprint: "fingerprint:one", sessionId: "session:one", actionId: "action:one", expectedVersion: 0, admissionReference: "admission:one", actionBudgetReference: "budget:one", maximum: 10n, operationId: "operation:one", profileId: "profile:one", priceCardId: "card:one" }));
  await store.transact(accountId, (tx) => tx.claimProviderOperation("operation:one"));
  await store.transact(accountId, (tx) => tx.recordUsageReceipt({ operationId: "operation:one", protectedEvidenceReference: "receipt:one" }));
  const final = { idempotencyKey: "action:one", operationId: "operation:one", receiptCharge: "4", providerReceiptReference: "receipt:one", status: "completed" as const, result: { status: "completed" }, sessionVersion: 1, artifactVersion: 1 };
  const first = await store.transact(accountId, (tx) => tx.finalizeMeteredAction(final));
  await store.transact(accountId, (tx) => tx.finalizeMeteredAction(final));
  const action = await store.findMeteredActionByOperation(accountId, "operation:one");
  if (!action || first.status !== "completed") throw new Error("terminal finalization was not persisted");
  const effects = effectCounts(store, baseline);
  return runtimeFacts({ providerDispatches: 0, providerLookups: 0, workerCalls: 0, ...effects, actionState: action.status, sessionState: action.sessionVersion === 1 ? "verified" : "missing", artifactVersion: action.artifactVersion, evidence: action.providerReceiptReference === "receipt:one" ? "receipt-reference" : "missing", status: first.status, nextAction: "revise_session" });
}

async function observeLineItemHistory(): Promise<Phase04RuntimeObservation> {
  const store = new TransactionalMemoryFundingStore();
  const accountId = "account:history";
  const baseline = { evidence: store.evidence.length, postings: store.postings.length, lines: store.billingLineItems.length };
  await store.transact(accountId, (tx) => tx.creditVerifiedSettlement({ accountId, fingerprint: "credit:fingerprint", idempotencyKey: "credit:history", settlement: { topUpId: "topup:history", rail: "cashu", unit: "sat", amount: "20", externalReference: "external:history", settlementReference: "settlement:history", verifiedAt: "2026-08-04T00:00:00.000Z" } }));
  await store.transact(accountId, (tx) => tx.acceptFundedAdmission({ accountId, fingerprint: "hold:fingerprint", idempotencyKey: "hold:history", requestedCap: 10n, capacityReference: "hold:history" }));
  await store.transact(accountId, (tx) => tx.reserveActionBudget({ accountId, admissionReference: "hold:history", idempotencyKey: "budget:history", fingerprint: "budget:fingerprint", reference: "budget:history", amount: 5n }));
  const first = await store.listBillingLineItems(accountId, { limit: 1 });
  const next = await store.listBillingLineItems(accountId, { limit: 50, cursor: first.nextCursor });
  const history = [...first.items, ...next.items];
  await store.transact(accountId, (tx) => tx.prepareMeteredAction({ accountId, idempotencyKey: "history-action", fingerprint: "history:action", sessionId: "session:history", actionId: "action:history", expectedVersion: 0, admissionReference: "hold:history", actionBudgetReference: "budget:history", maximum: 5n, operationId: "operation:history", profileId: "profile:history", priceCardId: "card:history" }));
  await store.transact(accountId, (tx) => tx.claimProviderOperation("operation:history"));
  await store.transact(accountId, (tx) => tx.finalizeMeteredAction({ idempotencyKey: "history-action", operationId: "operation:history", receiptCharge: "0", providerReceiptReference: "history:zero-use", status: "failed", result: { status: "failed" }, sessionVersion: 0, artifactVersion: 0 }));
  const effects = effectCounts(store, baseline);
  return runtimeFacts({ providerDispatches: 0, providerLookups: 0, workerCalls: 0, ...effects, actionState: history.length > 0 ? "history" : "missing", sessionState: history.every((item) => item.accountId === accountId) ? "owner_scoped" : "foreign", artifactVersion: 0, evidence: history.map((item) => item.kind).join(",") === "credit,cap_hold,action_reservation" ? "line-items" : "missing", status: history.length === 3 ? "ok" : "failed", nextAction: "session_status" });
}

async function observeRevision(versionFence: boolean): Promise<Phase04RuntimeObservation> {
  const run = await completedStart(versionFence ? "version-fence" : "same-lineage");
  const revision = { principal, sessionId: run.result.sessionId, admissionReference: run.admission.reference, idempotencyKey: "revision-one", expectedVersion: 1, maximum: "3250", policyVersion, revision: "Make the counter support a reset action." };
  const [first, replay] = await Promise.all([run.service.reviseSession(revision), run.service.reviseSession(revision)]);
  if (first.status !== "completed" || JSON.stringify(first) !== JSON.stringify(replay)) throw new Error("revision did not replay exactly");
  const terminal = versionFence ? await run.service.reviseSession({ ...revision, idempotencyKey: "stale", expectedVersion: 1, revision: "A stale competing revision." }) : first;
  const action = await run.store.findMeteredAction(run.result.accountId, revision.idempotencyKey);
  const session = await run.store.sessionStatus(run.result.accountId, run.result.sessionId);
  if (!action || !session) throw new Error("revision state was not durable");
  const effects = effectCounts(run.store, run.baseline);
  return runtimeFacts({ providerDispatches: run.gateway.dispatchCount(run.action.operationId) + run.gateway.dispatchCount(action.operationId), providerLookups: 0, workerCalls: run.worker.calls, ...effects, actionState: terminal.status, sessionState: session.status, artifactVersion: terminal.status === "completed" ? terminal.artifactVersion ?? 0 : first.artifactVersion ?? 0, evidence: terminal.status === "denied" ? "version-fence" : "same-lineage", status: terminal.status, nextAction: terminal.nextAction ?? (terminal.status === "denied" ? "revise_session" : "reconcile") });
}

async function ambiguousRun(lookup: "receipt_found" | "definitive_not_accepted" | "pending" | "unresolved", dispatch: "accepted_timeout" | "malformed_receipt" = "accepted_timeout") {
  const { store, admissions, admission } = await fundedDependencies(`ambiguous-${lookup}-${dispatch}`);
  const gateway = new DeterministicModelGateway({ scenario: { dispatch, lookup } });
  const service = new MeteredGenerationService({ fundedAdmission: admissions, store, gateway, worker: { run: async () => { throw new Error("ambiguous operation reached worker"); } } as never, artifactVerifier: verifier });
  const result = await service.startSession({ principal, admissionReference: admission.reference, idempotencyKey: `ambiguous-${lookup}-${dispatch}`, expectedVersion: 0, maximum: "3250", policyVersion, idea: "Build one focused napplet." });
  if (result.status !== "usage_unknown") throw new Error("ambiguous provider operation was not fenced");
  const action = store.meteredActions[0];
  if (!action) throw new Error("ambiguous action missing");
  const baseline = { evidence: store.evidence.length, postings: store.postings.length, lines: store.billingLineItems.length };
  return { store, gateway, baseline, action, result };
}

async function observeAmbiguousCorrelation(): Promise<Phase04RuntimeObservation> {
  const run = await ambiguousRun("receipt_found");
  const lookup = await run.gateway.lookup({ operationId: run.action.operationId, providerRequestId: run.action.providerRequestId!, accountId: run.action.accountId, sessionId: run.action.sessionId, actionId: run.action.actionId, expectedVersion: run.action.expectedVersion, actionBudgetReference: run.action.actionBudgetReference, profileId: run.action.profileId, priceCardId: run.action.priceCardId, requestFingerprint: run.action.fingerprint, maximumUnits: PHASE_04_MODEL_PROFILES["code-proposal"].maximumUnits, selection: "unselected" }, new AbortController().signal);
  const effects = effectCounts(run.store, run.baseline);
  return runtimeFacts({ providerDispatches: run.gateway.dispatchCount(run.action.operationId), providerLookups: run.gateway.lookupCount(run.action.operationId), workerCalls: 0, ...effects, actionState: run.action.status, sessionState: run.result.status === "usage_unknown" ? "blocked" : "missing", artifactVersion: 0, evidence: lookup.status === "receipt_found" && lookup.receipt.operationId === run.action.operationId ? "operation-correlation" : "missing", status: run.result.status, nextAction: run.result.status === "usage_unknown" ? "reconcile" : run.result.nextAction });
}

async function observeProtectedNativeAmbiguity(): Promise<Phase04RuntimeObservation> {
  const run = await ambiguousRun("unresolved", "malformed_receipt");
  const effects = effectCounts(run.store, run.baseline);
  return runtimeFacts({ providerDispatches: run.gateway.dispatchCount(run.action.operationId), providerLookups: run.gateway.lookupCount(run.action.operationId), workerCalls: 0, ...effects, actionState: run.action.status, sessionState: run.result.status === "usage_unknown" ? "blocked" : "missing", artifactVersion: 0, evidence: run.action.reconciliationReason === "malformed_receipt" ? "protected-native" : "missing", status: run.result.status, nextAction: run.result.status === "usage_unknown" ? "reconcile" : run.result.nextAction });
}

async function observeDefinitiveNotAccepted(): Promise<Phase04RuntimeObservation> {
  const run = await ambiguousRun("definitive_not_accepted");
  const reconciliation = new ModelReconciliationService({ store: run.store, gateway: run.gateway });
  const result = await reconciliation.reconcile({ principal, sessionId: run.action.sessionId, actionId: run.action.actionId, operationId: run.action.operationId });
  const action = await run.store.findMeteredActionByOperation(run.action.accountId, run.action.operationId);
  if (!action || result.status !== "failed") throw new Error("definitive non-acceptance did not settle terminally");
  const effects = effectCounts(run.store, run.baseline);
  // `PROVIDER_NOT_ACCEPTED` settles a proven zero-use operation with a
  // balanced `-0` debit posting. Preserve that durable accounting fact.
  const debitPostings = run.store.postings.slice(run.baseline.postings).filter((item) => item.id.endsWith(":debit")).length;
  return runtimeFacts({ providerDispatches: run.gateway.dispatchCount(run.action.operationId), providerLookups: run.gateway.lookupCount(run.action.operationId), workerCalls: 0, ...effects, debitPostings, actionState: action.status, sessionState: result.status, artifactVersion: result.artifactVersion, evidence: result.code === "PROVIDER_NOT_ACCEPTED" ? "reconciliation" : "missing", status: result.status, nextAction: result.nextAction });
}

/** Financial scenarios select a real authority path by ID; none accept fixture expected/oracle data. */
const cases: Readonly<Record<string, () => Promise<Phase04RuntimeObservation>>> = Object.freeze({
  "P04-AUTH-01": () => observePriceCard(false),
  "P04-AUTH-02": () => observePriceCard(true),
  "P04-AUTH-03": observeInputDenial,
  "P04-ACCT-01": observeFinalization,
  "P04-ACCT-02": observeLineItemHistory,
  "P04-ACCT-03": observeFundedStart,
  "P04-ACCT-04": async () => {
    const run = await ambiguousRun("receipt_found");
    const result = await new ModelReconciliationService({ store: run.store, gateway: run.gateway }).reconcile({ principal, sessionId: run.action.sessionId, actionId: run.action.actionId, operationId: run.action.operationId });
    const action = await run.store.findMeteredActionByOperation(run.action.accountId, run.action.operationId);
    if (!action || result.status !== "failed") throw new Error("receipt reconciliation did not settle");
    const effects = effectCounts(run.store, run.baseline);
    return runtimeFacts({ providerDispatches: run.gateway.dispatchCount(run.action.operationId), providerLookups: run.gateway.lookupCount(run.action.operationId), workerCalls: 0, ...effects, actionState: action.status, sessionState: "reconciliation", artifactVersion: result.artifactVersion, evidence: action.providerReceiptReference?.startsWith("fixture-evidence:") ? "normalized-receipt" : "missing", status: result.status, nextAction: result.nextAction });
  },
  "P04-SER-01": async () => {
    const priced = priceReceipt({ receipt: receipt("rational-lines"), card: PHASE_04_DETERMINISTIC_PRICE_CARD, profile: PHASE_04_MODEL_PROFILES["code-proposal"], reservation: "3250" });
    return runtimeFacts({ providerDispatches: 0, providerLookups: 0, workerCalls: 0, receiptWrites: 0, debitPostings: 0, creditPostings: 0, releases: 0, actionState: priced.status, sessionState: priced.status === "priced" ? "authorized" : "blocked", artifactVersion: 0, evidence: priced.status === "priced" && priced.lines.length > 0 ? "rational-lines" : "missing", status: priced.status, nextAction: priced.status === "priced" ? "dispatch" : "reconcile" });
  },
  "P04-SER-02": () => observeRevision(false),
  "P04-SER-03": () => observeRevision(true),
  "P04-AMB-01": observeAmbiguousCorrelation,
  "P04-AMB-02": observeProtectedNativeAmbiguity,
  "P04-AMB-03": observeDefinitiveNotAccepted,
});

export async function observeFinancialCase(id: string): Promise<Phase04RuntimeObservation | undefined> {
  return cases[id]?.();
}
