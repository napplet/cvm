import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { FaultBoundarySchema, FaultClassSchema, FaultScheduleSchema, runFaultScenario } from "../../src/resilience/fault-harness";
import { DeterministicModelGateway } from "../../src/model/deterministic-model-gateway";
import { ModelReconciliationService } from "../../src/model/reconciliation";
import { MeteredGenerationService } from "../../src/phase-04/metered-generation-service";
import { FundingService } from "../../src/funding/funding-service";
import { FundedAdmissionService } from "../../src/funding/funded-admission";
import { TransactionalMemoryFundingStore } from "../../src/persistence/funding-store";
import { canonicalCapabilityReview } from "../../src/publication/capability-review";
import { PublicationService } from "../../src/publication/publication-service";
import { TransactionalMemoryPublicationStore } from "../../src/persistence/publication-store";
import { signedPhase06EventFixture, verifiedPhase06Artifact } from "../phase-06/fakes";

const fixturePath = "tests/fixtures/phase-07-reference-set.json";

function assertFaultEntry(entry: unknown): asserts entry is Readonly<{ requirement: string; threat: string; evidenceTier: string; status: string; commands: readonly string[]; owners: readonly string[]; cases: readonly string[] }> {
  expect(entry).toMatchObject({
    requirement: "OPS-02",
    threat: "T-07-REC",
    evidenceTier: "medium",
    status: "pending",
    commands: ["bun test tests/evals/phase-07-reference-set.test.ts", "bun run certify:phase07 -- --suite=chaos"],
    owners: ["07-06 Task 1", "07-06 Task 2", "07-09 Task 1"],
  });
  expect((entry as { status: string }).status).not.toBe("passed");
}

test("07-W0-03 names every original-operation fault oracle with its consuming owners", async () => {
  const registry = JSON.parse(await readFile(fixturePath, "utf8"));
  const entry = registry.entries.find((candidate: { id: string }) => candidate.id === "07-W0-03");
  assertFaultEntry(entry);
  expect(entry.cases).toEqual(expect.arrayContaining([
    "d122-fault-families", "durable-boundaries", "concurrent-retry-schedule", "single-writer", "visible-unknown-state", "exact-credit-debit-worker-session-artifact-checkpoint-deploy-owner-event-attestation",
  ]));
});

test.todo("07-W0-03 derives original-operation counters from the Plan 07-06/07-09 fault harness");

test("original-operation tracer accepts only bounded port schedules and comparator-only exact effects", async () => {
  const schedule = FaultScheduleSchema.parse({
    id: "original-operation-tracer",
    faultClass: "model_receipt_ambiguity",
    boundary: "model_lookup",
    input: { operationId: "operation:original" },
    initialState: { sessionId: "session:original" },
    outcomes: [{ boundary: "model_lookup", outcome: "receipt_found" }],
  });

  expect(FaultClassSchema.parse(schedule.faultClass)).toBe("model_receipt_ambiguity");
  expect(FaultBoundarySchema.parse(schedule.boundary)).toBe("model_lookup");
  await expect(runFaultScenario(schedule, async ({ input, initialState, outcomes }) => ({
    operationId: input.operationId,
    sessionId: initialState.sessionId,
    observed: outcomes[0]?.outcome,
    activeWriters: 1,
    effects: { credit: 1, debit: 1, worker: 0, session: 1, artifact: 0, checkpoint: 0, deploy: 1, ownerEvent: 1, attestation: 1 },
  }), {
    activeWriters: 1,
    effects: { credit: 1, debit: 1, worker: 0, session: 1, artifact: 0, checkpoint: 0, deploy: 1, ownerEvent: 1, attestation: 1 },
  })).resolves.toMatchObject({ operationId: "operation:original", observed: "receipt_found" });
});

const principal = { pubkey: "ef".repeat(32) };

