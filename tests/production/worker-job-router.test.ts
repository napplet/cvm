import { expect, test } from "bun:test";
import { ProductionConfigSchema } from "../../src/production/config";
import { assertProductionWorkerJobRouter, ProductionWorkerJobRouter } from "../../src/production/worker-job-router";

const worker = { selectedProvider: "modal", evidenceReference: "worker:evidence", modalAccessReference: "worker:modal", flyAccessReference: "worker:fly", image: `registry.example/current@sha256:${"a".repeat(64)}`, toolchainSha256: "b".repeat(64), policyVersion: "funding-policy-v1" };
const retained = { image: `registry.example/original@sha256:${"c".repeat(64)}`, toolchainSha256: "d".repeat(64), artifactContract: "legacy-aggregate-v1" as const };
test("retained worker configuration preserves omission and bounds the approved executable contract", () => {
  expect(ProductionConfigSchema.shape.worker.parse(worker).retainedProfiles).toBeUndefined();
  expect(ProductionConfigSchema.shape.worker.parse({ ...worker, retainedProfiles: [retained] }).retainedProfiles).toEqual([retained]);
  for (const value of [
    { ...retained, image: "registry.example/original:latest" },
    { ...retained, toolchainSha256: "caller-selected" },
    { ...retained, artifactContract: "nip5d-direct-v1" },
    { ...retained, credential: "inbound-secret" },
  ]) expect(() => ProductionConfigSchema.shape.worker.parse({ ...worker, retainedProfiles: [value] })).toThrow();
  expect(() => ProductionConfigSchema.shape.worker.parse({ ...worker, retainedProfiles: Array.from({ length: 9 }, () => retained) })).toThrow();
});
test("retained routing rejects structural and prototype impersonation", () => {
  expect(() => assertProductionWorkerJobRouter({ resolve() {} })).toThrow("PRODUCTION_WORKER_JOB_ROUTER_REQUIRED");
  expect(() => assertProductionWorkerJobRouter(Object.create(ProductionWorkerJobRouter.prototype))).toThrow("PRODUCTION_WORKER_JOB_ROUTER_REQUIRED");
});
