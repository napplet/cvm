import { expect, test } from "bun:test";
import { runLivePublicationCertification } from "../../src/certification/live/publication";
import { DirectPublicationReferenceSchema, DirectPublicationSourceObservationSchema, DirectPublicationSubmissionSchema, DirectPublicationReconciliationSchema,
  directPublicationOperationIds, type LiveDirectPublicationObservationPort } from "../../src/certification/live/direct-publication-contract";
import { DIRECT_CLI_NETWORK_IDENTITY } from "../../src/production/pinned-direct-cli-network";

const digest = (value: string) => value.repeat(64);
test("direct preapproval reference carries only an owner and stable original key", () => {
  const reference = { principal: { pubkey: digest("a") }, idempotencyKey: "certification:direct-publication" };
  expect(DirectPublicationReferenceSchema.parse(reference)).toEqual(reference);
  for (const extra of [{ artifactHash: digest("b") }, { archiveSha256: digest("c") }, { reviewSha256: digest("d") },
    { intentId: `direct-publication:${digest("e")}` }, { event: {} }, { signer: "callback" }]) {
    expect(DirectPublicationReferenceSchema.safeParse({ ...reference, ...extra }).success).toBe(false);
  }
  expect(DirectPublicationReferenceSchema.safeParse({ ...reference, principal: { ...reference.principal, privateKey: digest("f") } }).success).toBe(false);
});
// Schema/runner fixtures only: no provider execution or evidence writer.
async function fixture() {
  const original = { principal: { pubkey: digest("a") }, idempotencyKey: "unit:direct", intentId: `direct-publication:${digest("b")}`, reviewSha256: digest("c") };
  const source = DirectPublicationSourceObservationSchema.parse({ version: "direct-publication-observation-v1", status: "verified-source-bytes", artifactContract: "nip5d-direct-v1",
    candidateSha256: digest("a"), topologySha256: digest("b"), artifactHash: digest("c"), archiveSha256: digest("d"), toolchainSha256: digest("e"), server: "https://publication.example",
    toolchain: { version: 1, artifactContract: "nip5d-direct-v1", platform: "linux-arm64", cliBinarySha256: "2a78a97ae95f493a0c568366ede5a53ce99808fa2fe487572952b7f4f9770a26",
      workerPackageSha256: "ca0d5a088c7650407306899eaaaa535b2bd872d746d7aee10be471894944abbf", workerLockSha256: "f0ac025b6f79609a159702adedfbfebd8966b1c65f78cf1e0f75912ae54a567d",
      templatePackageSha256: "81f03e8b76b15cbc025b11a67117389b579ee1ca374ddb680971f91e7293a99f", templateLockSha256: "ec1eb261c06641decda0c8fbd3a96e5f121cddfcc6abdc8888f78556390e28e4" },
    helper: DIRECT_CLI_NETWORK_IDENTITY, productionPromotion: "not_asserted", original, operationIds: await directPublicationOperationIds(original.intentId) });
  const submitted = DirectPublicationSubmissionSchema.parse({ version: source.version, status: "submitted", artifactContract: source.artifactContract,
    candidateSha256: source.candidateSha256, topologySha256: source.topologySha256, artifactHash: source.artifactHash, archiveSha256: source.archiveSha256,
    original, operationIds: source.operationIds, ownerEventId: digest("e"), attestationEventId: digest("f"), userSigningExternal: true });
  const reconciled = DirectPublicationReconciliationSchema.parse({ ...submitted, status: "complete", locationReference: `${source.server}/${source.artifactHash}`, originalOperationsOnly: true });
  const candidate = { id: source.candidateSha256, provider: "modal", image: `registry.example/worker@sha256:${digest("0")}`, sourceSha256: digest("1") };
  const port: LiveDirectPublicationObservationPort = { artifactContract: "nip5d-direct-v1", evidenceClass: "protected_live",
    async verifyPromotedSource() { return source; }, async submitOriginalPublication(value) { expect(value).toEqual(source); return submitted; },
    async reconcileOriginalPublication(value) { expect(value).toEqual(submitted); return reconciled; } };
  return { source, submitted, reconciled, candidate, port };
}

test("direct runner keeps exact versioned identities and unchanged release claims", async () => {
  const f = await fixture();
  const result = await runLivePublicationCertification({ candidate: f.candidate, observationPort: f.port });
  expect(result.status).toBe("passed");
  expect(result.claims).toEqual(["release.promoted_cli", "release.sealed_publication", "release.external_owner_signing"]);
  expect(f.source).not.toHaveProperty("aggregateSha256");
  expect(f.source.productionPromotion).toBe("not_asserted");
  let calls = 0;
  expect((await runLivePublicationCertification({ candidate: f.candidate, observationPort: { ...f.port, evidenceClass: "deterministic", async verifyPromotedSource() { calls++; return f.source; } } })).status).toBe("blocked");
  expect(calls).toBe(0);
});

test("direct runner rejects source pins, aliases, changed operations and readback substitutions", async () => {
  const f = await fixture();
  for (const source of [{ ...f.source, aggregateSha256: f.source.artifactHash }, { ...f.source, toolchain: { ...f.source.toolchain, cliBinarySha256: digest("0") } },
    { ...f.source, helper: { ...f.source.helper, bundleSha256: digest("0") } }, { ...f.source, productionPromotion: "selected" },
    { ...f.source, candidateSha256: digest("0") }, { ...f.source, operationIds: { ...f.source.operationIds, upload: `direct-upload:${digest("0")}` } }]) {
    let submits = 0;
    const result = await runLivePublicationCertification({ candidate: f.candidate, observationPort: { ...f.port,
      async verifyPromotedSource() { return source; }, async submitOriginalPublication() { submits++; return f.submitted; } } });
    expect(result.status).not.toBe("passed"); expect(result.claims).toEqual([]); expect(submits).toBe(0);
  }
  for (const submitted of [{ ...f.submitted, archiveSha256: digest("0") }, { ...f.submitted, topologySha256: digest("0") },
    { ...f.submitted, original: { ...f.submitted.original, reviewSha256: digest("0") } }, { ...f.submitted, operationIds: { ...f.submitted.operationIds, owner: `direct-owner-relay:${digest("0")}` } }]) {
    const result = await runLivePublicationCertification({ candidate: f.candidate, observationPort: { ...f.port, async submitOriginalPublication() { return submitted; } } });
    expect(result.status).toBe("failed"); expect(result.claims).toEqual([]);
  }
  for (const reconciled of [{ ...f.reconciled, locationReference: `https://other.example/${f.source.artifactHash}` },
    { ...f.reconciled, locationReference: `${f.source.server}/${f.source.archiveSha256}` }, { ...f.reconciled, ownerEventId: digest("0") },
    { ...f.reconciled, originalOperationsOnly: false }, { ...f.reconciled, attestationEventId: digest("0") }]) {
    const result = await runLivePublicationCertification({ candidate: f.candidate, observationPort: { ...f.port, async reconcileOriginalPublication() { return reconciled; } } });
    expect(result.status).not.toBe("passed"); expect(result.claims).toEqual([]);
  }
});
