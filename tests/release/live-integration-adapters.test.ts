import { expect, test } from "bun:test";
import { runLiveSecurityHostCertification } from "../../src/certification/live/security-host";
import { runLiveSupplyChainCertification } from "../../src/certification/live/supply-chain";
import { runLiveContextVmPaymentModelCertification } from "../../src/certification/live/contextvm-payment-model";
import { runLivePublicationCertification } from "../../src/certification/live/publication";

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
      runHostileMatrix: async () => { effects += 1; return {}; },
      runBrowser: async () => { effects += 1; return {}; },
      inspectSignerBoundary: async () => { effects += 1; return {}; },
    },
  });
  expect(result).toEqual(expect.objectContaining({ status: "blocked", claims: [], reasonCode: "INPUT_UNAVAILABLE" }));
  expect(effects).toBe(0);
});

test("supply chain reproducibility and Cosign verification reject deterministic builds before records or commands are created", async () => {
  let effects = 0;
  const result = await runLiveSupplyChainCertification({
    candidate,
    observationPort: {
      evidenceClass: "deterministic",
      runBuild: async () => { effects += 1; return {}; },
      supplyChainInput: async () => { effects += 1; return {}; },
    },
  });
  expect(result).toEqual(expect.objectContaining({ status: "blocked", claims: [], reasonCode: "INPUT_UNAVAILABLE" }));
  expect(effects).toBe(0);
});

test("ContextVM CEP-8 Lightning Cashu and model adapters reject deterministic ports before any value effect", async () => {
  let effects = 0;
  const result = await runLiveContextVmPaymentModelCertification({
    candidate,
    observationPort: {
      evidenceClass: "deterministic",
      exerciseSignedTransport: async () => { effects += 1; return {}; },
      exerciseCep8Settlement: async () => { effects += 1; return {}; },
      reconcileOriginalModelOperation: async () => { effects += 1; return {}; },
    },
  });
  expect(result).toEqual(expect.objectContaining({ status: "blocked", claims: [], reasonCode: "INPUT_UNAVAILABLE" }));
  expect(effects).toBe(0);
});

test("publication upload relay and original operation reconciliation reject deterministic ports before signing or publication", async () => {
  let effects = 0;
  const result = await runLivePublicationCertification({
    candidate,
    observationPort: {
      evidenceClass: "deterministic",
      verifyPromotedSource: async () => { effects += 1; return {}; },
      submitOriginalPublication: async () => { effects += 1; return {}; },
      reconcileOriginalPublication: async () => { effects += 1; return {}; },
    },
  });
  expect(result).toEqual(expect.objectContaining({ status: "blocked", claims: [], reasonCode: "INPUT_UNAVAILABLE" }));
  expect(effects).toBe(0);
});
