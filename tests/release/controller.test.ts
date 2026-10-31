import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { prepareReleaseWorkspace, ReleaseCertificationController, runReleaseCertification } from "../../src/release/controller";
import { createAuthorizationReceipt, createAuthorizationRequest, validateAuthorizationReceipt } from "../../src/release/authorization";
import { canonicalJson } from "../../src/promotion/schema";
import { createReleaseProviderRegistry, type ReleaseAuthorizationReceipt } from "../../src/release/providers";
import { RELEASE_PROVIDER_IDS } from "../../src/release/topology";
import { observeUploadedCollectorRegistryImage } from "../../src/release/collector-image";

const repositoryRoot = join(import.meta.dir, "..", "..");
const candidatePath = join(repositoryRoot, "toolchains/candidates/initial.json");

async function workspace(): Promise<string> {
  const root = join(repositoryRoot, ".runtime", "release-certification", "native-discovery-v1", "controller-tests");
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, "napplet-cvm-release-controller-"));
}

const contentDigest = (value: unknown) => new Bun.CryptoHasher("sha256").update(canonicalJson(value)).digest("hex");

async function currentStateSha(root: string): Promise<string> {
  const pointer = JSON.parse(await readFile(join(root, "current.json"), "utf8")) as { stateSha256: string };
  let stateSha256 = pointer.stateSha256;
  while (true) {
    try { stateSha256 = (JSON.parse(await readFile(join(root, "state-transitions", `${stateSha256}.json`), "utf8")) as { nextStateSha256: string }).nextStateSha256; }
    catch { return stateSha256; }
  }
}

async function replaceBoundOperationRecord(input: Readonly<{ root: string; operationId: string; mutate: (record: Record<string, unknown>) => Record<string, unknown> }>): Promise<string> {
  const state = JSON.parse(await readFile(join(input.root, "states", `${await currentStateSha(input.root)}.json`), "utf8")) as Record<string, unknown>;
  const operationIds = state.providerOperationIds as string[];
  const recordDigests = [...(state.providerOperationRecordSha256s as string[])];
  const index = operationIds.indexOf(input.operationId);
  if (index < 0) throw new Error("TEST_OPERATION_MISSING");
  const record = JSON.parse(await readFile(join(input.root, "provider-operation-records", `${recordDigests[index]}.json`), "utf8")) as Record<string, unknown>;
  const { recordSha256: _recordSha256, ...recordBase } = input.mutate(record);
  const nextRecordSha256 = contentDigest(recordBase);
  await writeFile(join(input.root, "provider-operation-records", `${nextRecordSha256}.json`), `${canonicalJson({ ...recordBase, recordSha256: nextRecordSha256 })}\n`);
  recordDigests[index] = nextRecordSha256;
  const { stateSha256: _stateSha256, ...stateBase } = state;
  const nextStateBase = { ...stateBase, providerOperationRecordSha256s: recordDigests };
  const nextStateSha256 = contentDigest(nextStateBase);
  await writeFile(join(input.root, "states", `${nextStateSha256}.json`), `${canonicalJson({ ...nextStateBase, stateSha256: nextStateSha256 })}\n`);
  const pointerBase = { version: 1, stateSha256: nextStateSha256, candidateSha256: (state.candidate as Record<string, string>).candidateSha256! };
  await writeFile(join(input.root, "current.json"), `${canonicalJson({ ...pointerBase, pointerSha256: contentDigest(pointerBase) })}\n`);
  return nextRecordSha256;
}

async function observedCollector() {
  const digest = "c".repeat(64);
  return observeUploadedCollectorRegistryImage({
    plannedRegistryReference: `registry.example/napplet-cvm/collector@sha256:${digest}`,
    registryAvailability: "not_uploaded", localOciManifestDigest: `sha256:${digest}`, localOciConfigDigest: `sha256:${"d".repeat(64)}`,
    platform: { os: "linux", architecture: "amd64" }, baseImage: `otel/opentelemetry-collector@sha256:${"e".repeat(64)}`,
    dockerfileSha256: "f".repeat(64), collectorConfigSha256: "a".repeat(64), ociLayoutPath: "/tmp/collector.oci.tar", ociLayoutSha256: "b".repeat(64),
  }, { async observeUploadedManifest(input) { return { ...input, observedAtMs: 1 }; } });
}

