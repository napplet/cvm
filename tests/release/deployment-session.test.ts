import { expect, test } from "bun:test";

import { createDeploymentReleaseExecutionSession } from "../../src/release/deployment/factory";
import { RELEASE_PRODUCTION_PROVIDER_IDS } from "../../src/release/native-registry";

const digest = (letter: string) => letter.repeat(64);

const registry = Object.freeze({
  providers: () => [...RELEASE_PRODUCTION_PROVIDER_IDS],
  discover: async () => ({}), plan: async () => ({}), apply: async () => ({}), observe: async () => ({}), cleanup: async () => ({}),
});

test("session preparation rejects a receipt-bound payload that does not preserve candidate and request identity", async () => {
  const session = createDeploymentReleaseExecutionSession({
    candidateSha256: digest("a"), workspace: "/tmp", deploymentConfig: { secretReferences: {}, publicSettings: { regions: ["europe-west1"] } },
  } as never, {
    registry: registry as never,
    async prepareAuthorizedExecution() {
      return { receipt: { authorizationRequestSha256: digest("b") } } as never;
    },
  });

  await expect(session.prepareAuthorizedExecution({ authorizationRequest: { authorizationRequestSha256: digest("a"), candidateSha256: digest("a"), topologySha256: digest("c") } as never })).rejects.toThrow("DEPLOYMENT_PREPARATION_RECEIPT_BINDING_REQUIRED");
});
