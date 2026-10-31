import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as modalSelection from "../../src/production/mounted-modal-billing";
import * as modalCollector from "../../src/release/deployment/modal-billing-report";
import { MountedModalBillingConfigurationSchema, selectMountedModalBilling } from "../../src/production/mounted-modal-billing";
import { MODAL_1_6_3_SDIST_SHA256, MODAL_1_6_3_WHEEL_SHA256 } from "../../src/release/deployment/modal-billing-report";
import { createProductionCertificationSessionMaterial } from "../../src/production/mounted-session-material";
import { loadMountedProductionSessionRecord, materializeMountedProductionSessionRecord } from "../../src/production/mounted-session-record";
import { MountedProductionSecretMaterial } from "../../src/production/secret-material";
import { createMountedProductionAuthorization } from "../../src/production/mounted-authorization";
import type { ProductionGenerationRuntime } from "../../src/production/generation-runtime";
import { createDeploymentExecutionConfig } from "../../src/release/deployment/config";
import { mountedBillingRecoveryFixture } from "../release/helpers/mounted-billing-recovery-fixture";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const configuration = MountedModalBillingConfigurationSchema.parse({
  version: 1, cli: { version: "1.6.3", sdistSha256: MODAL_1_6_3_SDIST_SHA256, wheelSha256: MODAL_1_6_3_WHEEL_SHA256, executable: "/opt/modal/bin/modal", executableSha256: digest("modal") },
  credentialReference: "secret/modal-report", credentialReferenceSha256: digest("credential"),
  preflightEvidence: { key: "modal-billing-preflight/report-1", generation: 1, checksum: digest("evidence") },
});

describe("mounted Modal billing selection", () => {
  test("is disabled when no sealed Modal configuration exists", async () => {
    await expect(selectMountedModalBilling({})).resolves.toEqual({ status: "disabled", code: "MODAL_BILLING_NOT_CONFIGURED" });
  });

  test("does not treat parsed flags or digests as verified preflight", async () => {
    let reads = 0;
    const evidence = JSON.stringify({ version: 1, accountScopeSha256: digest("account"), environmentScopeSha256: digest("environment"), credentialReferenceSha256: digest("credential"), originalOperationRecordSha256: digest("operation"), resourceIdentitySha256: digest("resource"), currencyPolicySha256: digest("currency"), reportCoveragePolicySha256: digest("coverage"), observedAtMs: 1, expiresAtMs: 2, verification: "external-authority-required" });
    await expect(selectMountedModalBilling({ configuration, evidenceReader: { async readExact() { reads++; return new TextEncoder().encode(evidence); } } })).resolves.toEqual({ status: "disabled", code: "MODAL_BILLING_EXTERNAL_PREFLIGHT_REQUIRED" });
    expect(reads).toBe(1);
  });

  test("refuses malformed controller material before evidence access", async () => {
    let reads = 0;
    await expect(selectMountedModalBilling({ configuration: { ...configuration, cli: { ...configuration.cli, wheelSha256: digest("wrong") } }, evidenceReader: { async readExact() { reads++; return new Uint8Array(); } } })).resolves.toEqual({ status: "disabled", code: "MODAL_BILLING_PREFLIGHT_INVALID" });
    expect(reads).toBe(0);
  });

  test("the normal factory parses valid sealed Modal material and disables it before runtime authority", async () => {
    const base = resolve(import.meta.dir, "../../.runtime/release-certification/native-discovery-v1");
    await mkdir(base, { recursive: true, mode: 0o700 });
    const workspace = await mkdtemp(join(base, "modal-mounted-composition-"));
    try {
      const fixture = await mountedBillingRecoveryFixture(workspace, Date.now());
      const measured = materializeMountedProductionSessionRecord({ config: fixture.config, measured: { ...fixture.measured, modalBilling: configuration } });
      const secrets = new MountedProductionSecretMaterial(fixture.config, { root: join(workspace, "fixture-mount") });
      await writeFile(secrets.path("certification.sessionMaterialReference"), JSON.stringify(measured), { mode: 0o600 });
      const loaded = await loadMountedProductionSessionRecord({ config: fixture.config, secrets });
      expect(loaded.modalBilling).toEqual(configuration);
      const authorization = await createMountedProductionAuthorization({ config: fixture.config, secrets });
      const authorityReads: string[] = [];
      const boundary = new Error("NEXT_NORMAL_RUNTIME_AUTHORITY_BOUNDARY");
      const authority = (name: string): never => { authorityReads.push(name); throw boundary; };
      // This construction proof stops at the already-opened runtime boundary.
      // It never pretends to start a generation service or its provider graph.
      const generation: ProductionGenerationRuntime = {
        config: fixture.config, authorization,
        get certificationClientPubkey() { return authority("certificationClientPubkey"); },
        get generation() { return authority("generation"); },
        get continuation() { return authority("continuation"); },
        get facade() { return authority("facade"); },
        get funding() { return authority("funding"); },
        get dependencies() { return authority("dependencies"); },
        get admissionObserver() { return authority("admissionObserver"); },
        registerClose() { authority("registerClose"); },
        async close() { authority("close"); },
      };
      // Call-through spies observe real implementations; no selector, parser,
      // factory, secret reader or process return value is substituted.
      const selection = spyOn(modalSelection, "selectMountedModalBilling");
      const reads = spyOn(MountedProductionSecretMaterial.prototype, "text");
      const collector = spyOn(modalCollector, "createModalBillingReportCollector");
      const spawn = spyOn(Bun, "spawn");
      try {
        await expect(createProductionCertificationSessionMaterial({
          config: fixture.config, deploymentConfig: createDeploymentExecutionConfig(fixture.deployment), generation, authorization, secrets,
        })).rejects.toBe(boundary);
        expect(selection).toHaveBeenCalledTimes(1);
        expect(selection.mock.calls[0]?.[0]).toEqual({ configuration: loaded.modalBilling });
        const selected = selection.mock.results[0];
        if (!selected || selected.type !== "return") throw new Error("REAL_MODAL_SELECTION_RESULT_MISSING");
        expect(await selected.value).toEqual({ status: "disabled", code: "MODAL_BILLING_EXTERNAL_PREFLIGHT_REQUIRED" });
        expect(authorityReads).toEqual(["dependencies"]);
        expect(reads.mock.calls.map(([binding]) => binding)).toEqual(["certification.sessionMaterialReference"]);
        expect(collector).not.toHaveBeenCalled();
        expect(spawn).not.toHaveBeenCalled();
      } finally { spawn.mockRestore(); collector.mockRestore(); reads.mockRestore(); selection.mockRestore(); }
    } finally { await rm(workspace, { recursive: true, force: true }); }
  });
});
