import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { D122_FAULT_MATRIX, FaultBoundarySchema, FaultClassSchema, FaultScheduleSchema, runFaultScenario } from "../../src/resilience/fault-harness";
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

test("07-W0-03 names every original-operation fault oracle with its consuming owners", async () => {
  const registry = JSON.parse(await readFile(fixturePath, "utf8")) as { cases: { id: string; category: string; decisions: string[]; requirements: string[] }[] };
  const resilience = registry.cases.filter((candidate) => candidate.category === "resilience");
  expect(resilience).toHaveLength(16);
  expect(resilience.every((candidate) => candidate.decisions.includes("D-122") || candidate.decisions.includes("D-123") || candidate.decisions.includes("D-124") || candidate.decisions.includes("D-125"))).toBe(true);
  expect(resilience.map((candidate) => candidate.id)).toEqual(expect.arrayContaining(["R01", "R09", "R13", "R16"]));
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

test("D-122 matrix executes every fault family with one-writer exact-oracle schedules", async () => {
  expect(D122_FAULT_MATRIX.map((schedule) => schedule.faultClass)).toEqual([
    "duplicate_relay", "out_of_order_relay", "regional_ingress_loss", "sql_serialization", "sql_unavailable",
    "capacity_ambiguity", "worker_loss", "object_interruption", "model_receipt_ambiguity", "payment_notification",
    "restore_expiry_race", "preview_source_invalidation", "partial_publication",
  ]);
  for (const schedule of D122_FAULT_MATRIX) {
    await expect(runFaultScenario(schedule, ({ input, initialState, outcomes }) => ({
      operationId: input.operationId ?? `operation:${schedule.id}`,
      sessionId: initialState.sessionId ?? `session:${schedule.id}`,
      observed: outcomes.at(-1)?.outcome ?? "unresolved",
      activeWriters: 1,
      effects: { credit: 0, debit: 0, worker: 0, session: 0, artifact: 0, checkpoint: 0, deploy: 0, ownerEvent: 0, attestation: 0 },
    }), { activeWriters: 1, effects: { credit: 0, debit: 0, worker: 0, session: 0, artifact: 0, checkpoint: 0, deploy: 0, ownerEvent: 0, attestation: 0 } })).resolves.toMatchObject({ activeWriters: 1 });
  }
});
