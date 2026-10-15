import { expect, test } from "bun:test";
import { createDevelopmentFunding } from "../../scripts/dev-funding";
import type { DevPayments } from "../../scripts/dev-payments";
import { DeterministicModelGateway } from "../../src/model/deterministic-model-gateway";
import { SourceProposalStore } from "../../src/dev/source-proposal-store";
import { DevelopmentModelGateway } from "../../src/dev/development-model-gateway";
import { FundingService } from "../../src/funding/funding-service";
import { FundedAdmissionService } from "../../src/funding/funded-admission";
import { TransactionalMemoryFundingStore } from "../../src/persistence/funding-store";
import { MeteredGenerationService } from "../../src/phase-04/metered-generation-service";
import { exactReadyReservation, trustedAdmissionReceipt, trustedAdmissionReceiptAuthority } from "../fixtures/admission-ready";

const intent = (overrides: Record<string, unknown> = {}) => ({
  operationId: "operation:proposal-e2e", providerRequestId: "operation:proposal-e2e", accountId: "account:proposal-e2e", sessionId: "session:proposal-e2e", actionId: "start:proposal-e2e", expectedVersion: 0,
  actionBudgetReference: "budget:proposal-e2e", profileId: "code-proposal", priceCardId: "phase-04-deterministic-card-2026-08-04", requestFingerprint: "a".repeat(64), prompt: "Build a focused counter.",
  maximumUnits: [{ dimension: "input_tokens", units: "1000" }, { dimension: "output_tokens", units: "1000" }], selection: "unselected" as const, ...overrides,
});

