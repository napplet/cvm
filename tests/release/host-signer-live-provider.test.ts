import { expect, test } from "bun:test";

import { CompatibleHostBrowserObservationPort } from "../../src/release/native/compatible-host";
import { ExternalSignerBoundaryAdapter } from "../../src/release/native/external-signer";
import { createLiveSecurityHostObservationPort } from "../../src/certification/live/host-ports";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

test("candidate-bound compatible host observes the full real-browser UI matrix", async () => {
  const requests: unknown[] = [];
  const port = new CompatibleHostBrowserObservationPort({
    packageHost: {
      async loadSealedNapplet(input) {
        requests.push(input);
        return {
          sealedArtifactSha256: input.sealedArtifactSha256,
          aggregateSha256: input.aggregateSha256,
          hostVersion: "nip-5d-host@1.0.0",
          packageVersion: "@napplet/sdk@0.27.2",
          runtimeVersion: "nip-5d@4.0.0",
        };
      },
    },
    browser: {
      kind: "chromium",
      async observe(input) {
        expect(input.viewports).toEqual([
          { name: "desktop", width: 1280 },
          { name: "tablet", width: 768 },
          { name: "mobile", width: 375 },
        ]);
        expect(input.interactions).toEqual([
          "keyboard", "touch", "focus", "dialog", "live_region", "capability_mediation",
        ]);
        return {
          browserVersion: "Chromium 127",
          reportSha256: DIGEST_B,
          consoleErrors: [],
          directAuthorityDenied: true,
          responsiveAccessible: true,
          capabilityMediated: true,
        };
      },
    },
  });

  await expect(port.runBrowser({ sealedArtifactSha256: DIGEST_A, aggregateSha256: DIGEST_B })).resolves.toMatchObject({
    execution: "real_compatible_host_browser",
    certificationStatus: "pass",
    sealedArtifactSha256: DIGEST_A,
    presentationInputSha256: DIGEST_B,
    hostVersion: "nip-5d-host@1.0.0;@napplet/sdk@0.27.2",
    runtimeVersion: "nip-5d@4.0.0;Chromium 127",
  });
  expect(requests).toEqual([{ sealedArtifactSha256: DIGEST_A, aggregateSha256: DIGEST_B }]);
});

test.each([
  ["non-real browser", "webkit", { consoleErrors: [], directAuthorityDenied: true, responsiveAccessible: true, capabilityMediated: true }],
  ["console error", "chromium", { consoleErrors: ["boom"], directAuthorityDenied: true, responsiveAccessible: true, capabilityMediated: true }],
  ["direct authority", "chromium", { consoleErrors: [], directAuthorityDenied: false, responsiveAccessible: true, capabilityMediated: true }],
  ["responsive failure", "chromium", { consoleErrors: [], directAuthorityDenied: true, responsiveAccessible: false, capabilityMediated: true }],
  ["capability bypass", "chromium", { consoleErrors: [], directAuthorityDenied: true, responsiveAccessible: true, capabilityMediated: false }],
] as const)("compatible host blocks %s", async (_reason, kind, observation) => {
  const port = new CompatibleHostBrowserObservationPort({
    packageHost: { async loadSealedNapplet(input) { return { ...input, hostVersion: "h", packageVersion: "p", runtimeVersion: "r" }; } },
    browser: { kind, async observe() { return { browserVersion: "b", reportSha256: DIGEST_B, ...observation }; } },
  });

  await expect(port.runBrowser({ sealedArtifactSha256: DIGEST_A, aggregateSha256: DIGEST_B })).resolves.toMatchObject({
    execution: "real_compatible_host_browser",
    certificationStatus: "non_pass",
  });
});

test("compatible host blocks an exact sealed identity mismatch", async () => {
  const port = new CompatibleHostBrowserObservationPort({
    packageHost: { async loadSealedNapplet(input) { return { ...input, sealedArtifactSha256: DIGEST_B, hostVersion: "h", packageVersion: "p", runtimeVersion: "r" }; } },
    browser: { kind: "chromium", async observe() { return { browserVersion: "b", reportSha256: DIGEST_B, consoleErrors: [], directAuthorityDenied: true, responsiveAccessible: true, capabilityMediated: true }; } },
  });

  await expect(port.runBrowser({ sealedArtifactSha256: DIGEST_A, aggregateSha256: DIGEST_B })).resolves.toMatchObject({ certificationStatus: "non_pass" });
});