test("authorization receipt integrity rejects changed scope, expired receipt, and cost ceiling tampering before effects", async () => {
  const request = await createAuthorizationRequest({
    candidateSha256: "a".repeat(64),
    topologySha256: "b".repeat(64),
    effectPlanSha256: "c".repeat(64),
    controllerStateSha256: "d".repeat(64),
    providerCapabilitiesSha256: "e".repeat(64),
    orderedEffects: [{ id: "cloud-run-ingress", provider: "cloud_run", operation: "create_or_update", estimatedCostMicros: 5_000_000 }],
    providerScopes: [{ provider: "cloud_run", accountScopeSha256: "f".repeat(64), projectScopeSha256: "1".repeat(64) }],
    estimate: { currency: "USD", maximumMicros: 5_000_000, sourceId: "release-topology-v1", observedAtMs: 1_000, freshUntilMs: 3_000 },
    maximumRunDurationMs: 60_000,
    cleanupByMs: 1_500,
    evidenceRetentionDays: 30,
    artifactRetentionDays: 30,
    gcpEffects: { projectBootstrap: true, billing: true, apiEnablement: ["run.googleapis.com"] },
    expiresAtMs: 2_000,
  });
  const receipt = await createAuthorizationReceipt(request);

  await expect(validateAuthorizationReceipt({ request, receipt, nowMs: 1_999 })).resolves.toEqual(receipt);
  await expect(validateAuthorizationReceipt({
    request: { ...request, providerScopes: [{ ...request.providerScopes[0]!, accountScopeSha256: "9".repeat(64) }] },
    receipt,
    nowMs: 1_999,
  })).rejects.toThrow("RELEASE_AUTHORIZATION_REQUEST_INVALID");
  await expect(validateAuthorizationReceipt({ request, receipt, nowMs: request.expiresAtMs })).rejects.toThrow("RELEASE_AUTHORIZATION_RECEIPT_EXPIRED");
  await expect(validateAuthorizationReceipt({
    request: { ...request, maximumAuthorizedCostMicros: request.maximumAuthorizedCostMicros + 1 },
    receipt,
    nowMs: 1_999,
  })).rejects.toThrow("RELEASE_AUTHORIZATION_COST_MISMATCH");
  await expect(validateAuthorizationReceipt({
    request,
    receipt: { ...receipt, candidateSha256: "9".repeat(64) },
    nowMs: 1_999,
  })).rejects.toThrow("RELEASE_AUTHORIZATION_RECEIPT_INVALID");
});

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
  expect(result.state.capabilities.every((item) => item.capability === "unavailable" || item.capability === "unsupported")).toBeTrue();
  expect(result.state.authorizationRequestSha256).toBe(result.authorizationRequest!.authorizationRequestSha256);
  expect(result.authorizationRequest!.orderedEffects.length).toBeGreaterThan(0);
  expect(result.authorizationRequest!.maximumAuthorizedCostMicros).toBeGreaterThan(0);

  const names = (await readdir(root, { recursive: true })).filter((name) => name.endsWith(".json"));
  expect(names).toContain(`authorization-requests/${result.authorizationRequest!.authorizationRequestSha256}.json`);
  expect(names).toContain("current.json");
  expect(names).toContain(`states/${result.state.stateSha256}.json`);
  expect(names.filter((name) => name.startsWith("states/"))).toHaveLength(2);
  const persisted = await readFile(join(root, `authorization-requests/${result.authorizationRequest!.authorizationRequestSha256}.json`), "utf8");
  expect(persisted).not.toContain("protected_live");
  expect(persisted).not.toContain('"status":"promoted"');
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

test("controller persists one structured loopback consent receipt without provider effects", async () => {
  const root = await workspace();
  let consentLaunches = 0;
  let providerEffects = 0;
  const controller = new ReleaseCertificationController({
    candidatePath,
    workspace: root,
    now: () => 1_000,
    providers: { cloud_run: { discover: async () => { providerEffects += 1; return { capability: "unavailable", authentication: "not_configured", reasonCode: "CREDENTIALS_UNAVAILABLE" }; } } },
    consent: {
      async launch({ authorizationRequest }) {
        consentLaunches += 1;
        return {
          approvalChannel: "loopback_fixture",
          approverPrincipalSha256: "f".repeat(64),
          consentSessionReferences: ["loopback:consent:session-01"],
          approvedAtMs: 1_000,
          expiresAtMs: authorizationRequest.expiresAtMs,
        };
      },
    },
  });
  await controller.dryRun();
  const receipt = await controller.launchOfficialConsent();
  expect(consentLaunches).toBe(1);
  expect(providerEffects).toBe(1);
  expect(receipt).toEqual(expect.objectContaining({ approvalChannel: "loopback_fixture", consentSessionReferences: ["loopback:consent:session-01"] }));
  expect(await readFile(join(root, "authorization-receipts", `${receipt.authorizationReceiptSha256}.json`), "utf8")).not.toContain("token");
});

