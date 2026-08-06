import { expect, test } from "bun:test";

import { RELEASE_PRODUCTION_PROVIDER_IDS } from "../../src/release/native-registry";
import {
  PRODUCTION_FACTORY_SECRET_REFERENCE_NAMES,
  createProductionReleaseExecutionSession,
  releaseReadiness,
} from "../../src/release/deployment/production-factory";

const digest = (letter: string) => letter.repeat(64);

test("the concrete factory has the authoritative sixteen-family inventory and no preapproval NIP-46 request", () => {
  expect(releaseReadiness.providerFamilies).toEqual(RELEASE_PRODUCTION_PROVIDER_IDS);
  expect(releaseReadiness.protectedSuites).toHaveLength(8);
  expect(PRODUCTION_FACTORY_SECRET_REFERENCE_NAMES).toContain("nwcLightningConnection");
  expect(PRODUCTION_FACTORY_SECRET_REFERENCE_NAMES).toContain("cashuFundedWallet");
  expect(PRODUCTION_FACTORY_SECRET_REFERENCE_NAMES).not.toContain("nip46OwnerSigner");

  const session = createProductionReleaseExecutionSession({
    candidateSha256: digest("a"),
    workspace: "/workspace/release",
    deploymentConfig: {
      version: 1,
      candidateSha256: digest("a"),
      sourceRevision: "b".repeat(40),
      workspaceRoot: "/workspace/release",
      factoryModuleSha256: digest("c"),
      publicSettings: { regions: ["europe-west1", "us-central1"] },
      secretReferences: Object.fromEntries(PRODUCTION_FACTORY_SECRET_REFERENCE_NAMES.map((name) => [name, `opaque:${name}`])),
    },
  });

  expect(session.registry.providers()).toEqual(RELEASE_PRODUCTION_PROVIDER_IDS);
  expect(Object.isFrozen(session)).toBeTrue();
});
