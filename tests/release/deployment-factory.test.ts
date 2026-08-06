import { expect, test } from "bun:test";

import { createDeploymentExecutionConfig } from "../../src/release/deployment/config";

test("deployment configuration serializes only hash pins, bounded public settings, and named secret references", () => {
  const config = createDeploymentExecutionConfig({
    candidateSha256: "a".repeat(64),
    sourceRevision: "b".repeat(40),
    workspaceRoot: "/workspace/release",
    factoryModuleSha256: "c".repeat(64),
    publicSettings: { regions: ["europe-west1", "us-central1"] },
    secretReferences: {
      googleApplicationDefaultCredentials: "gcp:adc:release",
      contextVmServiceKey: "nostr:contextvm:service-key",
    },
  });

  expect(config).toEqual(expect.objectContaining({
    candidateSha256: "a".repeat(64),
    factoryModuleSha256: "c".repeat(64),
  }));
  expect(() => createDeploymentExecutionConfig({
    ...config,
    secretReferences: { googleApplicationDefaultCredentials: "ya29.raw-adc-token" },
  })).toThrow();
});
