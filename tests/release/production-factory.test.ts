import type { ReleaseExecutionFactoryInput } from "../../src/release/production-execution";
import { expect, test } from "bun:test";

import { RELEASE_PRODUCTION_PROVIDER_IDS } from "../../src/release/native-registry";
import {
  PRODUCTION_FACTORY_SECRET_REFERENCE_NAMES,
  assessProductionFactoryReadiness,
  createProductionReleaseExecutionSession,
  releaseReadiness,
} from "../../src/release/deployment/production-factory";

const digest = (letter: string) => letter.repeat(64);

test("the production inventory is complete but cannot claim executable readiness before live dependencies are injected", () => {
  expect(releaseReadiness.providerFamilies).toEqual(RELEASE_PRODUCTION_PROVIDER_IDS);
  expect(releaseReadiness.protectedSuites).toHaveLength(8);
  expect(PRODUCTION_FACTORY_SECRET_REFERENCE_NAMES).toContain("nwcLightningConnection");
  expect(PRODUCTION_FACTORY_SECRET_REFERENCE_NAMES).toContain("cashuFundedWallet");
  expect(PRODUCTION_FACTORY_SECRET_REFERENCE_NAMES).not.toContain("nip46OwnerSigner");

  const input: ReleaseExecutionFactoryInput = {
    candidateSha256: digest("a"),
    workspace: "/workspace/release",
    deploymentConfig: {
      version: 1,
      candidateSha256: digest("a"),
      sourceRevision: "b".repeat(40),
      workspaceRoot: "/workspace/release",
      factoryModuleSha256: digest("c"),
      publicSettings: { regions: ["europe-west1", "us-central1"], maximumRunDurationMs: 900_000, retentionDays: 30 },
      secretReferences: Object.fromEntries(PRODUCTION_FACTORY_SECRET_REFERENCE_NAMES.map((name) => [name, `opaque:${name}`])),
    },
  };

  expect(assessProductionFactoryReadiness(input)).toEqual({ ready: false, blockers: ["AUTHORIZED_EXECUTION_PORTS_REQUIRED"] });
  expect(() => createProductionReleaseExecutionSession(input)).toThrow("PRODUCTION_FACTORY_READINESS_BLOCKED:AUTHORIZED_EXECUTION_PORTS_REQUIRED");
});
