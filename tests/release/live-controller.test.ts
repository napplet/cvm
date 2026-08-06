import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RELEASE_LIVE_CONTROLLER_STATES } from "../../src/release/contracts";
import { ReleaseCertificationController, runReleaseCertification } from "../../src/release/controller";
import { createAuthorizationReceipt } from "../../src/release/authorization";
import { createReleaseProviderRegistry } from "../../src/release/providers";
import { RELEASE_PROVIDER_IDS } from "../../src/release/topology";

const repositoryRoot = join(import.meta.dir, "..", "..");
const candidatePath = join(repositoryRoot, "toolchains/candidates/initial.json");
const digest = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");

const manifest = () => ({
  version: 1,
  releaseId: digest("release"), sourceRevision: "a".repeat(40), sourceSha256: digest("source"),
  supplyChainPolicy: { cosign: { executableSha256: digest("cosign"), signerIdentity: "issuer:identity", issuer: "https://issuer.example", predicateType: "https://slsa.dev/provenance/v1" }, sbom: { bomFormat: "CycloneDX", specVersion: "1.5", generator: { vendor: "napplet", name: "generator", version: "1" } } },
  inputs: Object.fromEntries(["controlImageDigest", "workerImageDigest", "packageLockSha256", "toolchainSha256", "migrationSha256", "configSha256", "policySha256", "datasetSha256", "goldenSha256", "sbomSha256", "provenanceSha256"].map((key) => [key, digest(key)])),
  requirements: [
    ["deterministic-fault-matrix", "release.deterministic_fault_matrix", false], ["telemetry-policy", "release.telemetry_policy", false], ["supply-chain", "release.supply_chain", false],
    ["admission-slo", "release.admission_slo", true], ["contextvm-relay", "release.contextvm_relay", true], ["cep8-lightning", "release.cep8_lightning", true], ["cashu", "release.cashu", true], ["model-reconciliation", "release.model_reconciliation", true], ["worker", "release.worker", true], ["checkpoint-object", "release.checkpoint_object", true], ["database-failover", "release.database_failover", true], ["control-plane", "release.control_plane", true], ["compatible-host", "release.compatible_host", true], ["owner-signer", "release.owner_signer", true], ["promoted-cli", "release.promoted_cli", true], ["sealed-upload", "release.sealed_upload", true], ["publication-relay", "release.publication_relay", true],
  ].map(([id, claim, live]) => ({ id, claim, freshnessMs: 1_000, live })), waivers: [],
});

test("authorized tracer keeps every versioned live boundary", () => {
  expect(RELEASE_LIVE_CONTROLLER_STATES).toEqual([
    "receipt_valid", "bootstrap", "provisioning", "observing", "materializing",
    "protected_suite_running", "finalizing", "cleaning", "blocked", "completed",
  ]);
});

test("authorized tracer rejects absent or mismatched receipt before a native effect", async () => {
  const root = await mkdtemp(join(tmpdir(), "napplet-cvm-live-controller-"));
  try {
    const initial = await runReleaseCertification({ candidatePath, workspace: root, dryRun: true, now: () => 1_000 });
    let effects = 0;
    const registry = createReleaseProviderRegistry({
      now: () => 1_000,
      ports: Object.fromEntries(RELEASE_PROVIDER_IDS.map((provider) => [provider, {
        discoverCapabilities: async () => ({ capability: "available" as const }),
        discoverAuthentication: async () => ({ authentication: "authorized" as const }),
        plan: async () => { effects += 1; return { status: "planned" as const, estimatedCostMicros: 0 }; },
        apply: async () => { effects += 1; return { status: "applied" as const, actualCostMicros: 0, resourceIdentity: provider }; },
        observe: async () => ({ status: "missing" as const, actualCostMicros: 0 }),
        cleanup: async () => ({ status: "cleaned" as const, actualCostMicros: 0 }),
      }])) as never,
    });

    await expect(new ReleaseCertificationController({ candidatePath, workspace: root, now: () => 1_000 }).executeAuthorized({
      receipt: { authorizationRequestSha256: initial.authorizationRequest.authorizationRequestSha256 },
      registry,
      materialization: {} as never,
      workerSelection: {} as never,
      protected: {} as never,
    })).rejects.toThrow("RELEASE_CONTROLLER_AUTHORIZATION_INVALID");
    expect(effects).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("all protected-suite records are retained and block finalization when real evidence is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "napplet-cvm-live-controller-"));
  try {
    const dry = await runReleaseCertification({ candidatePath, workspace: root, dryRun: true, now: () => 1_000 });
    const registry = createReleaseProviderRegistry({ now: () => 1_000, ports: Object.fromEntries(RELEASE_PROVIDER_IDS.map((provider) => [provider, {
      discoverCapabilities: async () => ({ capability: "available" as const }), discoverAuthentication: async () => ({ authentication: "authorized" as const }),
      plan: async () => ({ status: "planned" as const, estimatedCostMicros: 0 }), apply: async () => ({ status: "applied" as const, actualCostMicros: 0, resourceIdentity: provider }),
      observe: async () => ({ status: "completed" as const, actualCostMicros: 0, resourceIdentity: provider }), cleanup: async () => ({ status: "cleaned" as const, actualCostMicros: 0 }),
    }])) as never });
    const receipt = await createAuthorizationReceipt(dry.authorizationRequest);
    const controller = new ReleaseCertificationController({ candidatePath, workspace: root, now: () => 1_000 });
    const provisioned = await controller.provision({ receipt, registry });
    const candidate = { id: provisioned.state.candidate.candidateSha256, provider: "modal" as const, image: `napplet-cvm/worker@sha256:${digest("worker")}`, sourceSha256: digest("source") };
    const real = { evidenceClass: "real" as const } as never;
    await expect(controller.executeAuthorized({
      receipt, registry,
      materialization: { workspace: root, repositoryRoot, candidateId: candidate.id, releaseManifest: manifest(), source: { sourceRevision: "a".repeat(40), sourceSha256: digest("source") }, secretReferences: {} },
      workerSelection: { provider: "modal", status: "selected", candidateSha256: candidate.id, topologySha256: provisioned.topology.topologySha256, selectionEvidenceSha256: digest("selection"), observedAtMs: 1, expiresAtMs: 2_000 },
      protected: { candidate, input: { datasetSha256: digest("dataset"), profileSha256: digest("profile"), topologySha256: provisioned.topology.topologySha256, command: ["bun", "test"] }, topology: provisioned.topology, collector: { collectorDigest: `sha256:${digest("collector")}`, configSha256: digest("config") }, ports: { admission: real, telemetry: real, chaos: real, durability: real, "security-host": real, "supply-chain": real, "ContextVM-payment-model": real, publication: real } },
    })).rejects.toThrow("RELEASE_CONTROLLER_PROTECTED_SUITE_BLOCKED");
    const records = await Bun.file(join(root, "protected-records", "admission.json")).text();
    expect(records).toContain('"status":"blocked"');
    expect((await new Response(Bun.file(join(root, "protected-records", "telemetry.json"))).text()).length).toBeGreaterThan(0);
    expect((await readdir(join(root, "protected-records"))).sort()).toEqual([
      "admission.json", "chaos.json", "contextvm-payment-model.json", "publication.json",
      "restore.json", "security-host.json", "supply-chain.json", "telemetry.json",
    ]);
    expect((await controller.status())?.state.status).toBe("blocked");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
