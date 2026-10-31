import { expect, test } from "bun:test";
import { ProductionConfigSchema } from "../../src/production/config";
import { assertProductionWorkerJobRouter, ProductionWorkerJobRouter } from "../../src/production/worker-job-router";
import { WorkerRunRequestSchema } from "../../src/phase-02/contracts";

const worker = { selectedProvider: "modal", evidenceReference: "worker:evidence", modalAccessReference: "worker:modal", flyAccessReference: "worker:fly", image: `registry.example/current@sha256:${"a".repeat(64)}`, toolchainSha256: "b".repeat(64), policyVersion: "funding-policy-v1" };
const retained = { image: `registry.example/original@sha256:${"c".repeat(64)}`, toolchainSha256: "d".repeat(64), artifactContract: "legacy-aggregate-v1" as const };
test("retained worker configuration preserves omission and bounds the approved executable contract", () => {
  expect(ProductionConfigSchema.shape.worker.parse(worker).retainedProfiles).toBeUndefined();
  expect(ProductionConfigSchema.shape.worker.parse(worker).artifactContract).toBeUndefined();
  expect(ProductionConfigSchema.shape.worker.parse({ ...worker, artifactContract: "nip5d-direct-v1" }).artifactContract).toBe("nip5d-direct-v1");
  expect(ProductionConfigSchema.shape.worker.parse({ ...worker, retainedProfiles: [{ ...retained, artifactContract: "nip5d-direct-v1" }] }).retainedProfiles?.[0]?.artifactContract).toBe("nip5d-direct-v1");
  expect(ProductionConfigSchema.shape.worker.parse({ ...worker, retainedProfiles: [retained] }).retainedProfiles).toEqual([retained]);
  for (const value of [
    { ...retained, image: "registry.example/original:latest" },
    { ...retained, toolchainSha256: "caller-selected" },
    { ...retained, artifactContract: "caller-chosen-format" },
    { ...retained, credential: "inbound-secret" },
  ]) expect(() => ProductionConfigSchema.shape.worker.parse({ ...worker, retainedProfiles: [value] })).toThrow();
  expect(() => ProductionConfigSchema.shape.worker.parse({ ...worker, retainedProfiles: Array.from({ length: 9 }, () => retained) })).toThrow();
});
test("retained routing rejects structural and prototype impersonation", () => {
  expect(() => assertProductionWorkerJobRouter({ resolve() {} })).toThrow("PRODUCTION_WORKER_JOB_ROUTER_REQUIRED");
  expect(() => assertProductionWorkerJobRouter(Object.create(ProductionWorkerJobRouter.prototype))).toThrow("PRODUCTION_WORKER_JOB_ROUTER_REQUIRED");
});
test("requests cannot select the candidate-owned artifact contract", () => {
  for (const artifactContract of ["legacy-aggregate-v1", "nip5d-direct-v1"]) expect(() => WorkerRunRequestSchema.parse({
    sessionId: "session:one", actionId: "action:one", expectedVersion: 0, policyVersion: "policy:one", capabilityGrant: "phase-04-coordinator-grant",
    workspaceId: "workspace:session:one", idea: "A focused counter", artifactContract,
  })).toThrow();
});
