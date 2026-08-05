import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { ContextVmFundingAdapter } from "../../src/contextvm/adapter";
import { FundedAdmissionService } from "../../src/funding/funded-admission";
import { FundingService } from "../../src/funding/funding-service";
import { TransactionalMemoryFundingStore } from "../../src/persistence/funding-store";
import { runAdmissionAttempt, summarizeAdmissionSamples } from "../../src/admission/benchmark";
import { AdmissionLifecycleContextSchema } from "../../src/telemetry/contracts";

const fixturePath = "tests/fixtures/phase-07-reference-set.json";
const knownStatuses = new Set(["pending", "blocked", "not_observed", "passed"]);
const knownTiers = new Set(["fast", "medium", "live"]);

type RegistryRow = Readonly<{
  id: string;
  requirement: string;
  threat: string;
  evidenceTier: string;
  status: string;
  commands: readonly string[];
  owners: readonly string[];
  cases: readonly string[];
}>;

async function loadRegistry(): Promise<Readonly<{ schema: "phase-07-reference-set"; version: 1; entries: readonly RegistryRow[] }>> {
  return JSON.parse(await readFile(fixturePath, "utf8"));
}

function assertStrictRegistry(registry: Awaited<ReturnType<typeof loadRegistry>>): void {
  expect(registry).toMatchObject({ schema: "phase-07-reference-set", version: 1 });
  expect(registry.entries.map((entry) => entry.id)).toEqual(["07-W0-01", "07-W0-02", "07-W0-03", "07-W0-04", "07-W0-05"]);
  expect(new Set(registry.entries.map((entry) => entry.id)).size).toBe(registry.entries.length);
  for (const entry of registry.entries) {
    expect(entry.requirement).toMatch(/^(SESS-02|OPS-0[1-4])$/u);
    expect(entry.threat).toMatch(/^T-07-(ADM|TEL|REC|RST|PRO)$/u);
    expect(knownTiers.has(entry.evidenceTier)).toBe(true);
    expect(knownStatuses.has(entry.status)).toBe(true);
    expect(entry.status).not.toBe("passed");
    expect(entry.commands.length).toBeGreaterThan(0);
    expect(entry.owners.length).toBeGreaterThan(0);
    expect(entry.cases.length).toBeGreaterThan(0);
  }
}

test("07-W0-01 registry is unique, owner-bound, and pending until Plan 07-01 observations exist", async () => {
  const registry = await loadRegistry();
  assertStrictRegistry(registry);
  const entry = registry.entries.find((candidate) => candidate.id === "07-W0-01");
  expect(entry).toMatchObject({
    requirement: "SESS-02",
    threat: "T-07-ADM",
    evidenceTier: "live",
    status: "pending",
    commands: ["bun test tests/phase-07/admission-slo.test.ts", "bun run certify:phase07 -- --suite=admission"],
    owners: ["07-01 Task 1", "07-01 Task 2"],
  });
  expect(entry?.cases).toEqual(expect.arrayContaining([
    "receipt-before-effects", "exact-session-readiness", "stable-no-effect-refusal", "exact-replay", "concurrent-single-claim", "sample-confidence", "zero-backlog",
  ]));
});

test("07-W0-01 rejects duplicate IDs, unknown registry enums, and baseline pass claims", async () => {
  const registry = await loadRegistry();
  const duplicate = structuredClone(registry); duplicate.entries.push(structuredClone(duplicate.entries[0]));
  expect(() => assertStrictRegistry(duplicate)).toThrow();
  const unknownStatus = structuredClone(registry); unknownStatus.entries[0].status = "unknown";
  expect(() => assertStrictRegistry(unknownStatus)).toThrow();
  const passClaim = structuredClone(registry); passClaim.entries[0].status = "passed";
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
});