test("live security bridge forwards the exact candidate identity to the compatible host", async () => {
  let identity: unknown;
  const port = createLiveSecurityHostObservationPort({
    runSealedBuild: async () => ({}),
    runHostileMatrix: async () => ({}),
    compatibleHost: { async runBrowser(input) { identity = input; return { evidence: "browser" } as never; } },
    inspectSignerBoundary: async () => ({}),
  });

  await expect(port.runBrowser({ sealedArtifactSha256: DIGEST_A, aggregateSha256: DIGEST_B })).resolves.toEqual({ evidence: "browser" });
  expect(identity).toEqual({ sealedArtifactSha256: DIGEST_A, aggregateSha256: DIGEST_B });
});

test("external signer returns only a locally verified exact-intent public result", async () => {
  const ownerPubkey = "c".repeat(64);
  const event = { id: "d".repeat(64), pubkey: ownerPubkey, created_at: 1, kind: 35129, tags: [["d", "napplet"]], content: "", sig: "e".repeat(128) };
  const signer = new ExternalSignerBoundaryAdapter({
    signer: {
      async discover() { return { pubkey: ownerPubkey, capabilities: ["nip-44"], consentState: "granted" as const }; },
      async signExactIntent(input) { expect(input.intentDigest).toBe(DIGEST_A); return { pubkey: ownerPubkey, intentDigest: input.intentDigest, authorizationReceipt: "receipt:external:1", event }; },
    },
    ownerEventVerifier: { async verify() { return { valid: true, accepted: true, eventId: event.id }; } },
  });

  const result = await signer.signExactIntent({
    candidate: { sealedArtifactSha256: DIGEST_B, aggregateSha256: "f".repeat(64) },
    intent: { ownerPubkey, fingerprint: DIGEST_A } as never,
    requiredCapabilities: ["nip-44"],
  });

  expect(result).toEqual({
    signerPubkey: ownerPubkey,
    signerCapabilities: ["nip-44"],
    intentDigest: DIGEST_A,
    authorizationReceipt: "receipt:external:1",
    sealedArtifactSha256: DIGEST_B,
    aggregateSha256: "f".repeat(64),
    signedEvent: event,
  });
  expect(JSON.stringify(result)).not.toContain("nsec");
});

test.each([
  ["wrong signer", { pubkey: "0".repeat(64), capabilities: ["nip-44"], consentState: "granted" as const }, DIGEST_A],
  ["wrong digest", { pubkey: "c".repeat(64), capabilities: ["nip-44"], consentState: "granted" as const }, DIGEST_B],
  ["missing consent", { pubkey: "c".repeat(64), capabilities: ["nip-44"], consentState: "pending" as const }, DIGEST_A],
] as const)("external signer rejects %s without key custody", async (_reason, discovery, intentDigest) => {
  const signer = new ExternalSignerBoundaryAdapter({
    signer: {
      async discover() { return discovery; },
      async signExactIntent() { return { pubkey: discovery.pubkey, intentDigest, authorizationReceipt: "receipt", event: { id: "d".repeat(64), pubkey: discovery.pubkey, created_at: 1, kind: 35129, tags: [["d", "napplet"]], content: "", sig: "e".repeat(128) } }; },
    },
    ownerEventVerifier: { async verify() { return { valid: true, accepted: true }; } },
  });

  await expect(signer.signExactIntent({ candidate: { sealedArtifactSha256: DIGEST_A, aggregateSha256: DIGEST_B }, intent: { ownerPubkey: "c".repeat(64), fingerprint: DIGEST_A } as never, requiredCapabilities: ["nip-44"] })).rejects.toThrow("EXTERNAL_SIGNER_RESULT_INVALID");
});
