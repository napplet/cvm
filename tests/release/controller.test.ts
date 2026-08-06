import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReleaseCertificationController, runReleaseCertification } from "../../src/release/controller";
import { canonicalJson } from "../../src/promotion/schema";
import { createReleaseProviderRegistry, type ReleaseAuthorizationReceipt } from "../../src/release/providers";
import { RELEASE_PROVIDER_IDS } from "../../src/release/topology";

const repositoryRoot = join(import.meta.dir, "..", "..");
const candidatePath = join(repositoryRoot, "toolchains/candidates/initial.json");

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "napplet-cvm-release-controller-"));
}

test("dry-run reaches an authorization-required no-effect boundary and writes only resumable controller artifacts", async () => {
  const root = await workspace();
  let effects = 0;
  const result = await runReleaseCertification({ candidatePath, workspace: root, dryRun: true, providers: {
    cloud_run: { discover: async () => { effects += 1; return { capability: "unavailable", authentication: "not_configured", reasonCode: "CREDENTIALS_UNAVAILABLE" }; } },
  } });

  expect(result.exitCode).toBe(1);
  expect(result.state.status).toBe("authorization_required");
  expect(result.authorizationRequest).toBeDefined();
  expect(effects).toBe(1);
  expect(result.state.capabilities).toHaveLength(16);
  expect(result.state.capabilities.every((item) => item.capability !== "passed")).toBeTrue();
  expect(result.state.authorizationRequestSha256).toBe(result.authorizationRequest!.authorizationRequestSha256);
  expect(result.authorizationRequest!.plannedEffects.length).toBeGreaterThan(0);
  expect(result.authorizationRequest!.maximumAuthorizedCostMicros).toBeGreaterThan(0);

  const names = (await readdir(root, { recursive: true })).filter((name) => name.endsWith(".json"));
  expect(names).toContain(`authorization-requests/${result.authorizationRequest!.authorizationRequestSha256}.json`);
  expect(names).toContain("current.json");
  expect(names).toContain(`states/${result.state.stateSha256}.json`);
  expect(names.filter((name) => name.startsWith("states/"))).toHaveLength(2);
  const persisted = await readFile(join(root, `authorization-requests/${result.authorizationRequest!.authorizationRequestSha256}.json`), "utf8");
  expect(persisted).not.toContain("protected_live");
  expect(persisted).not.toContain("promoted");
  expect(persisted).not.toContain("passed");
});

test("dry-run resume reuses the exact authorization request and state", async () => {
  const root = await workspace();
  const first = await runReleaseCertification({ candidatePath, workspace: root, dryRun: true, now: () => 1_000 });
  const second = await runReleaseCertification({ candidatePath, workspace: root, dryRun: true, now: () => 2_000 });

  expect(second.state.stateSha256).toBe(first.state.stateSha256);
  expect(second.authorizationRequest!.authorizationRequestSha256).toBe(first.authorizationRequest!.authorizationRequestSha256);
  expect(canonicalJson(second)).toBe(canonicalJson(first));
});

test("authorization-required state rejects candidate reuse, request tampering, and conflicting writers", async () => {
  const root = await workspace();
  const first = await runReleaseCertification({ candidatePath, workspace: root, dryRun: true, now: () => 1_000 });
  const candidate = JSON.parse(await readFile(candidatePath, "utf8")) as Record<string, unknown>;
  const changedCandidatePath = join(root, "changed-candidate.json");
  await writeFile(changedCandidatePath, `${JSON.stringify({ ...candidate, reviewScope: "changed" })}\n`);
  await expect(runReleaseCertification({ candidatePath: changedCandidatePath, workspace: root, dryRun: true })).rejects.toThrow("RELEASE_CONTROLLER_CANDIDATE_MISMATCH");

  const requestPath = join(root, "authorization-requests", `${first.authorizationRequest!.authorizationRequestSha256}.json`);
  await writeFile(requestPath, "{}\n");
  await expect(new ReleaseCertificationController({ candidatePath, workspace: root }).status()).rejects.toThrow("RELEASE_CONTROLLER_AUTHORIZATION_INVALID");

  const concurrent = await workspace();
  const [left, right] = await Promise.all([
    runReleaseCertification({ candidatePath, workspace: concurrent, dryRun: true, now: () => 1_000 }),
    runReleaseCertification({ candidatePath, workspace: concurrent, dryRun: true, now: () => 1_000 }),
  ]);
  expect(left.state.stateSha256).toBe(right.state.stateSha256);
});