test("deterministic proposal SQL dispatch lookup restart replay", async () => {
  let app: Awaited<ReturnType<typeof createDevelopmentFunding>> | undefined;
  try {
    const config = await Bun.file(`${import.meta.dir}/../../.local/napplet-cvm-dev-payments/payments.json`).json() as DevPayments;
    app = await createDevelopmentFunding(config);
    const store = new SourceProposalStore(app.pool);
    const first = new DeterministicModelGateway({ scenario: { dispatch: "completed", lookup: "receipt_found" }, proposalStore: store });
    const dispatched = await first.dispatch(intent(), new AbortController().signal);
    expect(dispatched).toMatchObject({ status: "completed", sourceProposalReference: expect.stringMatching(/^proposal:sha256:/u) });
    if (dispatched.status !== "completed" || !dispatched.sourceProposalReference) throw new Error("proposal missing");
    const persisted = await store.lookup({ intent: intent() });
    expect(persisted?.proposal.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(persisted?.proposal.files.map((file) => file.path)).toEqual(["src/main.ts", "src/styles.css", "src/domain-availability.js"]);
    expect(persisted?.proposal.files[0]?.content).toContain('runtimeHasDomain');
    expect(await store.lookup({ intent: intent({ accountId: "account:other" }), reference: dispatched.sourceProposalReference })).toBeUndefined();
    expect(await store.lookup({ intent: intent({ authorizedPriorArtifactReference: "artifact:wrong" }), reference: dispatched.sourceProposalReference })).toBeUndefined();
    await app.close(); app = undefined;
    app = await createDevelopmentFunding(config);
    const restarted = new DeterministicModelGateway({ scenario: { dispatch: "completed", lookup: "receipt_found" }, proposalStore: new SourceProposalStore(app.pool) });
    const lookedUp = await restarted.lookup(intent(), new AbortController().signal);
    expect(lookedUp).toMatchObject({ status: "receipt_found", sourceProposalReference: dispatched.sourceProposalReference });
    const replay = await restarted.dispatch(intent(), new AbortController().signal);
    expect(replay).toMatchObject({ status: "completed", sourceProposalReference: dispatched.sourceProposalReference });
    const rows = await app.pool.query<{ count: number }>("SELECT count(*)::int AS count FROM source_proposals WHERE operation_id=$1", ["operation:proposal-e2e"]);
    expect(rows.rows[0]?.count).toBe(1);
  } finally { await app?.close(); }
}, 300_000);

test("configured provider pricing usage proposal recovery", async () => {
  const config = await Bun.file(`${import.meta.dir}/../../.local/napplet-cvm-dev-payments/payments.json`).json() as DevPayments;
  const app = await createDevelopmentFunding(config);
  try {
    // No credential/source fixture is a deliberate unavailable state: the
    // selector does not invent provider price or dispatch output.
    const gateway = new DevelopmentModelGateway({ store: new SourceProposalStore(app.pool) });
    expect(gateway.label()).toBe("Deterministic fixture");
    await expect(Promise.resolve().then(() => new DevelopmentModelGateway({ store: new SourceProposalStore(app.pool), configured: {
      apiKey: "server-only-test-key", model: "gpt-5-mini",
      profile: { id: "configured", provider: "openai_responses", model: "gpt-5-mini", priceCardId: "configured-card", selection: "unselected", maximumUnits: [{ dimension: "input_tokens", units: "1" }], deadlineMs: 1_000 },
      priceCard: { id: "configured-card", version: "1", kind: "source_attributed_provider", provider: "openai_responses", currency: "sat", supportedDimensions: ["input_tokens"], rates: { input_tokens: { numerator: "1", denominator: "1" } }, rounding: "ceil", ceilings: { inputTokens: "1", outputTokens: "1" }, validity: { notBefore: "2026-01-01T00:00:00.000Z", notAfter: "2027-01-01T00:00:00.000Z" } },
    } }))).rejects.toThrow();
  } finally { await app.close(); }
});

test("ContextVM metered proposal handoff lookup only", async () => {
  const config = await Bun.file(`${import.meta.dir}/../../.local/napplet-cvm-dev-payments/payments.json`).json() as DevPayments;
  const app = await createDevelopmentFunding(config);
  try {
    const store = new TransactionalMemoryFundingStore();
    const funding = new FundingService(store);
    const principal = { pubkey: "ab".repeat(32) };
    await funding.execute({ principal, kind: "credit_settlement", idempotencyKey: "proposal-credit", policyVersion: "funding-policy-v1", protocolVersion: "funding-contract-v1", payload: { settlement: { topUpId: "proposal-credit", rail: "cashu", unit: "sat", amount: "10000", externalReference: "proposal-credit", settlementReference: "proposal-credit", verifiedAt: "2026-08-04T00:00:00.000Z" } } });
    const admissionService = new FundedAdmissionService({ funding, store, capacity: { reserveNow: async ({ intentReference }) => exactReadyReservation(intentReference, "proposal-capacity", "2026-08-05T00:00:00.000Z"), observe: async ({ intentReference }) => exactReadyReservation(intentReference, "proposal-capacity", "2026-08-05T00:00:00.000Z"), release: async () => {} }, receiptAuthority: trustedAdmissionReceiptAuthority, now: () => Date.parse("2026-08-04T00:00:00.000Z") });
    const admissionCommand = { principal, idempotencyKey: "proposal-admission", policyVersion: "funding-policy-v1", protocolVersion: "funding-contract-v1", payload: { requestedCap: "6500", unit: "sat" as const } };
    const admission = await admissionService.admit(admissionCommand, await trustedAdmissionReceipt(admissionCommand));
    if (admission.status !== "accepted") throw new Error("proposal admission unavailable");
    let workerCalls = 0; let proposalReference = "";
    const proposals = new SourceProposalStore(app.pool);
    const gateway = new DeterministicModelGateway({ scenario: { dispatch: "completed", lookup: "receipt_found" }, proposalStore: proposals });
    const service = new MeteredGenerationService({ fundedAdmission: admissionService, store, gateway, proposalStore: proposals, worker: { async run(request) { workerCalls += 1; proposalReference = request.sourceProposalReference ?? ""; expect(request).toMatchObject({ sourceProposalReference: expect.stringMatching(/^proposal:sha256:/u), sourceProposalFiles: expect.arrayContaining([expect.objectContaining({ path: "src/main.ts" })]) }); return { status: "unavailable", code: "WORKER_UNAVAILABLE" }; } }, artifactVerifier: { async verify() { return undefined; } } });
    const result = await service.startSession({ principal, admissionReference: admission.reference, idempotencyKey: "proposal-action", expectedVersion: 0, maximum: "3250", policyVersion: "phase-02-policy-2026-08-04", idea: "Build a focused counter." });
    expect(result).toMatchObject({ status: "failed", operationId: expect.any(String) });
    expect(workerCalls).toBe(1);
    const replay = await service.startSession({ principal, admissionReference: admission.reference, idempotencyKey: "proposal-action", expectedVersion: 0, maximum: "3250", policyVersion: "phase-02-policy-2026-08-04", idea: "Build a focused counter." });
    expect(replay).toEqual(result);
    const stored = await app.pool.query<{ count: number }>("SELECT count(*)::int AS count FROM source_proposals WHERE proposal_sha256=$1", [proposalReference.slice("proposal:sha256:".length)]);
    expect(stored.rows[0]?.count).toBe(1);
  } finally { await app.close(); }
});
