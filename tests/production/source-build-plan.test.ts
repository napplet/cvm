import { expect, test } from "bun:test";

import { canonicalJson } from "../../src/promotion/schema";
import { assertMountedSourceBuildPlan, bindMountedSourceBuildExecution, materializeMountedSourceBuildPlan } from "../../src/production/source-build-plan";

const binding = { candidateSha256: "a".repeat(64), topologySha256: "b".repeat(64), provider: "modal" as const };

test("mounted source-build preapproval is a stable bounded golden proposal", () => {
  const first = materializeMountedSourceBuildPlan(binding);
  const second = materializeMountedSourceBuildPlan(binding);
  expect(first).toEqual(second);
  expect(first.fixture).toBe("fixtures/minimal");
  expect(first.files.map(file => file.path)).toEqual(["src/main.ts", "src/styles.css", "src/capabilities.json"]);
  expect(first.operationId).toMatch(/^source-build:[a-f0-9]{64}$/u);
  expect(first.capacityIntentReference).toMatch(/^capacity-intent:[a-f0-9]{64}$/u);
  expect(first.sessionBindingDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
  expect(first.workerOperationId).toMatch(/^capacity-[a-f0-9]{40}$/u);
  expect(first.proposalSha256).toBe(new Bun.CryptoHasher("sha256").update(canonicalJson({ files: first.files })).digest("hex"));
  expect(first.files.find(file => file.path === "src/main.ts")!.content).toContain("import { runtimeHasDomain } from './domain-availability.js';");
  expect(first.files.find(file => file.path === "src/styles.css")!.content).toContain("html, body, #app { height: 100%; }");
  expect(first.files.find(file => file.path === "src/capabilities.json")!.content).toBe('{"required":[],"optional":[]}\n');
  expect(first.candidateSha256).toBe(binding.candidateSha256);
  expect(first.topologySha256).toBe(binding.topologySha256);
  expect(first.provider).toBe(binding.provider);
  expect(assertMountedSourceBuildPlan(first, binding)).toEqual(first);
});

test("mounted source-build preapproval rejects a substituted source or worker identity", () => {
  const plan = materializeMountedSourceBuildPlan(binding);
  expect(() => assertMountedSourceBuildPlan({ ...plan, workerOperationId: `capacity-${"0".repeat(40)}` }, binding)).toThrow("PRODUCTION_SOURCE_BUILD_PLAN_BINDING_REQUIRED");
  expect(() => assertMountedSourceBuildPlan({ ...plan, files: plan.files.map(file => file.path === "src/main.ts" ? { ...file, content: `${file.content}// injected` } : file) }, binding)).toThrow("PRODUCTION_SOURCE_BUILD_PLAN_BINDING_REQUIRED");
  expect(() => assertMountedSourceBuildPlan(plan, { ...binding, topologySha256: "c".repeat(64) })).toThrow("PRODUCTION_SOURCE_BUILD_PLAN_BINDING_REQUIRED");
});

test("protected execution derives fresh original IDs from the authorization request", () => {
  const plan = materializeMountedSourceBuildPlan(binding);
  const first = bindMountedSourceBuildExecution(plan, { authorizationRequestSha256: "c".repeat(64) });
  const repeated = bindMountedSourceBuildExecution(plan, { authorizationRequestSha256: "c".repeat(64) });
  const renewed = bindMountedSourceBuildExecution(plan, { authorizationRequestSha256: "d".repeat(64) });
  expect(repeated).toEqual(first);
  expect(renewed.operationId).not.toBe(first.operationId);
  expect(renewed.capacityIntentReference).not.toBe(first.capacityIntentReference);
  expect(renewed.workerOperationId).not.toBe(first.workerOperationId);
  expect(renewed.jobId).not.toBe(first.jobId);
});