test("changed gcloud scope or revoked ADC regenerate the pending authorization request without workspace deletion", async () => {
  const root = await workspace();
  const first = await runReleaseCertification({ candidatePath, workspace: root, dryRun: true, providers: {
    cloud_run: { discover: async () => ({ capability: "available", authentication: "authorized", accountScopeSha256: "a".repeat(64), costEstimateSha256: "b".repeat(64), secretReferenceNames: ["gcloud-adc"], reasonCode: "AVAILABLE" }) },
  }, now: () => 1_000 });
  const second = await runReleaseCertification({ candidatePath, workspace: root, dryRun: true, providers: {
    cloud_run: { discover: async () => ({ capability: "available", authentication: "authorized", accountScopeSha256: "c".repeat(64), costEstimateSha256: "d".repeat(64), secretReferenceNames: ["gcloud-adc"], reasonCode: "AVAILABLE" }) },
  }, now: () => 2_000 });

  expect(second.state.stateSha256).not.toBe(first.state.stateSha256);
  expect(second.authorizationRequest.authorizationRequestSha256).not.toBe(first.authorizationRequest.authorizationRequestSha256);
  expect(second.state.capabilities.find((item) => item.provider === "cloud_run")).toEqual(expect.objectContaining({ accountScopeSha256: "c".repeat(64), costEstimateSha256: "d".repeat(64), secretReferenceNames: ["gcloud-adc"] }));
  const revoked = await runReleaseCertification({ candidatePath, workspace: root, dryRun: true, providers: {
    cloud_run: { discover: async () => ({ capability: "available", authentication: "not_configured", reasonCode: "AUTHORIZATION_REQUIRED" }) },
  }, now: () => 3_000 });
  expect(revoked.state.stateSha256).not.toBe(second.state.stateSha256);
  expect(revoked.state.capabilities.find((item) => item.provider === "cloud_run")).toEqual(expect.objectContaining({ authentication: "not_configured", accountScopeSha256: "0".repeat(64) }));
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
  const concurrentResults = await Promise.all(Array.from({ length: 8 }, () =>
    runReleaseCertification({ candidatePath, workspace: concurrent, dryRun: true, now: () => 1_000 }),
  ));
  expect(new Set(concurrentResults.map((result) => result.state.stateSha256)).size).toBe(1);
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
  const collectorImage = await observedCollector();
  const dryRun = await runReleaseCertification({ candidatePath, workspace: root, dryRun: true, now: () => 1_000, collectorImage });
  const effects: string[] = [];
  const registry = createReleaseProviderRegistry({
    now: () => 1_000,
    ports: Object.fromEntries(RELEASE_PROVIDER_IDS.map((provider) => [provider, {
      discoverCapabilities: async () => ({ capability: "available" as const }),
      discoverAuthentication: async () => ({ authentication: "authorized" as const }),
      plan: async () => ({ status: "planned" as const, estimatedCostMicros: 1 }),
      apply: async (input: { operationId: string }) => { effects.push(input.operationId); return { status: "applied" as const, resourceIdentity: `${provider}:${input.operationId}` }; },
      observe: async (input: { operationId: string }) => ({ status: "completed" as const, resourceIdentity: `${provider}:${input.operationId}` }),
      cleanup: async () => ({ status: "cleaned" as const }),
    }])) as never,
  });
  const receipt = await createAuthorizationReceipt(dryRun.authorizationRequest);

  const controller = new ReleaseCertificationController({ candidatePath, workspace: root, now: () => 1_000, collectorImage });
  const first = await controller.provision({ receipt, registry });
  expect(first.state.status).toBe("topology_ready");
  expect(first.topology.deployment.resources).toHaveLength(16);
  expect(first.topology.deployment.limitations).toContain("DATABASE_CONTINUITY_NOT_CERTIFIED");
  expect(effects).toHaveLength(16);

  const resumed = await new ReleaseCertificationController({ candidatePath, workspace: root, now: () => 2_000, collectorImage }).provision({ receipt, registry });
  expect(resumed.topology.topologySha256).toBe(first.topology.topologySha256);
  expect(effects).toHaveLength(16);
});

test("resource completion holds each original provider reservation until an actual bill is observed", async () => {
  const root = await workspace();
  const collectorImage = await observedCollector();
  const dryRun = await runReleaseCertification({ candidatePath, workspace: root, dryRun: true, now: () => 1_000, collectorImage });
  const applies: string[] = [];
  const registry = createReleaseProviderRegistry({
    now: () => 1_000,
    ports: Object.fromEntries(RELEASE_PROVIDER_IDS.map((provider) => [provider, {
      discoverCapabilities: async () => ({ capability: "available" as const }),
      discoverAuthentication: async () => ({ authentication: "authorized" as const }),
      plan: async () => ({ status: "planned" as const, estimatedCostMicros: 1 }),
      apply: async (input: { operationId: string }) => { applies.push(input.operationId); return { status: "applied" as const, resourceIdentity: `${provider}:${input.operationId}` }; },
      observe: async (input: { operationId: string }) => ({ status: "completed" as const, resourceIdentity: `${provider}:${input.operationId}` }),
      cleanup: async () => ({ status: "cleaned" as const }),
    }])) as never,
  });
  const receipt = await createAuthorizationReceipt(dryRun.authorizationRequest);
  const first = await new ReleaseCertificationController({ candidatePath, workspace: root, now: () => 1_000, collectorImage }).provision({ receipt, registry });
  expect(first.state.status).toBe("topology_ready");
  expect(applies).toHaveLength(RELEASE_PROVIDER_IDS.length);

  const records = await Promise.all(first.state.providerOperationRecordSha256s!.map(async (recordSha256) => JSON.parse(await readFile(join(root, "provider-operation-records", `${recordSha256}.json`), "utf8"))));
  expect(records).toHaveLength(RELEASE_PROVIDER_IDS.length);
  expect(records.every((record) => record.version === 3 && record.status === "completed" && record.billingStatus === "unknown" && record.actualCostMicros === null)).toBeTrue();
  expect(records.reduce((total, record) => total + record.reservedCostMicros, 0)).toBe(dryRun.authorizationRequest.maximumAuthorizedCostMicros);
  for (const record of records) {
    const effect = dryRun.authorizationRequest.orderedEffects.find((item) => item.id === record.operation.effectId && item.provider === record.operation.provider);
    expect(record.reservedCostMicros).toBe(effect!.estimatedCostMicros);
  }

  await new ReleaseCertificationController({ candidatePath, workspace: root, now: () => 2_000, collectorImage }).provision({ receipt, registry });
  expect(applies).toHaveLength(RELEASE_PROVIDER_IDS.length);
});

