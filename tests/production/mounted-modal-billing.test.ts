import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { selectMountedModalBilling } from "../../src/production/mounted-modal-billing";
import { MODAL_1_6_3_SDIST_SHA256, MODAL_1_6_3_WHEEL_SHA256 } from "../../src/release/deployment/modal-billing-report";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const configuration = {
  version: 1, cli: { version: "1.6.3", sdistSha256: MODAL_1_6_3_SDIST_SHA256, wheelSha256: MODAL_1_6_3_WHEEL_SHA256, executable: "/opt/modal/bin/modal", executableSha256: digest("modal") },
  credentialReference: "secret/modal-report", credentialReferenceSha256: digest("credential"),
  preflightEvidence: { key: "modal-billing-preflight/report-1", generation: 1, checksum: digest("evidence") },
};

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
});
