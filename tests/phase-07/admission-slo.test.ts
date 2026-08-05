import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { ContextVmFundingAdapter } from "../../src/contextvm/adapter";
import { FundedAdmissionService } from "../../src/funding/funded-admission";
import { FundingService } from "../../src/funding/funding-service";
import { TransactionalMemoryFundingStore } from "../../src/persistence/funding-store";
import { runAdmissionAttempt, summarizeAdmissionSamples } from "../../src/admission/benchmark";
import { AdmissionLifecycleContextSchema } from "../../src/telemetry/contracts";

const fixturePath = "tests/fixtures/phase-07-reference-set.json";
async function loadRegistry(): Promise<Readonly<{ schema: "phase-07-reference-set"; version: 2; cases: readonly { id: string; category: string; requirements: readonly string[]; scenario: unknown }[]; liveObservations: readonly { status: string }[] }>> {
  return JSON.parse(await readFile(fixturePath, "utf8"));
}

function assertStrictRegistry(registry: Awaited<ReturnType<typeof loadRegistry>>): void {
  expect(registry).toMatchObject({ schema: "phase-07-reference-set", version: 2 });
  expect(registry.cases).toHaveLength(64);
  expect(new Set(registry.cases.map((entry) => entry.id)).size).toBe(64);
  expect(registry.cases.filter((entry) => entry.category === "admission")).toHaveLength(12);
  expect(registry.cases.every((entry) => entry.scenario && entry.requirements.length > 0)).toBe(true);
  expect(registry.liveObservations.every((entry) => entry.status === "blocked" || entry.status === "not_observed")).toBe(true);
}

test("07-W0-01 corpus preserves admission coverage and explicit protected-live non-pass states", async () => {
  const registry = await loadRegistry();
  assertStrictRegistry(registry);
  expect(registry.cases.filter((entry) => entry.requirements.includes("SESS-02")).map((entry) => entry.id)).toEqual(expect.arrayContaining(["A01", "A02", "A07", "A08", "A12"]));
});

test("07-W0-01 rejects duplicate IDs and fabricated protected-live pass claims", async () => {
  const registry = await loadRegistry();
  const duplicate = structuredClone(registry); duplicate.cases.push(structuredClone(duplicate.cases[0]));
  expect(() => assertStrictRegistry(duplicate)).toThrow();
  const passClaim = structuredClone(registry); passClaim.liveObservations[0].status = "passed";
  expect(() => assertStrictRegistry(passClaim)).toThrow();
});

