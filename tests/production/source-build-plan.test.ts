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
  // Captured from the pre-metadata mainline reader; keep old records addressable.
  expect(first.operationId).toBe("source-build:ee5915b15ee91896506a5a7575be197d5611492a67a9c9dd1de7fd1f50c45f7d");
  expect(first.jobId).toBe("80b2193ef642dbdba789571a2469980e26d0191fd56b57ad82824c364bc7eac5");
  expect(assertMountedSourceBuildPlan(first, binding)).toEqual(first);
});

test("approved publication origin changes job identity without changing generated source", () => {
  const legacy = materializeMountedSourceBuildPlan(binding);
  const first = materializeMountedSourceBuildPlan({ ...binding, publication: { server: "https://blossom.example/" } });
  const changed = materializeMountedSourceBuildPlan({ ...binding, publication: { server: "https://other.example" } });
  expect(first.publication).toEqual({ server: "https://blossom.example" });
  expect(first.files).toEqual(legacy.files);
  expect(first.proposalSha256).toBe(legacy.proposalSha256);
  expect(first.jobId).not.toBe(legacy.jobId);
  expect(first.jobId).not.toBe(changed.jobId);
  expect(() => assertMountedSourceBuildPlan(first, { ...binding, publication: changed.publication })).toThrow("PRODUCTION_SOURCE_BUILD_PLAN_BINDING_REQUIRED");
  for (const server of ["http://blossom.example", "https://user@blossom.example", "https://blossom.example/path", "https://blossom.example?token=x", "https://blossom.example#fragment"]) expect(() => materializeMountedSourceBuildPlan({ ...binding, publication: { server } })).toThrow();
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
