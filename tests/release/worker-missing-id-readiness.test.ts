import { test } from "bun:test";
import { createMemoryWorkerOperationJournal } from "../../src/release/deployment/worker-clients";
import { proveMissingIdReadiness } from "../fixtures/worker-missing-id-readiness";

for (const provider of ["modal", "fly"] as const) {
  test(`${provider} readiness resolves only the original lost CREATE and rejects retirement during its probe`, async () => {
    const journal = createMemoryWorkerOperationJournal();
    await proveMissingIdReadiness(provider, { journal: () => journal });
  });
  test(`${provider} readiness rejects a probe that completes after its original deadline`, async () => {
    const journal = createMemoryWorkerOperationJournal();
    await proveMissingIdReadiness(provider, { journal: () => journal }, "deadline");
  });
}