describe("07-01 trusted immediate-or-refused admission", () => {
  const principal = { pubkey: "a".repeat(64) };

  async function fundedService() {
    const store = new TransactionalMemoryFundingStore();
    const funding = new FundingService(store);
    await funding.execute({
      principal, kind: "credit_settlement", idempotencyKey: "phase-07-credit", policyVersion: "p1", protocolVersion: "v1",
      payload: { settlement: { topUpId: "phase-07-topup", rail: "lightning", unit: "sat", amount: "100", externalReference: "phase-07-external", settlementReference: "phase-07-settlement", verifiedAt: "2026-08-05T00:00:00.000Z" } },
    });
    return { store, funding };
  }

  test("stamps a correlated signed receipt before admission work and accepts only an exact ready lease", async () => {
    let clock = 10;
    let captured: unknown;
    const transport = {
      onInbound: () => undefined,
      canonicalInvocation: () => ({ invocationHash: "b".repeat(64) }),
      sendNotification: async () => undefined,
      sendResponse: async () => undefined,
      configureAnnouncement: () => undefined,
    };
    const adapter = new ContextVmFundingAdapter({
      service: new FundingService(new TransactionalMemoryFundingStore()), transport,
      monotonicNow: () => clock++,
      admissions: { admit: async (_command: unknown, lifecycle: unknown) => { captured = lifecycle; return { status: "refused", accountId: "account:safe", intentReference: "capacity-intent:safe", retryable: true, unit: "sat" }; } } as never,
    });
    await adapter.handle({
      verifiedClientPubkey: principal.pubkey, requestEventId: "event-07", rawEvent: { id: "event-07", tags: [] },
      request: { id: "request-07", method: "tools/call", params: { name: "funded_admission", arguments: { idempotencyKey: "phase-07-admission", requestedCap: "50", unit: "sat" } } },
    });
    expect(AdmissionLifecycleContextSchema.parse(captured)).toMatchObject({ version: "admission-lifecycle-v1", receiptMonotonicMs: 10 });

    const { store, funding } = await fundedService();
    const capacity = {
      reserveNow: async ({ intentReference }: { intentReference: string }) => ({
        status: "available" as const, reference: "lease-07", expiresAt: "2026-08-05T00:01:00.000Z",
        ready: { intentReference, leaseReference: "lease-07", sessionBindingDigest: "sha256:" + "c".repeat(64), imageDigest: "sha256:" + "d".repeat(64), readinessProbeDigest: "sha256:" + "e".repeat(64), readyMonotonicMs: 30 },
      }),
      observe: async () => ({ status: "unknown" as const }), release: async () => undefined,
    };
    const service = new FundedAdmissionService({ funding, store, capacity, now: () => Date.parse("2026-08-05T00:00:00.000Z") });
    const accepted = await service.admit({ principal, idempotencyKey: "phase-07-admission", policyVersion: "p1", protocolVersion: "v1", payload: { requestedCap: "50", unit: "sat" } }, AdmissionLifecycleContextSchema.parse(captured));
    expect(accepted).toMatchObject({ status: "accepted", reference: "lease-07" });
    expect(store.activeHolds).toHaveLength(1);
  });

  test("rejects unready leases and produces a fail-closed deterministic report", async () => {
    const report = summarizeAdmissionSamples([
      { candidateId: "candidate-07", inputId: "case-01", outcome: "accepted", receiptMonotonicMs: 1, readyMonotonicMs: 8, durableBacklogCount: 0, readyLeaseCount: 1 },
      { candidateId: "candidate-07", inputId: "case-02", outcome: "capacity_unavailable", receiptMonotonicMs: 2, readyMonotonicMs: null, durableBacklogCount: 0, readyLeaseCount: 0 },
    ], { minimumSamples: 3 });
    expect(report).toMatchObject({ outcome: "insufficient_sample", count: 2, rejectionRate: 0.5, acceptedWithoutReadyCount: 0, durableBacklogCount: 0 });
    await expect(runAdmissionAttempt({ now: () => 100, attempt: async () => ({ outcome: "accepted", readyLeaseCount: 0, durableBacklogCount: 0 }) })).rejects.toThrow("ADMISSION_READY_LEASE_REQUIRED");
  });

  test("coalesces concurrent and refused replays without a hold, queue, retry, or extra provider effect", async () => {
    const { store, funding } = await fundedService();
    let reserves = 0; let observes = 0; let releases = 0;
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    const capacity = {
      reserveNow: async () => { reserves += 1; await blocked; return { status: "refused" as const }; },
      observe: async () => { observes += 1; return { status: "unknown" as const }; },
      release: async () => { releases += 1; },
    };
    const service = new FundedAdmissionService({ funding, store, capacity, now: () => Date.parse("2026-08-05T00:00:00.000Z") });
    const command = { principal, idempotencyKey: "phase-07-concurrent", policyVersion: "p1", protocolVersion: "v1", payload: { requestedCap: "50", unit: "sat" as const } };
    const first = service.admit(command);
    await Bun.sleep(0);
    const second = service.admit(command);
    await expect(service.admit({ ...command, payload: { requestedCap: "51", unit: "sat" } })).rejects.toThrow("IDEMPOTENCY_KEY_CONFLICT");
    await Bun.sleep(0);
    unblock();
    const outcomes = await Promise.all([first, second]);
    expect(outcomes[0]).toEqual(outcomes[1]);
    expect(outcomes[0]).toMatchObject({ status: "refused" });
    expect({ reserves, observes, releases }).toEqual({ reserves: 1, observes: 0, releases: 0 });
    expect(store.activeHolds).toHaveLength(0);
    expect(await service.admit(command)).toEqual(outcomes[0]);
    expect({ reserves, observes, releases }).toEqual({ reserves: 1, observes: 0, releases: 0 });
    await expect(service.admit({ ...command, payload: { requestedCap: "51", unit: "sat" } })).rejects.toThrow("IDEMPOTENCY_KEY_CONFLICT");

    expect(summarizeAdmissionSamples([
      { candidateId: "candidate-07", inputId: "backlog", outcome: "accepted", receiptMonotonicMs: 1, readyMonotonicMs: 2, readyLeaseCount: 1, durableBacklogCount: 1 },
      { candidateId: "candidate-07", inputId: "partial", outcome: "accepted", receiptMonotonicMs: 1, readyMonotonicMs: null, readyLeaseCount: 0, durableBacklogCount: 0 },
      { candidateId: "candidate-07", inputId: "good", outcome: "accepted", receiptMonotonicMs: 1, readyMonotonicMs: 3, readyLeaseCount: 1, durableBacklogCount: 0 },
    ], { minimumSamples: 3 })).toMatchObject({ outcome: "failed", acceptedWithoutReadyCount: 1, durableBacklogCount: 1 });
  });
});