test("raw provider amounts cannot settle a held reservation", async () => {
  const root = await workspace();
  const collectorImage = await observedCollector();
  const dryRun = await runReleaseCertification({ candidatePath, workspace: root, dryRun: true, now: () => 1_000, collectorImage });
  const registry = createReleaseProviderRegistry({
    now: () => 1_000,
    ports: Object.fromEntries(RELEASE_PROVIDER_IDS.map((provider) => [provider, {
      discoverCapabilities: async () => ({ capability: "available" as const }),
      discoverAuthentication: async () => ({ authentication: "authorized" as const }),
      plan: async () => ({ status: "planned" as const, estimatedCostMicros: 1 }),
      apply: async () => ({ status: "applied" as const, actualCostMicros: 1, resourceIdentity: provider }),
      observe: async () => ({ status: "completed" as const, resourceIdentity: provider }),
      cleanup: async () => ({ status: "cleaned" as const }),
    }])) as never,
  });
  const receipt = await createAuthorizationReceipt(dryRun.authorizationRequest);

  await expect(new ReleaseCertificationController({ candidatePath, workspace: root, now: () => 1_000, collectorImage }).provision({ receipt, registry })).rejects.toThrow("RELEASE_PROVIDER_COST_OBSERVATION_REQUIRED");
  const records = await readdir(join(root, "provider-operations"));
  expect(records).toHaveLength(RELEASE_PROVIDER_IDS.length);
  const first = JSON.parse(await readFile(join(root, "provider-operations", records[0]!), "utf8"));
  expect(first).toEqual(expect.objectContaining({ version: 3, billingStatus: "unknown", actualCostMicros: null, costObservationSha256: null, priorRecordSha256: null }));
});

test("a syntactically valid generic provider report cannot settle a held reservation", async () => {
  const root = await workspace();
  const collectorImage = await observedCollector();
  const dryRun = await runReleaseCertification({ candidatePath, workspace: root, dryRun: true, now: () => 1_000, collectorImage });
  const registry = createReleaseProviderRegistry({
    now: () => 1_000,
    ports: Object.fromEntries(RELEASE_PROVIDER_IDS.map((provider) => [provider, {
      discoverCapabilities: async () => ({ capability: "available" as const }),
      discoverAuthentication: async () => ({ authentication: "authorized" as const }),
      plan: async () => ({ status: "planned" as const, estimatedCostMicros: 1 }),
      apply: async (input: { operationId: string }) => ({
        status: "applied" as const, actualCostMicros: 1, resourceIdentitySha256: "a".repeat(64),
        costObservation: {
          version: 1 as const, provider, operationId: input.operationId,
          candidateSha256: "b".repeat(64), authorizationRequestSha256: "c".repeat(64), resourceIdentitySha256: "a".repeat(64),
          accountScopeSha256: "d".repeat(64), projectScopeSha256: "e".repeat(64), rawReportSha256: "f".repeat(64),
          intervalStartMs: 1, intervalEndMs: 2, observedAtMs: 2, actualCostMicros: 1,
        },
      }),
      observe: async () => ({ status: "completed" as const, resourceIdentitySha256: "a".repeat(64) }),
      cleanup: async () => ({ status: "cleaned" as const }),
    }])) as never,
  });
  const receipt = await createAuthorizationReceipt(dryRun.authorizationRequest);

  await expect(new ReleaseCertificationController({ candidatePath, workspace: root, now: () => 1_000, collectorImage }).provision({ receipt, registry })).rejects.toThrow("RELEASE_PROVIDER_COST_REPORT_TRANSPORT_UNAVAILABLE");
  const records = await readdir(join(root, "provider-operations"));
  const first = JSON.parse(await readFile(join(root, "provider-operations", records[0]!), "utf8"));
  expect(first).toEqual(expect.objectContaining({ version: 3, billingStatus: "unknown", actualCostMicros: null, costObservationSha256: null, priorRecordSha256: null }));
});

test("ambiguous provider execution resumes by observing the original operation without protected evidence writes", async () => {
  const root = await workspace();
  const collectorImage = await observedCollector();
  const dryRun = await runReleaseCertification({ candidatePath, workspace: root, dryRun: true, now: () => 1_000, collectorImage });
  let modalApplies = 0;
  let modalObserves = 0;
  let protectedEvidenceWrites = 0;
  const registry = createReleaseProviderRegistry({
    now: () => 1_000,
    ports: Object.fromEntries(RELEASE_PROVIDER_IDS.map((provider) => [provider, {
      discoverCapabilities: async () => ({ capability: "available" as const }),
      discoverAuthentication: async () => ({ authentication: "authorized" as const }),
      plan: async () => ({ status: "planned" as const, estimatedCostMicros: 1 }),
      apply: async (input: { operationId: string }) => {
        if (provider === "modal") { modalApplies += 1; return { status: "unknown" as const }; }
        return { status: "applied" as const, resourceIdentity: `${provider}:${input.operationId}` };
      },
      observe: async (input: { operationId: string }) => {
        if (provider === "modal") modalObserves += 1;
        return { status: "completed" as const, resourceIdentity: `${provider}:${input.operationId}` };
      },
      cleanup: async () => ({ status: "cleaned" as const }),
    }])) as never,
  });
  const receipt = await createAuthorizationReceipt(dryRun.authorizationRequest);

  await expect(new ReleaseCertificationController({ candidatePath, workspace: root, now: () => 1_000, collectorImage }).provision({ receipt, registry })).rejects.toThrow("RELEASE_CONTROLLER_PROVIDER_AMBIGUOUS");
  const resumed = await new ReleaseCertificationController({ candidatePath, workspace: root, now: () => 2_000, collectorImage }).provision({ receipt, registry });
  expect(resumed.state.status).toBe("topology_ready");
  expect(modalApplies).toBe(1);
  expect(modalObserves).toBe(1);
  expect(protectedEvidenceWrites).toBe(0);
});