test("discovery serializes only finite redacted digest facts", async () => {
  const root = await workspace();
  const result = await runReleaseCertification({ candidatePath, workspace: root, dryRun: true, providers: {
    modal: { discover: async () => ({
      capability: "available",
      authentication: "authorized",
      reasonCode: "AUTHORIZATION_REQUIRED",
      accountScopeSha256: "a".repeat(64),
      costEstimateSha256: "b".repeat(64),
      nativeError: "provider-native-error-with-secret",
      token: "provider-token-canary",
    } as never) },
  } });
  const modal = result.state.capabilities.find((item) => item.provider === "modal")!;
  expect(modal).toEqual(expect.objectContaining({ capability: "unavailable", reasonCode: "CAPABILITY_UNAVAILABLE" }));
  const persisted = await readFile(join(root, "states", `${result.state.stateSha256}.json`), "utf8");
  expect(persisted).not.toContain("provider-native-error-with-secret");
  expect(persisted).not.toContain("provider-token-canary");
});

test("authorization-required state requires an intact monotonic prior discovery state", async () => {
  const root = await workspace();
  const result = await runReleaseCertification({ candidatePath, workspace: root, dryRun: true, now: () => 1_000 });
  await writeFile(join(root, "states", `${result.state.priorStateSha256}.json`), "{}\n");
  await expect(new ReleaseCertificationController({ candidatePath, workspace: root }).status()).rejects.toThrow("RELEASE_CONTROLLER_STATE_INVALID");
});

test("authorized provider execution records one exact deployed topology and resumes without duplicate mutations", async () => {
  const root = await workspace();
  const dryRun = await runReleaseCertification({ candidatePath, workspace: root, dryRun: true, now: () => 1_000 });
  const effects: string[] = [];
  const registry = createReleaseProviderRegistry({
    now: () => 1_000,
    ports: Object.fromEntries(RELEASE_PROVIDER_IDS.map((provider) => [provider, {
      discoverCapabilities: async () => ({ capability: "available" as const }),
      discoverAuthentication: async () => ({ authentication: "authorized" as const }),
      plan: async () => ({ status: "planned" as const, estimatedCostMicros: 1 }),
      apply: async (input: { operationId: string }) => { effects.push(input.operationId); return { status: "applied" as const, actualCostMicros: 1, resourceIdentity: `${provider}:${input.operationId}` }; },
      observe: async (input: { operationId: string }) => ({ status: "completed" as const, actualCostMicros: 1, resourceIdentity: `${provider}:${input.operationId}` }),
      cleanup: async () => ({ status: "cleaned" as const, actualCostMicros: 0 }),
    }])) as never,
  });
  const receipt: ReleaseAuthorizationReceipt = {
    version: 1,
    authorizationRequestSha256: dryRun.authorizationRequest.authorizationRequestSha256,
    authorizationReceiptSha256: "a".repeat(64),
    candidateSha256: dryRun.state.candidate.candidateSha256,
    topologySha256: dryRun.state.topologySha256,
    effectPlanSha256: dryRun.authorizationRequest.effectPlanSha256,
    maximumAuthorizedCostMicros: dryRun.authorizationRequest.maximumAuthorizedCostMicros,
    expiresAtMs: 10_000,
  };

  const controller = new ReleaseCertificationController({ candidatePath, workspace: root, now: () => 1_000 });
  const first = await controller.provision({ receipt, registry });
  expect(first.state.status).toBe("topology_ready");
  expect(first.topology.deployment.resources).toHaveLength(16);
  expect(first.topology.deployment.availability.limitations).toContain("DATABASE_CONTINUITY_NOT_CERTIFIED");
  expect(effects).toHaveLength(16);

  const resumed = await new ReleaseCertificationController({ candidatePath, workspace: root, now: () => 2_000 }).provision({ receipt, registry });
  expect(resumed.topology.topologySha256).toBe(first.topology.topologySha256);
  expect(effects).toHaveLength(16);
});
