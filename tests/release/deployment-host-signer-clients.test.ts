import { expect, test } from "bun:test";

import { createCompatibleHostDeploymentClient } from "../../src/release/deployment/compatible-host-client";
import { createNip46DeploymentClient } from "../../src/release/deployment/nip46-signer-client";

const digest = (letter: string) => letter.repeat(64);

test("host: binds a sealed artifact to the promoted reference-host Chromium fixture", async () => {
  const calls: unknown[] = [];
  const host = createCompatibleHostDeploymentClient({
    referenceHostReference: "napplet:reference-host:0.3.1",
    chromiumReference: "chromium:fixture:123",
    packageHost: { loadSealedNapplet: async (value) => ({ ...value, hostVersion: "reference-host-0.3.1", packageVersion: "napplet-sdk-0.27.2", runtimeVersion: "nip-5d" }) },
    browser: { kind: "chromium", observe: async (value) => { calls.push(value); return { browserVersion: "fixture-chromium", reportSha256: digest("a"), consoleErrors: [], directAuthorityDenied: true, responsiveAccessible: true, capabilityMediated: true, minimumMeasuredTargetPx: 44, noClippedStepLabels: true, noNestedHorizontalScroll: true }; } },
  });
  const result = await host.observe({ sealedArtifactSha256: digest("b"), aggregateSha256: digest("c") });
  expect(result.hostPreview).toBe("pass");
  expect(calls).toHaveLength(1);
  expect(host.discovery()).toEqual({ referenceHostReference: "napplet:reference-host:0.3.1", chromiumReference: "chromium:fixture:123", command: "pnpm verify && pnpm test:conformance" });
  expect(() => createCompatibleHostDeploymentClient({ referenceHostReference: "https://external-host.example", chromiumReference: "chromium:fixture:123", packageHost: {} as never, browser: {} as never })).toThrow("DEPLOYMENT_REFERENCE_HOST_INVALID");
});

test("nip46: retains only a disposable client key reference and never receives user key material", async () => {
  let discoveryCalls = 0;
  const client = createNip46DeploymentClient({
    disposableClientKeyReference: "nostr:nip46-disposable-client-key",
    signer: { discover: async () => { discoveryCalls += 1; return { pubkey: "d".repeat(64), capabilities: ["sign_event"], consentState: "pending" }; }, signExactIntent: async () => { throw new Error("must not sign in fixture inspection"); } },
    ownerEventVerifier: { verify: async () => ({ valid: false, accepted: false, eventId: "0".repeat(64) }) },
  });
  expect(await client.inspect({ sealedArtifactSha256: digest("e"), aggregateSha256: digest("f") })).toMatchObject({ status: "blocked", userKeyOutsideCvm: true, keyCanaryAbsentFromCvm: true });
  expect(discoveryCalls).toBe(1);
  expect(() => createNip46DeploymentClient({ disposableClientKeyReference: "nsec1-owner-key", signer: {} as never, ownerEventVerifier: {} as never })).toThrow("DEPLOYMENT_SECRET_REFERENCE_INVALID");
});
