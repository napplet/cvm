import { expect, test } from "bun:test";
import { createMountedReleaseCleanup } from "../../src/production/release-cleanup";

const original = { provider: "modal" as const, providerOperationId: "worker-original", resourceIdentitySha256: "a".repeat(64) };
const command = { operationId: "cleanup-original", providerOperationId: original.providerOperationId, resourceIdentitySha256: original.resourceIdentitySha256 };

test("finalization cleanup requires confirmed completion of the exact owned resource", async () => {
  for (const status of ["cleaned", "pending", "blocked"] as const) {
    const calls: unknown[] = [];
    const cleanup = createMountedReleaseCleanup({ effects: [original], providers: { modal: { port: { async cleanup(value: unknown) { calls.push(value); return { status, actualCostMicros: 0 }; } } } } as never });
    expect(await cleanup.cleanup(command)).toBe(status === "cleaned" ? "cleaned" : "unknown");
    expect(calls).toEqual([{ operationId: original.providerOperationId, resourceIdentitySha256: original.resourceIdentitySha256 }]);
    await expect(cleanup.cleanup({ ...command, resourceIdentitySha256: "b".repeat(64) })).rejects.toThrow("ORIGINAL_REQUIRED");
    expect(calls).toHaveLength(1);
  }
});

test("original resource observation cannot manufacture cleaned or retained status and never deletes", async () => {
  for (const status of ["completed", "pending", "missing", "blocked"] as const) {
    let reads = 0, deletes = 0;
    const cleanup = createMountedReleaseCleanup({ effects: [original], providers: { modal: { port: { async observe() { reads++; return { status }; }, async cleanup() { deletes++; throw new Error("UNEXPECTED_DELETE"); } } } } as never });
    expect(await cleanup.observe!(command)).toBe("unknown");
    expect({ reads, deletes }).toEqual({ reads: 1, deletes: 0 });
  }
  expect(() => createMountedReleaseCleanup({ effects: [original, original], providers: {} as never })).toThrow("DUPLICATE_ORIGINAL");
});


test("cleanup observation rejects unbranded worker reports before any invocation", () => {
  let calls = 0;
  const fake = { async observeCleanup() { calls++; return { status: "cleaned" }; } };
  expect(() => createMountedReleaseCleanup({ effects: [original], providers: {} as never, workers: { modal: fake, fly: fake } as never })).toThrow("PRODUCTION_WORKER_LIFECYCLE_REQUIRED");
  expect(calls).toBe(0);
});


test("Google cleanup recovery uses dedicated original-cleanup observation and never repeats deletion", async () => {
  for (const provider of ["cloud_run", "cloud_sql_postgres", "collector"] as const) {
    for (const status of ["cleaned", "pending", "missing", "unknown", "blocked"] as const) {
      const queries: unknown[] = [];
      const effect = { ...original, provider };
      const cleanup = createMountedReleaseCleanup({ effects: [effect], providers: { [provider]: { port: {
        async observeCleanup(value: unknown) { queries.push(value); return { status }; },
        async observe() { throw new Error("GENERIC_RESOURCE_READ_FORBIDDEN"); },
        async cleanup() { throw new Error("REPEATED_DELETE_FORBIDDEN"); },
      } } } as never });
      expect(await cleanup.observe!(command)).toBe(status === "cleaned" ? "cleaned" : "unknown");
      expect(queries).toEqual([{ operationId: original.providerOperationId, resourceIdentitySha256: original.resourceIdentitySha256 }]);
    }
  }
});
