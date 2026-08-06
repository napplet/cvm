import { expect, test } from "bun:test";

import { CompatibleHostBrowserObservationPort } from "../../src/release/native/compatible-host";

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
    aggregateSha256: DIGEST_B,
    hostVersion: "nip-5d-host@1.0.0",
    packageVersion: "@napplet/sdk@0.27.2",
    runtimeVersion: "nip-5d@4.0.0",
    browserVersion: "Chromium 127",
    reportSha256: DIGEST_B,
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
    certificationStatus: "blocked",
  });
});

test("compatible host blocks an exact sealed identity mismatch", async () => {
  const port = new CompatibleHostBrowserObservationPort({
    packageHost: { async loadSealedNapplet(input) { return { ...input, sealedArtifactSha256: DIGEST_B, hostVersion: "h", packageVersion: "p", runtimeVersion: "r" }; } },
    browser: { kind: "chromium", async observe() { return { browserVersion: "b", reportSha256: DIGEST_B, consoleErrors: [], directAuthorityDenied: true, responsiveAccessible: true, capabilityMediated: true }; } },
  });

  await expect(port.runBrowser({ sealedArtifactSha256: DIGEST_A, aggregateSha256: DIGEST_B })).resolves.toMatchObject({ certificationStatus: "blocked" });
});