test("resume rederives each reservation and scope from the immutable authorization before provider calls", async () => {
  for (const mutate of [
    (record: Record<string, unknown>) => ({ ...record, reservedCostMicros: (record.reservedCostMicros as number) + 1 }),
    (record: Record<string, unknown>) => ({ ...record, accountScopeSha256: "a".repeat(64) }),
    (record: Record<string, unknown>) => ({ ...record, projectScopeSha256: "b".repeat(64) }),
  ]) {
    const root = await workspace();
    const collectorImage = await observedCollector();
    const dryRun = await runReleaseCertification({ candidatePath, workspace: root, dryRun: true, now: () => 1_000, collectorImage });
    let resumedCalls = 0;
    const registry = createReleaseProviderRegistry({
      now: () => 1_000,
      ports: Object.fromEntries(RELEASE_PROVIDER_IDS.map((provider) => [provider, {
        discoverCapabilities: async () => ({ capability: "available" as const }),
        discoverAuthentication: async () => ({ authentication: "authorized" as const }),
        plan: async () => { resumedCalls += 1; return { status: "planned" as const, estimatedCostMicros: 1 }; },
        apply: async (input: { operationId: string }) => provider === "modal" ? { status: "unknown" as const } : { status: "applied" as const, resourceIdentity: `${provider}:${input.operationId}` },
        observe: async (input: { operationId: string }) => { resumedCalls += 1; return { status: "completed" as const, resourceIdentity: `${provider}:${input.operationId}` }; },
        cleanup: async () => ({ status: "cleaned" as const }),
      }])) as never,
    });
    const receipt = await createAuthorizationReceipt(dryRun.authorizationRequest);
    await expect(new ReleaseCertificationController({ candidatePath, workspace: root, now: () => 1_000, collectorImage }).provision({ receipt, registry })).rejects.toThrow("RELEASE_CONTROLLER_PROVIDER_AMBIGUOUS");
    resumedCalls = 0;
    const resolved = await new ReleaseCertificationController({ candidatePath, workspace: root, now: () => 2_000, collectorImage }).status();
    const state = JSON.parse(await readFile(join(root, "states", `${resolved!.state.stateSha256}.json`), "utf8")) as { providerOperationIds: string[]; providerOperationRecordSha256s: string[] };
    const records = await Promise.all(state.providerOperationRecordSha256s.map(async (recordSha256) => JSON.parse(await readFile(join(root, "provider-operation-records", `${recordSha256}.json`), "utf8")) as Record<string, unknown>));
    const modalIndex = records.findIndex((record) => (record.operation as { provider: string }).provider === "modal");
    await replaceBoundOperationRecord({ root, operationId: state.providerOperationIds[modalIndex]!, mutate });
    await expect(new ReleaseCertificationController({ candidatePath, workspace: root, now: () => 2_000, collectorImage }).provision({ receipt, registry })).rejects.toThrow("RELEASE_CONTROLLER_COST_RESERVATION_INVALID");
    expect(resumedCalls).toBe(0);
  }
});

test("a forged persisted report is cleared on generic reconciliation and cannot become observed", async () => {
  const root = await workspace();
  const collectorImage = await observedCollector();
  const dryRun = await runReleaseCertification({ candidatePath, workspace: root, dryRun: true, now: () => 1_000, collectorImage });
  const registry = createReleaseProviderRegistry({
    now: () => 1_000,
    ports: Object.fromEntries(RELEASE_PROVIDER_IDS.map((provider) => [provider, {
      discoverCapabilities: async () => ({ capability: "available" as const }), discoverAuthentication: async () => ({ authentication: "authorized" as const }),
      plan: async () => ({ status: "planned" as const, estimatedCostMicros: 1 }),
      apply: async (input: { operationId: string }) => provider === "modal" ? { status: "unknown" as const } : { status: "applied" as const, resourceIdentity: `${provider}:${input.operationId}` },
      observe: async (input: { operationId: string }) => ({ status: "completed" as const, resourceIdentity: `${provider}:${input.operationId}` }), cleanup: async () => ({ status: "cleaned" as const }),
    }])) as never,
  });
  const receipt = await createAuthorizationReceipt(dryRun.authorizationRequest);
  await expect(new ReleaseCertificationController({ candidatePath, workspace: root, now: () => 1_000, collectorImage }).provision({ receipt, registry })).rejects.toThrow("RELEASE_CONTROLLER_PROVIDER_AMBIGUOUS");
  const resolved = await new ReleaseCertificationController({ candidatePath, workspace: root, now: () => 2_000, collectorImage }).status();
  const state = JSON.parse(await readFile(join(root, "states", `${resolved!.state.stateSha256}.json`), "utf8")) as { providerOperationIds: string[]; providerOperationRecordSha256s: string[] };
  const records = await Promise.all(state.providerOperationRecordSha256s.map(async (recordSha256) => JSON.parse(await readFile(join(root, "provider-operation-records", `${recordSha256}.json`), "utf8")) as Record<string, unknown>));
  const index = records.findIndex((record) => (record.operation as { provider: string }).provider === "modal");
  await replaceBoundOperationRecord({
    root, operationId: state.providerOperationIds[index]!,
    mutate: (record) => {
      const operation = record.operation as { provider: string; operationId: string; candidateSha256: string; authorizationRequestSha256: string };
      const observation = { version: 1, provider: operation.provider, operationId: operation.operationId, candidateSha256: operation.candidateSha256, authorizationRequestSha256: operation.authorizationRequestSha256, resourceIdentitySha256: "c".repeat(64), accountScopeSha256: record.accountScopeSha256, projectScopeSha256: record.projectScopeSha256, rawReportSha256: "d".repeat(64), intervalStartMs: 1, intervalEndMs: 2, observedAtMs: 2, actualCostMicros: 0 };
      return { ...record, billingStatus: "observed", actualCostMicros: 0, costObservation: observation, costObservationSha256: contentDigest(observation) };
    },
  });
  const resumed = await new ReleaseCertificationController({ candidatePath, workspace: root, now: () => 2_000, collectorImage }).provision({ receipt, registry });
  const modalRecord = JSON.parse(await readFile(join(root, "provider-operation-records", `${resumed.state.providerOperationRecordSha256s![index]}.json`), "utf8"));
  expect(modalRecord).toEqual(expect.objectContaining({ billingStatus: "unknown", actualCostMicros: null, costObservation: null, costObservationSha256: null }));
});