async function ambiguousModel() {
  const store = new TransactionalMemoryFundingStore();
  const funding = new FundingService(store);
  await funding.execute({ principal, kind: "credit_settlement", idempotencyKey: "fault-credit", policyVersion: "funding-policy-v1", protocolVersion: "funding-contract-v1", payload: { settlement: { topUpId: "fault-topup", rail: "lightning", unit: "sat", amount: "10000", externalReference: "fault-external", settlementReference: "fault-settlement", verifiedAt: "2026-08-04T00:00:00.000Z" } } });
  const fundedAdmission = new FundedAdmissionService({ funding, store, capacity: { reserveNow: async () => ({ status: "available" as const, reference: "fault-capacity", expiresAt: "2026-08-05T00:00:00.000Z" }), observe: async () => ({ status: "available" as const, reference: "fault-capacity", expiresAt: "2026-08-05T00:00:00.000Z" }), release: async () => {} }, now: () => Date.parse("2026-08-04T00:00:00.000Z") });
  const admission = await fundedAdmission.admit({ principal, idempotencyKey: "fault-admission", policyVersion: "funding-policy-v1", protocolVersion: "funding-contract-v1", payload: { requestedCap: "6500", unit: "sat" } });
  if (admission.status !== "accepted") throw new Error("fault fixture admission failed");
  const gateway = new DeterministicModelGateway({ scenario: { dispatch: "lost_response", lookup: "receipt_found" } });
  const generated = await new MeteredGenerationService({ fundedAdmission, store, gateway, worker: { run: async () => { throw new Error("fault fixture must not run a worker"); } } as never, artifactVerifier: { verify: async () => undefined } }).startSession({ principal, admissionReference: admission.reference, idempotencyKey: "fault-model", expectedVersion: 0, maximum: "3250", policyVersion: "phase-02-policy-2026-08-04", idea: "Build one focused napplet." });
  if (generated.status !== "usage_unknown") throw new Error("fault fixture dispatch was not ambiguous");
  const action = store.meteredActions[0];
  if (!action) throw new Error("fault fixture action missing");
  return { store, gateway, action };
}

test("original-operation tracer settles one ambiguous model operation without redispatch", async () => {
  const { store, gateway, action } = await ambiguousModel();
  const observations: string[] = [];
  const recovery = new ModelReconciliationService({ store, gateway, onObservation: (event) => observations.push(`${event.stage}:${event.state}:${event.operationId}`) });
  const command = { principal, sessionId: action.sessionId, actionId: action.actionId, operationId: action.operationId };
  const [first, duplicate] = await Promise.all([recovery.reconcile(command), recovery.reconcile(command)]);
  expect(first).toEqual(duplicate);
  expect(first).toMatchObject({ status: "failed", operationId: action.operationId });
  expect(gateway.dispatchCount(action.operationId)).toBe(1);
  expect(gateway.lookupCount(action.operationId)).toBe(1);
  expect(store.postings.filter((posting) => posting.reference === action.operationId)).toHaveLength(1);
  expect(observations).toEqual(expect.arrayContaining([`claim:claimed:${action.operationId}`, `lookup:receipt_found:${action.operationId}`, `record:finalized:${action.operationId}`]));
});

test("partial publication reconciles fixed children by observation only", async () => {
  const store = new TransactionalMemoryPublicationStore();
  const calls = { deploy: 0, owner: 0, attestation: 0, observe: 0 };
  const service = new PublicationService({
    store, clock: { nowMs: () => 1_700_000_000_000 }, verifier: { verify: async ({ event }) => ({ valid: true, eventId: event.id }) },
    deployment: { deployExact: async ({ operationId }) => { calls.deploy += 1; return { operationId, state: "unknown" as const, observationId: `deploy:${operationId}` }; }, publishOwnerManifest: async ({ operationId }) => { calls.owner += 1; return { operationId, state: "unknown" as const, observationId: `owner:${operationId}` }; }, observe: async ({ operationId }) => { calls.observe += 1; return { operationId, state: "completed" as const, observationId: `observe:${operationId}` }; } },
    attestation: { publish: async ({ operationId }) => { calls.attestation += 1; return { operationId, state: "unknown" as const, observationId: `attestation:${operationId}` }; }, observe: async ({ operationId }) => ({ operationId, state: "completed" as const, observationId: `observe:${operationId}` }) },
  });
  const review = await canonicalCapabilityReview(verifiedPhase06Artifact, "napplet-host/v1");
  const intent = await service.createIntent({ accountId: verifiedPhase06Artifact.accountId, sessionId: verifiedPhase06Artifact.sessionId, artifact: verifiedPhase06Artifact, review, ownerPubkey: signedPhase06EventFixture.pubkey, idempotencyKey: "fault-publication", purpose: "Publish exact sealed bytes", consent: "approved", runtimeVariant: "napplet-host/v1" });
  const command = { commandId: "fault-publication-command", intentId: intent.intentId, intentFingerprint: intent.fingerprint, operationIds: { deploy: `deploy:${intent.intentId}`, ownerManifest: `owner_manifest:${intent.intentId}`, attestation: `attestation:${intent.intentId}` } };
  await service.submitSignedManifest({ accountId: intent.accountId, intentId: intent.intentId, command, event: signedPhase06EventFixture });
  const [first, duplicate] = await Promise.all([service.reconcile({ accountId: intent.accountId, intentId: intent.intentId }), service.reconcile({ accountId: intent.accountId, intentId: intent.intentId })]);
  expect(first).toEqual(duplicate);
  expect(calls).toMatchObject({ deploy: 1, owner: 1, attestation: 1 });
  expect(calls.observe).toBeGreaterThan(0);
});
