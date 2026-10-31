import { test } from "bun:test";
import { createMemoryWorkerOperationJournal } from "../../src/release/deployment/worker-clients";
import { proveFlyMissingIdCleanup, proveModalMissingIdCleanup } from "../fixtures/worker-missing-id-cleanup";

test("Modal cleanup recovers a lost original ID after expiry without CREATE or duplicate termination", async () => {
  const journal = createMemoryWorkerOperationJournal();
  await proveModalMissingIdCleanup(() => journal);
});
test("Fly cleanup recovers a lost original ID after expiry without CREATE or duplicate DELETE", async () => {
  const journal = createMemoryWorkerOperationJournal();
  await proveFlyMissingIdCleanup(() => journal);
});