test("a lost apply acknowledgement resumes by observing the original durable dispatch claim", async () => {
  const root = await workspace();
  const collectorImage = await observedCollector();
  const dryRun = await runReleaseCertification({ candidatePath, workspace: root, dryRun: true, now: () => 1_000, collectorImage });
  let modalApplies = 0;
  let modalDispatched = false;
  const registry = createReleaseProviderRegistry({
    now: () => 1_000,
    ports: Object.fromEntries(RELEASE_PROVIDER_IDS.map((provider) => [provider, {
      discoverCapabilities: async () => ({ capability: "available" as const }), discoverAuthentication: async () => ({ authentication: "authorized" as const }),
      plan: async () => ({ status: "planned" as const, estimatedCostMicros: 1 }),
      apply: async (input: { operationId: string }) => {
        if (provider === "modal") { modalApplies += 1; modalDispatched = true; throw new Error("ACK_LOST_AFTER_EFFECT"); }
        return { status: "applied" as const, resourceIdentity: `${provider}:${input.operationId}` };
      },
      observe: async (input: { operationId: string }) => provider === "modal" && modalDispatched
        ? { status: "completed" as const, resourceIdentity: `${provider}:${input.operationId}` }
        : { status: "completed" as const, resourceIdentity: `${provider}:${input.operationId}` },
      cleanup: async () => ({ status: "cleaned" as const }),
    }])) as never,
  });
  const receipt = await createAuthorizationReceipt(dryRun.authorizationRequest);
  await expect(new ReleaseCertificationController({ candidatePath, workspace: root, now: () => 1_000, collectorImage }).provision({ receipt, registry })).rejects.toThrow("ACK_LOST_AFTER_EFFECT");
  const resumed = await new ReleaseCertificationController({ candidatePath, workspace: root, now: () => 2_000, collectorImage }).provision({ receipt, registry });
  expect(resumed.state.status).toBe("topology_ready");
  expect(modalApplies).toBe(1);
});

test("two controllers claim one pending operation and the loser only observes it", async () => {
  const root = await workspace();
  const collectorImage = await observedCollector();
  const dryRun = await runReleaseCertification({ candidatePath, workspace: root, dryRun: true, now: () => 1_000, collectorImage });
  let modalApplies = 0;
  let releaseApply: (() => void) | undefined;
  const applyReleased = new Promise<void>((resolve) => { releaseApply = resolve; });
  let signalApply: (() => void) | undefined;
  const applyStarted = new Promise<void>((resolve) => { signalApply = resolve; });
  const registry = createReleaseProviderRegistry({
    now: () => 1_000,
    ports: Object.fromEntries(RELEASE_PROVIDER_IDS.map((provider) => [provider, {
      discoverCapabilities: async () => ({ capability: "available" as const }), discoverAuthentication: async () => ({ authentication: "authorized" as const }),
      plan: async () => ({ status: "planned" as const, estimatedCostMicros: 1 }),
      apply: async (input: { operationId: string }) => {
        if (provider === "modal") { modalApplies += 1; signalApply!(); await applyReleased; }
        return { status: "applied" as const, resourceIdentity: `${provider}:${input.operationId}` };
      },
      observe: async (input: { operationId: string }) => {
        if (provider === "modal") { releaseApply!(); return { status: "pending" as const }; }
        return { status: "completed" as const, resourceIdentity: `${provider}:${input.operationId}` };
      },
      cleanup: async () => ({ status: "cleaned" as const }),
    }])) as never,
  });
  const receipt = await createAuthorizationReceipt(dryRun.authorizationRequest);
  const first = new ReleaseCertificationController({ candidatePath, workspace: root, now: () => 1_000, collectorImage }).provision({ receipt, registry });
  await applyStarted;
  const second = new ReleaseCertificationController({ candidatePath, workspace: root, now: () => 1_000, collectorImage }).provision({ receipt, registry });
  await Promise.allSettled([first, second]);
  expect(modalApplies).toBe(1);
  const settledRegistry = createReleaseProviderRegistry({
    now: () => 2_000,
    ports: Object.fromEntries(RELEASE_PROVIDER_IDS.map((provider) => [provider, {
      discoverCapabilities: async () => ({ capability: "available" as const }), discoverAuthentication: async () => ({ authentication: "authorized" as const }),
      plan: async () => ({ status: "planned" as const, estimatedCostMicros: 1 }),
      apply: async (input: { operationId: string }) => {
        if (provider === "modal") throw new Error("REISSUE_FORBIDDEN");
        return { status: "applied" as const, resourceIdentity: `${provider}:${input.operationId}` };
      },
      observe: async (input: { operationId: string }) => ({ status: "completed" as const, resourceIdentity: `${provider}:${input.operationId}` }), cleanup: async () => ({ status: "cleaned" as const }),
    }])) as never,
  });
  const resumed = await new ReleaseCertificationController({ candidatePath, workspace: root, now: () => 2_000, collectorImage }).provision({ receipt, registry: settledRegistry });
  expect(resumed.state.status).toBe("topology_ready");
  expect(modalApplies).toBe(1);
});

