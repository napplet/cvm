import { expect, test } from "bun:test";
import { runLiveSecurityHostCertification } from "../../src/certification/live/security-host";
import { runLiveSupplyChainCertification } from "../../src/certification/live/supply-chain";

const digest = (letter: string) => letter.repeat(64);
const candidate = {
  id: digest("a"),
  provider: "modal" as const,
  image: `registry.example/modal@sha256:${digest("b")}`,
  sourceSha256: digest("c"),
};

test("security host rejects a deterministic browser and signer port before any local effect", async () => {
  let effects = 0;
  const result = await runLiveSecurityHostCertification({
    candidate,
    observationPort: {
      evidenceClass: "deterministic",
      runSealedBuild: async () => { effects += 1; return {}; },
      runBrowser: async () => { effects += 1; return {}; },
      inspectSignerBoundary: async () => { effects += 1; return {}; },
    },
  });
  expect(result).toEqual(expect.objectContaining({ status: "blocked", claims: [], reasonCode: "INPUT_UNAVAILABLE" }));
  expect(effects).toBe(0);
});

test("supply chain rejects deterministic builds and verifier inputs before records or commands are created", async () => {
  let effects = 0;
  const result = await runLiveSupplyChainCertification({
    candidate,
    observationPort: {
      evidenceClass: "deterministic",
      runBuild: async () => { effects += 1; return {}; },
      verifySupplyChain: async () => { effects += 1; return {}; },
    },
  });
  expect(result).toEqual(expect.objectContaining({ status: "blocked", claims: [], reasonCode: "INPUT_UNAVAILABLE" }));
  expect(effects).toBe(0);
});
