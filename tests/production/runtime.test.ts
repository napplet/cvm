import { expect, test } from "bun:test";

import { assembleMountedProductionSession } from "../../src/production/runtime";

test("mounted runtime refuses a cross-candidate session before sealing or installing a broker", async () => {
  const generation = {
    config: { candidateSha256: "a".repeat(64), topologySha256: "b".repeat(64) },
    authorization: {
      request: { candidateSha256: "a".repeat(64), topologySha256: "b".repeat(64) },
      receipt: { candidateSha256: "a".repeat(64), topologySha256: "b".repeat(64) },
    },
  };
  await expect(assembleMountedProductionSession({
    generation: generation as never,
    material: { realm: "production-real", deploymentConfig: { candidateSha256: "c".repeat(64) }, workerCandidate: { id: "c".repeat(64) } } as never,
  })).rejects.toThrow("PRODUCTION_RUNTIME_SESSION_CANDIDATE_BINDING_REQUIRED");
});