test("metadata-sync failure prevents a durable dispatch claim from reaching apply", async () => {
  const root = await workspace();
  const collectorImage = await observedCollector();
  const dryRun = await runReleaseCertification({ candidatePath, workspace: root, dryRun: true, now: () => 1_000, collectorImage });
  let applies = 0;
  const registry = createReleaseProviderRegistry({
    now: () => 1_000,
    ports: Object.fromEntries(RELEASE_PROVIDER_IDS.map((provider) => [provider, {
      discoverCapabilities: async () => ({ capability: "available" as const }), discoverAuthentication: async () => ({ authentication: "authorized" as const }),
      plan: async () => ({ status: "planned" as const, estimatedCostMicros: 1 }),
      apply: async (input: { operationId: string }) => { applies += 1; return { status: "applied" as const, resourceIdentity: `${provider}:${input.operationId}` }; },
      observe: async (input: { operationId: string }) => ({ status: "completed" as const, resourceIdentity: `${provider}:${input.operationId}` }), cleanup: async () => ({ status: "cleaned" as const }),
    }])) as never,
  });
  const receipt = await createAuthorizationReceipt(dryRun.authorizationRequest);
  await expect(new ReleaseCertificationController({
    candidatePath, workspace: root, now: () => 1_000, collectorImage,
    syncDirectory: async (path) => {
      if (path.includes("provider-dispatch-claims")) throw new Error("METADATA_SYNC_FAILED");
    },
  }).provision({ receipt, registry })).rejects.toThrow("METADATA_SYNC_FAILED");
  expect(applies).toBe(0);
});

test("project-owned workspace preparation creates an absent authority root", async () => {
  const root = await workspace();
  await rm(root, { recursive: true, force: true });
  const result = await runReleaseCertification({ candidatePath, workspace: root, dryRun: true, now: () => 1_000 });
  expect(result.state.status).toBe("authorization_required");
  expect((await stat(root)).mode & 0o777).toBe(0o700);
  expect((await stat(join(root, "states"))).mode & 0o777).toBe(0o700);
  expect((await stat(join(root, "current.json"))).mode & 0o777).toBe(0o600);
  expect((await stat(root)).uid).toBe(process.getuid!());
  expect((await stat(join(root, "current.json"))).uid).toBe(process.getuid!());
});

test("a pre-existing group-writable workspace is rejected before provider discovery", async () => {
  const root = await workspace();
  let discoveries = 0;
  try {
    await chmod(root, 0o770);
    await expect(runReleaseCertification({
      candidatePath,
      workspace: root,
      dryRun: true,
      providers: { cloud_run: { discover: async () => { discoveries += 1; return { capability: "available", authentication: "authorized", accountScopeSha256: "a".repeat(64), costEstimateSha256: "b".repeat(64), secretReferenceNames: [], reasonCode: "AVAILABLE" }; } } },
      now: () => 1_000,
    })).rejects.toThrow("RELEASE_CONTROLLER_WORKSPACE_ANCHOR_REQUIRED");
    expect(discoveries).toBe(0);
  } finally { await chmod(root, 0o700); }
});

test("a pre-existing group-writable authority child is rejected before authority publication", async () => {
  const root = await workspace();
  try {
    await prepareReleaseWorkspace(root);
    await mkdir(join(root, "states"), { mode: 0o700 });
    await chmod(join(root, "states"), 0o770);
    await expect(runReleaseCertification({ candidatePath, workspace: root, dryRun: true, now: () => 1_000 })).rejects.toThrow("RELEASE_CONTROLLER_WORKSPACE_ANCHOR_REQUIRED");
    expect(await readdir(join(root, "states"))).toEqual([]);
  } finally { await chmod(join(root, "states"), 0o700); }
});

