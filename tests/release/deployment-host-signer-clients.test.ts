import { expect, test } from "bun:test";

import { createCompatibleHostDeploymentClient } from "../../src/release/deployment/compatible-host-client";
import { createNip46DeploymentClient } from "../../src/release/deployment/nip46-signer-client";
import { createContextVmDeploymentClient } from "../../src/release/deployment/contextvm-client";
import { createPaymentDeploymentClients } from "../../src/release/deployment/payment-clients";
import { createVertexDeploymentClient } from "../../src/release/deployment/vertex-client";
import { registerDeploymentClientFamilies } from "../../src/release/deployment/factory";

const digest = (letter: string) => letter.repeat(64);
const vertexPrice = { sourceUrl: "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing", sourceDocumentSha256: digest("1"), quoteSha256: digest("2"), observedAtMs: 1_000, freshUntilMs: 2_000, effectiveFromMs: 900, effectiveUntilMs: 3_000, currency: "USD" as const, inputMicrosPerMillion: 750_000, cachedInputMicrosPerMillion: 75_000, outputAndThoughtMicrosPerMillion: 3_750_000 };
function vertexJournal() { const values = new Map<string, unknown>(); return { async read(operationId: string) { return values.get(operationId); }, async write(entry: { operationId: string }) { values.set(entry.operationId, entry); } }; }

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

test("host: factory preserves distinct compatible-host and NIP-46 family identities", () => {
  const host = createCompatibleHostDeploymentClient({ referenceHostReference: "napplet:reference-host:0.3.1", chromiumReference: "chromium:fixture:123", packageHost: {} as never, browser: {} as never });
  const signer = createNip46DeploymentClient({ disposableClientKeyReference: "nostr:nip46-disposable-client-key", signer: {} as never, ownerEventVerifier: {} as never });
  const families = registerDeploymentClientFamilies({
    contextvm: createContextVmDeploymentClient({ serviceKeyReference: "nostr:contextvm-service-key", relaySetReference: "relay-set:primary", relaySetSha256: digest("1") }),
    payments: createPaymentDeploymentClients({ nwcConnectionReference: "nwc:consent:wallet-one", cashuWalletReference: "cashu:funded-wallet:one" }),
    vertex: createVertexDeploymentClient({ candidateSha256: digest("2"), projectId: "napplet-cvm-run-1", location: "global", model: "gemini-3.8-flash", credentialReference: "gcp:adc:release", price: vertexPrice, journal: vertexJournal(), interactions: { create: async () => undefined, get: async () => undefined, list: async () => ({ interactions: [] }) } }),
    host, signer,
  });
  expect(families.compatible_host).toBe(host);
  expect(families.signer).toBe(signer);
});
