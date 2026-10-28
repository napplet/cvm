import { extname } from "node:path";
import { verifyEvent } from "nostr-tools/pure";
import { z } from "zod";

import { ImmutableObjectReferenceSchema, type ObjectStorePort } from "../continuity/object-store";
import { canonicalJson } from "../promotion/schema";
import { PublicationIntentSchema, SealedArtifactIdentitySchema, SignedOwnerManifestEventSchema, type OwnerEventVerifierPort } from "../publication/contracts";
import { validateAuthorizationRequest, validateAuthorizationReceipt, ReleaseAuthorizationReceiptSchema } from "../release/authorization";
import { assertPostgresOperationJournal, type PostgresOperationJournal } from "../release/deployment/postgres-operation-journal";
import { assertMountedSourceBuildPlan, bindMountedSourceBuildExecution, type MountedSourceBuildPlan } from "./source-build-plan";
import { readMountedSourceBuildEvidence } from "./source-build-verifier";
import { originalSigningKey, publicationKey, signingKey, ProductionPublicationRecordSchema } from "./edge-contexts";
import type { ProductionGenerationRuntime } from "./generation-runtime";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Url = z.string().url().refine(value => { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.hash; });
const Relay = z.string().url().refine(value => { const url = new URL(value); return url.protocol === "wss:" && !url.username && !url.password && !url.hash; });
const Template = z.object({ kind: z.literal(35129), created_at: z.number().int().positive(), content: z.string().max(64_000), tags: z.array(z.array(z.string().max(4096)).min(1).max(16)).max(128) }).strict();
const NamedManifest = z.object({
  item: z.object({ target: z.literal("named"), kind: z.literal(35129), dTag: z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/u) }).passthrough(),
  files: z.array(z.object({ path: z.string().startsWith("/"), sha256: Digest }).strict()).min(1).max(256),
  aggregateHash: Digest, template: Template,
}).passthrough();
const sha = (value: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
const mime = new Map([[".html", "text/html"], [".js", "text/javascript"], [".css", "text/css"], [".json", "application/json"], [".svg", "image/svg+xml"], [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".webp", "image/webp"], [".ico", "image/x-icon"], [".woff2", "font/woff2"], [".wasm", "application/wasm"]]);
type Record = z.infer<typeof ProductionPublicationRecordSchema>;

/** Derives immutable publication and NIP-46 contexts from the actual CLI receipt.
 * File bytes stay in object storage; SQL retains bounded metadata and original
 * operation identities. Uncertain uploads are observed, never dispatched again. */
export class ProductionPublicationContextMaterializer {
  constructor(private readonly input: Readonly<{
    candidateSha256: string; topologySha256: string; ownerPubkey: string;
    policyVersion: string; toolchainIdentity: string; compatibleHostReference: string; compatibleHostSha256: string;
    sourcePlan: MountedSourceBuildPlan; authorization: ProductionGenerationRuntime["authorization"];
    journal: PostgresOperationJournal; sourceJournal: PostgresOperationJournal; artifactStore: ObjectStorePort;
    relaySet: readonly string[]; uploadServers: readonly string[]; now?: () => number;
  }>) {
    assertPostgresOperationJournal(input.journal); assertPostgresOperationJournal(input.sourceJournal);
    Digest.parse(input.candidateSha256); Digest.parse(input.topologySha256); Digest.parse(input.ownerPubkey); Digest.parse(input.compatibleHostSha256);
    z.array(Relay).min(1).max(16).parse(input.relaySet); z.array(Url).length(1).parse(input.uploadServers);
    assertMountedSourceBuildPlan(input.sourcePlan, { candidateSha256: input.candidateSha256, topologySha256: input.topologySha256, provider: input.sourcePlan.provider });
  }

  async #authorize(readOnly: boolean) {
    const request = await validateAuthorizationRequest(this.input.authorization.request);
    const original = ReleaseAuthorizationReceiptSchema.parse(this.input.authorization.receipt);
    const receipt = await validateAuthorizationReceipt({ request, receipt: original, nowMs: readOnly ? Math.min((this.input.now ?? Date.now)(), original.expiresAtMs - 1) : (this.input.now ?? Date.now)() });
    if (request.authorizationRequestSha256 !== this.input.authorization.authorizationRequestSha256 || receipt.authorizationReceiptSha256 !== this.input.authorization.authorizationReceiptSha256
      || request.candidateSha256 !== this.input.candidateSha256 || request.topologySha256 !== this.input.topologySha256
      || ["gcs", "signer", "promoted_cli", "upload", "owner_relay", "attestation_relay"].some(provider => !request.providerScopes.some(scope => scope.provider === provider) || !request.orderedEffects.some(effect => effect.provider === provider))) throw new Error("PRODUCTION_PUBLICATION_AUTHORIZATION_REQUIRED");
    return { request, receipt };
  }

  #validateRecord(value: unknown, identitySha256: string): Record {
    const record = ProductionPublicationRecordSchema.parse(value);
    if (record.candidateSha256 !== this.input.candidateSha256 || record.topologySha256 !== this.input.topologySha256 || record.authorizationRequestSha256 !== this.input.authorization.authorizationRequestSha256
      || identitySha256 !== sha(canonicalJson(record)) || record.intent.ownerPubkey !== this.input.ownerPubkey
      || record.intent.manifestTemplateDigest !== sha(canonicalJson(record.ownerTemplate))
      || canonicalJson(record.relaySet) !== canonicalJson(this.input.relaySet) || canonicalJson(record.deploy.servers) !== canonicalJson(this.input.uploadServers)
      || record.artifact.policyIdentity !== this.input.policyVersion || record.artifact.toolchainIdentity !== this.input.toolchainIdentity
      || record.artifact.runtimeCompatibilityIdentity !== `compatible-host:${this.input.compatibleHostReference}:${this.input.compatibleHostSha256}`) throw new Error("PRODUCTION_PUBLICATION_CONTEXT_BINDING_REQUIRED");
    return record;
  }

  async #claim(key: string, value: unknown) {
    const identity = sha(canonicalJson(value)), prior = await this.input.journal.read(key);
    if (prior) {
      if (prior.identitySha256 !== identity || canonicalJson(prior.value) !== canonicalJson(value)) throw new Error("PRODUCTION_PUBLICATION_ORIGINAL_CHANGED");
      return prior;
    }
    await this.#authorize(false);
    return (await this.input.journal.claim(key, identity, value)).record;
  }

  async #persistBundle(key: string, bytes: Uint8Array) {
    if (bytes.byteLength > 24 * 1024 * 1024) throw new Error("PRODUCTION_PUBLICATION_BUNDLE_LIMIT");
    const checksum = sha(bytes), operation = `publication-bundle:${sha(key)}`;
    const value = { key, checksum, authorizationRequestSha256: this.input.authorization.authorizationRequestSha256 };
    const prior = await this.input.journal.read(operation);
    let dispatch = false;
    if (!prior) {
      await this.#authorize(false);
      dispatch = (await this.input.journal.claim(operation, sha(canonicalJson(value)), value)).claimed;
    } else if (prior.identitySha256 !== sha(canonicalJson(value)) || canonicalJson(prior.value) !== canonicalJson(value)) throw new Error("PRODUCTION_PUBLICATION_ORIGINAL_CHANGED");
    const exact = (raw: unknown) => {
      const object = ImmutableObjectReferenceSchema.parse(raw);
      if (object.key !== key || object.checksum !== checksum) throw new Error("PRODUCTION_PUBLICATION_BUNDLE_BINDING_REQUIRED");
      return object;
    };
    if (dispatch) {
      await this.#authorize(false);
      try { return exact(await this.input.artifactStore.createImmutable({ key, bytes })); } catch { /* only query the original below */ }
    }
    const observed = await this.input.artifactStore.observeExactByKey({ key, checksum });
    if (!observed) throw new Error("PRODUCTION_PUBLICATION_BUNDLE_UNAVAILABLE");
    return exact(observed);
  }

  async materialize() {
    const { request, receipt } = await this.#authorize(true);
    const run = bindMountedSourceBuildExecution(this.input.sourcePlan, { authorizationRequestSha256: request.authorizationRequestSha256 });
    const evidence = await readMountedSourceBuildEvidence({ journal: this.input.sourceJournal, artifactStore: this.input.artifactStore, candidateSha256: this.input.candidateSha256, run });
    const key = publicationKey(this.input.candidateSha256, evidence.result.sealedArtifactSha256, evidence.result.aggregateSha256, request.authorizationRequestSha256);
    const prior = await this.input.journal.read(key);
    if (prior) {
      const record = this.#validateRecord(prior.value, prior.identitySha256);
      return Object.freeze({ artifact: record.artifact, intent: record.intent, intentDigest: record.intent.fingerprint, relaySet: Object.freeze([...record.relaySet]) });
    }
    const manifest = NamedManifest.parse(evidence.evidence.receipts.manifest);
    const names = manifest.template.tags.filter(tag => tag[0] === "d");
    const files = evidence.evidence.artifact.files.map(file => ({ path: `/${file.path}`, mimeType: mime.get(extname(file.path)) ?? "application/octet-stream", sha256: file.sha256, size: file.size, bytes: Buffer.from(file.bytesBase64, "base64").toString("base64url") }));
    if (manifest.aggregateHash !== evidence.result.aggregateSha256 || names.length !== 1 || names[0]!.length !== 2 || names[0]![1] !== manifest.item.dTag
      || manifest.files.length !== files.length || new Set(manifest.files.map(file => file.path)).size !== files.length
      || manifest.files.some(file => !files.some(expected => file.path === expected.path && file.sha256 === expected.sha256))) throw new Error("PRODUCTION_PUBLICATION_CLI_MANIFEST_REQUIRED");
    const sealedFiles = files.map(({ bytes: _bytes, ...file }) => file);
    const capabilities = z.object({ required: z.array(z.string()).max(64), optional: z.array(z.string()).max(64) }).strict().parse(JSON.parse(evidence.evidence.receipts.capabilities.content));
    const artifact = SealedArtifactIdentitySchema.parse({
      accountId: `certification:${this.input.candidateSha256}`, sessionId: run.sessionId, artifactId: `artifact:${evidence.result.sealedArtifactSha256}`, artifactVersion: 1,
      aggregateSha256: evidence.result.aggregateSha256, manifestSha256: evidence.result.manifestSha256, verificationEvidenceSha256: evidence.evidence.receipts.commandEvidenceSha256,
      sealedObjectGeneration: String(evidence.evidenceObject.generation), sealedObjectSha256: evidence.result.sealedArtifactSha256, sealedFiles,
      entrypoint: "/index.html", normalizedDTag: manifest.item.dTag, requiredCapabilities: capabilities.required, optionalCapabilities: capabilities.optional,
      policyIdentity: this.input.policyVersion, toolchainIdentity: this.input.toolchainIdentity, runtimeCompatibilityIdentity: `compatible-host:${this.input.compatibleHostReference}:${this.input.compatibleHostSha256}`,
    });
    const seed = { candidateSha256: this.input.candidateSha256, topologySha256: this.input.topologySha256, authorizationRequestSha256: request.authorizationRequestSha256, artifact, ownerPubkey: this.input.ownerPubkey, template: manifest.template, relaySet: this.input.relaySet, uploadServers: this.input.uploadServers };
    const fingerprint = sha(canonicalJson(seed)), intentId = `publication:${fingerprint}`;
    const createdAtMs = manifest.template.created_at * 1000;
    const expiresAtMs = Math.min(createdAtMs + 30 * 60_000, receipt.expiresAtMs);
    if (expiresAtMs <= createdAtMs || (this.input.now ?? Date.now)() >= expiresAtMs || createdAtMs > (this.input.now ?? Date.now)() + 30_000) throw new Error("PRODUCTION_PUBLICATION_CLI_RECEIPT_EXPIRED");
    const intent = PublicationIntentSchema.parse({ intentId, accountId: artifact.accountId, sessionId: artifact.sessionId, ownerPubkey: this.input.ownerPubkey, artifact,
      artifactSha256: artifact.sealedObjectSha256, manifestSha256: artifact.manifestSha256, aggregateSha256: artifact.aggregateSha256, dTag: manifest.item.dTag,
      capabilityDigest: sha(canonicalJson(capabilities)), runtimeVariant: artifact.runtimeCompatibilityIdentity, policyVersion: this.input.policyVersion, toolchainIdentity: this.input.toolchainIdentity,
      purpose: "Publish the sealed certification napplet", consent: "approved", idempotencyKey: intentId, fingerprint, manifestTemplateDigest: sha(canonicalJson(manifest.template)), createdAtMs, expiresAtMs, status: "intent_ready" });
    const bundleBytes = new TextEncoder().encode(canonicalJson({ version: 1, files }));
    const bundleObject = await this.#persistBundle(`certification/publication/${this.input.candidateSha256}/${request.authorizationRequestSha256}/${artifact.aggregateSha256}/files.json`, bundleBytes);
    const binding = { candidateSha256: this.input.candidateSha256, topologySha256: this.input.topologySha256, authorizationRequestSha256: request.authorizationRequestSha256 };
    const owner = { ...binding, expiresAtMs, operationId: `owner_manifest:${intentId}`, ownerPubkey: this.input.ownerPubkey, capabilities: ["sign_event"], template: manifest.template };
    await this.#claim(signingKey(fingerprint), owner);
    const upload = { ...binding, expiresAtMs, operationId: `upload_authorization:${intentId}`, ownerPubkey: this.input.ownerPubkey, capabilities: ["sign_event"], template: { kind: 24242, created_at: manifest.template.created_at, content: "Upload blobs via napplet", tags: [["t", "upload"], ...files.map(file => ["x", file.sha256]), ["expiration", String(manifest.template.created_at + 3600)], ["client", "napplet"], ["server", new URL(this.input.uploadServers[0]!).hostname.toLowerCase()]] } };
    await this.#claim(originalSigningKey(upload.operationId), upload);
    const record = ProductionPublicationRecordSchema.parse({ ...binding, artifact, intent, ownerTemplate: manifest.template, requiredSignerCapabilities: ["sign_event"], relaySet: this.input.relaySet, deploy: { target: { kind: 35129, dTag: manifest.item.dTag }, object: bundleObject, files: sealedFiles, servers: this.input.uploadServers } });
    const saved = await this.#claim(key, record);
    const final = this.#validateRecord(saved.value, saved.identitySha256);
    return Object.freeze({ artifact: final.artifact, intent: final.intent, intentDigest: final.intent.fingerprint, relaySet: Object.freeze([...final.relaySet]) });
  }

  /** Signature verification is read-only and remains available for historical
   * original-operation recovery. It cannot initiate signing or publication. */
  readonly ownerEventVerifier: OwnerEventVerifierPort = Object.freeze<OwnerEventVerifierPort>({ verify: async input => {
    try {
      await this.#authorize(true);
      const event = SignedOwnerManifestEventSchema.parse(input.event);
      const key = publicationKey(this.input.candidateSha256, input.intent.artifactSha256, input.intent.aggregateSha256, this.input.authorization.authorizationRequestSha256);
      const stored = await this.input.journal.read(key);
      if (!stored) throw new Error("missing");
      const record = this.#validateRecord(stored.value, stored.identitySha256);
      if (canonicalJson(record.intent) !== canonicalJson(input.intent) || event.pubkey !== record.intent.ownerPubkey || !verifyEvent(event)
        || canonicalJson({ kind: event.kind, created_at: event.created_at, content: event.content, tags: event.tags }) !== canonicalJson(record.ownerTemplate)) throw new Error("changed");
      return Object.freeze({ valid: true, accepted: true, eventId: event.id });
    } catch { return Object.freeze({ valid: false, accepted: false, safeReasonCode: "INVALID_OWNER_MANIFEST" as const }); }
  } });
}