test("a bare existing workspace still syncs every ancestor through the filesystem root", async () => {
  const root = await workspace();
  const synced: string[] = [];
  const result = await runReleaseCertification({
    candidatePath, workspace: root, dryRun: true, now: () => 1_000,
    syncDirectory: async (path) => { synced.push(resolve(path)); },
  });
  expect(result.state.status).toBe("authorization_required");
  const canonicalRoot = await realpath(root);
  expect(synced).toContain(canonicalRoot);
  expect(synced).toContain(dirname(canonicalRoot));
  expect(synced).toContain(resolve("/"));
});

test("a multi-level workspace ancestor sync failure prevents provider apply", async () => {
  const root = await workspace();
  const nested = join(root, "new", "durable", "workspace");
  const collectorImage = await observedCollector();
  const dryRun = await runReleaseCertification({ candidatePath, workspace: nested, dryRun: true, now: () => 1_000, collectorImage });
  const failedAncestor = await realpath(join(root, "new"));
  let applies = 0;
  const registry = createReleaseProviderRegistry({
    now: () => 1_000,
    ports: Object.fromEntries(RELEASE_PROVIDER_IDS.map((provider) => [provider, {
      discoverCapabilities: async () => ({ capability: "available" as const }), discoverAuthentication: async () => ({ authentication: "authorized" as const }),
      plan: async () => ({ status: "planned" as const, estimatedCostMicros: 1 }),
      apply: async (input: { operationId: string }) => { applies += 1; return { status: "applied" as const, resourceIdentity: `${provider}:${input.operationId}` }; },
      observe: async (input: { operationId: string }) => ({ status: "completed" as const, resourceIdentity: `${provider}:${input.operationId}` }), cleanup: async () => ({ status: "cleaned" as const }),
    }])) as never,
  });
  const receipt = await createAuthorizationReceipt(dryRun.authorizationRequest);
  await expect(new ReleaseCertificationController({
    candidatePath, workspace: nested, now: () => 1_000, collectorImage,
    syncDirectory: async (path) => {
      if (resolve(path) === failedAncestor) throw new Error("MULTI_LEVEL_METADATA_SYNC_FAILED");
    },
  }).provision({ receipt, registry })).rejects.toThrow("MULTI_LEVEL_METADATA_SYNC_FAILED");
  expect(applies).toBe(0);
});

test("an in-workspace intermediate symlink cannot redirect authority creation", async () => {
  const root = await workspace();
  const outside = await mkdtemp("/tmp/napplet-cvm-workspace-escape-");
  const escaped = join(root, "redirect", "workspace");
  try {
    await symlink(outside, join(root, "redirect"));
    await expect(runReleaseCertification({ candidatePath, workspace: escaped, dryRun: true, now: () => 1_000 })).rejects.toThrow("RELEASE_CONTROLLER_WORKSPACE_ANCHOR_REQUIRED");
    expect(await readdir(outside)).toEqual([]);
  } finally { await rm(outside, { recursive: true, force: true }); }
});

test("a final workspace symlink and post-capability swap are rejected before authority writes", async () => {
  const root = await workspace();
  const outside = await mkdtemp("/tmp/napplet-cvm-workspace-escape-");
  try {
    const finalLink = join(root, "final-link");
    await symlink(outside, finalLink);
    await expect(runReleaseCertification({ candidatePath, workspace: finalLink, dryRun: true, now: () => 1_000 })).rejects.toThrow("RELEASE_CONTROLLER_WORKSPACE_ANCHOR_REQUIRED");
    const stable = join(root, "stable");
    const capability = await prepareReleaseWorkspace(stable);
    await rename(stable, join(root, "stable-moved"));
    await symlink(outside, stable);
    await expect(new ReleaseCertificationController({ candidatePath, workspace: stable, workspaceCapability: capability, now: () => 1_000 }).dryRun()).rejects.toThrow("RELEASE_CONTROLLER_WORKSPACE_ANCHOR_REQUIRED");
    expect(await readdir(outside)).toEqual([]);
  } finally { await rm(outside, { recursive: true, force: true }); }
});

test("a replaced child authority directory is rejected before controller artifacts", async () => {
  const root = await workspace();
  const outside = await mkdtemp("/tmp/napplet-cvm-authority-escape-");
  try {
    await prepareReleaseWorkspace(root);
    await symlink(outside, join(root, "states"));
    await expect(runReleaseCertification({
      candidatePath,
      workspace: root,
      dryRun: true,
      providers: { cloud_run: { discover: async () => ({ capability: "available", authentication: "authorized", accountScopeSha256: "a".repeat(64), costEstimateSha256: "b".repeat(64), secretReferenceNames: [], reasonCode: "AVAILABLE" }) } },
      now: () => 1_000,
    })).rejects.toThrow("RELEASE_CONTROLLER_WORKSPACE_ANCHOR_REQUIRED");
    expect(await readdir(outside)).toEqual([]);
  } finally { await rm(outside, { recursive: true, force: true }); }
});

test("a damaged root with prior dispatch lineage fails closed instead of issuing a fresh request", async () => {
  const root = await workspace();
  await mkdir(join(root, "provider-dispatch-claims"));
  await writeFile(join(root, "provider-dispatch-claims", "original.json"), "{}\n");
  await writeFile(join(root, "current.json"), "{\n");
  await expect(runReleaseCertification({ candidatePath, workspace: root, dryRun: true, now: () => 1_000 })).rejects.toThrow("RELEASE_CONTROLLER_RECOVERY_REQUIRED");
});
