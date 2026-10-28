import { expect, test } from "bun:test";

import { CompatibleHostBrowserObservationPort, type CompatibleHostBrowserPort } from "../../src/release/native/compatible-host";
import { ExternalSignerBoundaryAdapter } from "../../src/release/native/external-signer";
import { createLiveSecurityHostObservationPort } from "../../src/certification/live/host-ports";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

// Complete local projection fixture for adapter contracts; never release evidence.
function browserFixture(): Awaited<ReturnType<CompatibleHostBrowserPort["observe"]>> {
  return {
    browserVersion: "Chromium 127", consoleErrors: [],
    observations: [1280, 768, 375].map(viewportWidthPx => ({ viewportWidthPx, screenshotSha256: DIGEST_A, reportSha256: DIGEST_B,
      layout: "pass", targets: "pass", accessibility: "pass", keyboardFocus: "pass", dialog: "pass", liveRegion: "pass", contrast: "pass", reducedMotion: "pass", stateInventory: "pass", identifierCoverage: "pass",
      minimumMeasuredTargetPx: 44, noClippedStepLabels: true, noNestedHorizontalScroll: true })),
    hostPreview: "pass", hostSigner: "pass", externalSigner: "pass", reconciliation: "pass", launchCertificationBlockedState: "pass",
  };
}

test("candidate-bound compatible host forwards complete viewport observations", async () => {
  const requests: unknown[] = [];
  const port = new CompatibleHostBrowserObservationPort({
    packageHost: { async loadSealedNapplet(input) { requests.push(input); return { ...input, hostVersion: "nip-5d-host@1.0.0", packageVersion: "@napplet/sdk@0.27.2", runtimeVersion: "nip-5d@4.0.0" }; } },
    browser: { kind: "chromium", async observe(input) {
      expect(input.viewports).toEqual([{ name: "desktop", width: 1280 }, { name: "tablet", width: 768 }, { name: "mobile", width: 375 }]);
      expect(input.interactions).toEqual(["keyboard", "touch", "focus", "dialog", "live_region", "capability_mediation"]);
      return browserFixture();
    } },
  });
  expect(await port.runBrowser({ sealedArtifactSha256: DIGEST_A, aggregateSha256: DIGEST_B })).toMatchObject({ execution: "real_compatible_host_browser", certificationStatus: "pass", sealedArtifactSha256: DIGEST_A, presentationInputSha256: DIGEST_B, hostVersion: "nip-5d-host@1.0.0;@napplet/sdk@0.27.2", runtimeVersion: "nip-5d@4.0.0;Chromium 127" });
  expect(requests).toEqual([{ sealedArtifactSha256: DIGEST_A, aggregateSha256: DIGEST_B }]);
});

test("compatible host rejects missing observations, non-Chromium, console errors and changed sealed identity", async () => {
  for (const failure of ["missing", "browser", "console", "identity"] as const) {
    const port = new CompatibleHostBrowserObservationPort({
      packageHost: { async loadSealedNapplet(input) { return { ...input, sealedArtifactSha256: failure === "identity" ? DIGEST_B : input.sealedArtifactSha256, hostVersion: "h", packageVersion: "p", runtimeVersion: "r" }; } },
      browser: { kind: failure === "browser" ? "webkit" : "chromium", async observe() { return { ...browserFixture(), ...(failure === "missing" ? { observations: browserFixture().observations.slice(0, 2) } : {}), ...(failure === "console" ? { consoleErrors: ["boom"] } : {}) }; } },
    });
    await expect(port.runBrowser({ sealedArtifactSha256: DIGEST_A, aggregateSha256: DIGEST_B })).rejects.toThrow("COMPATIBLE_HOST_BROWSER_EVIDENCE_UNAVAILABLE");
  }
});

test("compatible host retains non-pass measured viewport and signer outcomes", async () => {
  for (const failure of ["layout", "dialog", "hostSigner", "externalSigner"] as const) {
    const port = new CompatibleHostBrowserObservationPort({
      packageHost: { async loadSealedNapplet(input) { return { ...input, hostVersion: "h", packageVersion: "p", runtimeVersion: "r" }; } },
      browser: { kind: "chromium", async observe() { const result = browserFixture(); return failure === "layout" || failure === "dialog" ? { ...result, observations: result.observations.map(row => ({ ...row, [failure]: "blocked" as const })) } : { ...result, [failure]: "blocked" }; } },
    });
    expect(await port.runBrowser({ sealedArtifactSha256: DIGEST_A, aggregateSha256: DIGEST_B })).toMatchObject({ certificationStatus: "non_pass" });
  }
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
  const event = { id: "d".repeat(64), pubkey: ownerPubkey, created_at: 1, kind: 35129 as const, tags: [["d", "napplet"]], content: "", sig: "e".repeat(128) };
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
  await expect(signer.inspectSignerBoundary({ sealedArtifactSha256: DIGEST_B, aggregateSha256: "f".repeat(64) })).resolves.toMatchObject({ status: "passed", externalSigner: true, userKeyOutsideCvm: true });
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
    ownerEventVerifier: { async verify() { return { valid: true, accepted: true, eventId: "d".repeat(64) }; } },
  });

  await expect(signer.signExactIntent({ candidate: { sealedArtifactSha256: DIGEST_A, aggregateSha256: DIGEST_B }, intent: { ownerPubkey: "c".repeat(64), fingerprint: DIGEST_A } as never, requiredCapabilities: ["nip-44"] })).rejects.toThrow("EXTERNAL_SIGNER_RESULT_INVALID");
});

test("signer boundary inspection blocks discovery without a candidate-bound authorization", async () => {
  const signer = new ExternalSignerBoundaryAdapter({
    signer: {
      async discover() { return { pubkey: "c".repeat(64), capabilities: ["nip-44"], consentState: "granted" as const }; },
      async signExactIntent() { throw new Error("must not sign"); },
    },
    ownerEventVerifier: { async verify() { return { valid: false }; } },
  });

  await expect(signer.inspectSignerBoundary({ sealedArtifactSha256: DIGEST_A, aggregateSha256: DIGEST_B })).resolves.toMatchObject({ status: "blocked", externalSigner: true, userKeyOutsideCvm: true });
});
