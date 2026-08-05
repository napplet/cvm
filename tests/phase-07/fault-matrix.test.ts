import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { FaultBoundarySchema, FaultClassSchema, FaultScheduleSchema, runFaultScenario } from "../../src/resilience/fault-harness";

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
