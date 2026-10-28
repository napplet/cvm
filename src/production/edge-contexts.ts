import { z } from "zod";

import {
  PublicationIntentSchema,
  SealedArtifactIdentitySchema,
  type PublicationIntent,
  type SealedArtifactIdentity,
} from "../publication/contracts";
import type { PreSignedNamedDeployFile } from "../publication/napplet-cli-adapter";
import type {
  Nip46OriginalOperationContext,
  Nip46PublicationContext,
} from "./nip46-signer";
import type {
  ProductionPaymentScenarioContext,
  ProductionPublicationContext,
} from "../release/deployment/production-session-runtime";
import {
  assertPostgresOperationJournal,
  type PostgresOperationJournal,
} from "../release/deployment/postgres-operation-journal";

const Digest = z.string().regex(/^[a-f0-9]{64}$/iu).transform(value => value.toLowerCase());
const Operation = z.string().regex(/^[a-z][a-z0-9:_-]{2,300}$/u);
const Bytes = z.string().regex(/^[A-Za-z0-9_-]*$/u).transform(value => new Uint8Array(Buffer.from(value, "base64url")));
const DeployFile = z.object({
  path: z.string().startsWith("/").max(4_096), mimeType: z.string().min(1).max(256), sha256: Digest,
  size: z.number().int().nonnegative(), bytes: Bytes,
}).strict().superRefine((value, context) => {
  if (value.bytes.byteLength !== value.size) context.addIssue({ code: "custom", message: "EDGE_CONTEXT_FILE_SIZE_INVALID" });
});
const EventTemplate = z.object({
  kind: z.literal(35129), content: z.string().max(64_000),
  tags: z.array(z.array(z.string().max(4_096)).min(1).max(16)).max(128), created_at: z.number().int().positive(),
}).strict();
const UploadTemplate = z.object({
  kind: z.literal(24242), content: z.literal("Upload blobs via napplet"),
  tags: z.array(z.array(z.string().max(4_096)).min(1).max(16)).min(5).max(128), created_at: z.number().int().positive(),
}).strict();

const PublicationRecord = z.object({
  candidateSha256: Digest, topologySha256: Digest,
  artifact: SealedArtifactIdentitySchema,
  intent: PublicationIntentSchema,
  requiredSignerCapabilities: z.array(z.string().min(1).max(256)).min(1).max(32),
  relaySet: z.array(z.string().url().refine(value => new URL(value).protocol === "wss:")).min(1).max(16),
  deploy: z.object({ target: z.object({ kind: z.literal(35129), dTag: z.string().min(1).max(128) }).strict(), files: z.array(DeployFile).min(1).max(256), servers: z.array(z.string().url().refine(value => new URL(value).protocol === "https:")).min(1).max(16) }).strict(),
}).strict();
const PaymentRecord = z.object({ candidateSha256: Digest, topologySha256: Digest, lightning: z.unknown(), cashu: z.unknown() }).strict();
const SigningRecord = z.object({
  candidateSha256: Digest, topologySha256: Digest, operationId: Operation, ownerPubkey: Digest,
  capabilities: z.array(z.string().min(1).max(256)).max(32), template: z.union([EventTemplate, UploadTemplate]),
}).strict();

function publicationKey(candidateSha256: string, sealedArtifactSha256: string, aggregateSha256: string): string {
  return `publication-context:${candidateSha256}:${sealedArtifactSha256}:${aggregateSha256}`;
}
function paymentKey(candidateSha256: string, operationId: string): string {
  return `payment-scenario:${candidateSha256}:${operationId}`;
}
function signingKey(intentDigest: string): string { return `nip46-intent:${intentDigest}`; }
function originalSigningKey(operationId: string): string { return `nip46-original:${operationId}`; }

/**
 * Controller-owned edge contexts.  The process cannot manufacture a sealed
 * artifact, publication intent, rail exercise, or NIP-46 template from an
 * HTTP request: each is read from the topology-scoped PostgreSQL operation
 * journal under an exact immutable key.  Missing records are unavailable,
 * never replaced with synthetic certification evidence.
 */
export class ProductionEdgeContexts {
  readonly #journal: PostgresOperationJournal;
  readonly #candidateSha256: string;
  readonly #topologySha256: string;

  constructor(input: Readonly<{ journal: PostgresOperationJournal; candidateSha256: string; topologySha256: string }>) {
    assertPostgresOperationJournal(input.journal);
    this.#journal = input.journal;
    this.#candidateSha256 = Digest.parse(input.candidateSha256);
    this.#topologySha256 = Digest.parse(input.topologySha256);
    Object.freeze(this);
  }

  #assertBinding(value: Readonly<{ candidateSha256: string; topologySha256: string }>): void {
    if (value.candidateSha256 !== this.#candidateSha256 || value.topologySha256 !== this.#topologySha256) {
      throw new Error("PRODUCTION_EDGE_CONTEXT_BINDING_REQUIRED");
    }
  }

  readonly publication: ProductionPublicationContext = Object.freeze({
    resolve: async input => {
      const candidateSha256 = Digest.parse(input.candidateSha256);
      const sealedArtifactSha256 = Digest.parse(input.sealedArtifactSha256);
      const aggregateSha256 = Digest.parse(input.aggregateSha256);
      if (candidateSha256 !== this.#candidateSha256) throw new Error("PRODUCTION_EDGE_CONTEXT_CANDIDATE_REQUIRED");
      const record = await this.#journal.read<z.input<typeof PublicationRecord>>(publicationKey(candidateSha256, sealedArtifactSha256, aggregateSha256));
      if (!record) throw new Error("PRODUCTION_EDGE_PUBLICATION_CONTEXT_UNAVAILABLE");
      const value = PublicationRecord.parse(record.value); this.#assertBinding(value);
      if (value.artifact.sealedObjectSha256 !== sealedArtifactSha256 || value.artifact.aggregateSha256 !== aggregateSha256
        || value.intent.artifactSha256 !== sealedArtifactSha256 || value.intent.aggregateSha256 !== aggregateSha256) {
        throw new Error("PRODUCTION_EDGE_PUBLICATION_CONTEXT_MISMATCH");
      }
      return Object.freeze({ artifact: Object.freeze(value.artifact) as SealedArtifactIdentity, intent: Object.freeze(value.intent) as PublicationIntent, requiredSignerCapabilities: Object.freeze([...value.requiredSignerCapabilities]), relaySet: Object.freeze([...value.relaySet]) });
    },
    deploy: async input => {
      const context = await this.publication.resolve(input);
      const record = await this.#journal.read<z.input<typeof PublicationRecord>>(publicationKey(input.candidateSha256.toLowerCase(), input.sealedArtifactSha256.toLowerCase(), input.aggregateSha256.toLowerCase()));
      if (!record) throw new Error("PRODUCTION_EDGE_PUBLICATION_CONTEXT_UNAVAILABLE");
      const value = PublicationRecord.parse(record.value); this.#assertBinding(value);
      if (Operation.parse(input.operationId) !== `deploy:${context.intent.intentId}` || value.deploy.target.dTag !== context.intent.dTag) throw new Error("PRODUCTION_EDGE_DEPLOY_CONTEXT_MISMATCH");
      const files = value.deploy.files.map(file => Object.freeze({ path: file.path, mimeType: file.mimeType, bytes: new Uint8Array(file.bytes), sha256: file.sha256, size: file.size }));
      const expectedFiles = context.artifact.sealedFiles;
      if (files.length !== expectedFiles.length || files.some(file => !expectedFiles.some(expected => expected.path === file.path && expected.mimeType === file.mimeType && expected.sha256 === file.sha256 && expected.size === file.size))) throw new Error("PRODUCTION_EDGE_DEPLOY_FILES_MISMATCH");
      return Object.freeze({
        target: Object.freeze({ kind: 35129 as const, dTag: value.deploy.target.dTag }), files: Object.freeze(files) as readonly PreSignedNamedDeployFile[], servers: Object.freeze([...value.deploy.servers]),
        /* The only permissible authorization comes from the durable original
         * NIP-46 operation record.  The concrete signer is deliberately
         * attached by the aggregate materializer, below. */
        authorizeExactHashes: async (_hashes: readonly string[]) => { throw new Error("PRODUCTION_EDGE_SIGNER_NOT_BOUND"); },
      });
    },
  });

  readonly payments: ProductionPaymentScenarioContext = Object.freeze({
    resolve: async input => {
      const candidateSha256 = Digest.parse(input.candidateSha256); const operationId = Operation.parse(input.operationId);
      if (candidateSha256 !== this.#candidateSha256) throw new Error("PRODUCTION_EDGE_CONTEXT_CANDIDATE_REQUIRED");
      const record = await this.#journal.read<z.input<typeof PaymentRecord>>(paymentKey(candidateSha256, operationId));
      if (!record) throw new Error("PRODUCTION_EDGE_PAYMENT_SCENARIO_UNAVAILABLE");
      const value = PaymentRecord.parse(record.value); this.#assertBinding(value);
      return Object.freeze({ lightning: value.lightning, cashu: value.cashu });
    },
  });

  readonly signer: Nip46PublicationContext & Nip46OriginalOperationContext = Object.freeze({
    resolve: async input => {
      const intentDigest = Digest.parse(input.intentDigest); const record = await this.#journal.read<z.input<typeof SigningRecord>>(signingKey(intentDigest));
      if (!record) throw new Error("PRODUCTION_EDGE_SIGNER_CONTEXT_UNAVAILABLE");
      const value = SigningRecord.parse(record.value); this.#assertBinding(value);
      if (value.template.kind !== 35129) throw new Error("PRODUCTION_EDGE_SIGNER_CONTEXT_INVALID");
      return Object.freeze({ operationId: value.operationId, ownerPubkey: value.ownerPubkey, capabilities: Object.freeze([...value.capabilities]), template: value.template });
    },
    resolveOriginal: async input => {
      const operationId = Operation.parse(input.operationId);
      if (input.purpose !== "upload_authorization") throw new Error("PRODUCTION_EDGE_SIGNER_CONTEXT_INVALID");
      const record = await this.#journal.read<z.input<typeof SigningRecord>>(originalSigningKey(operationId));
      if (!record) throw new Error("PRODUCTION_EDGE_SIGNER_CONTEXT_UNAVAILABLE");
      const value = SigningRecord.parse(record.value); this.#assertBinding(value);
      if (value.operationId !== operationId || value.template.kind !== 24242) throw new Error("PRODUCTION_EDGE_SIGNER_CONTEXT_INVALID");
      return Object.freeze({ intentDigest: record.identitySha256, ownerPubkey: value.ownerPubkey, capabilities: Object.freeze([...value.capabilities]), template: value.template });
    },
  });

  /** Binds the already-opened official NIP-46 signer to the exact immutable
   * upload operation. This is a typed capability, not an injected callback:
   * the signer itself re-reads its original PostgreSQL operation before it
   * contacts the external owner. */
  publicationWithSigner(signer: Readonly<{ signExactOperation(input: Readonly<{ operationId: string; purpose: "upload_authorization" }>): Promise<unknown> }>): ProductionPublicationContext {
    if (!signer || typeof signer.signExactOperation !== "function") throw new Error("PRODUCTION_EDGE_NIP46_SIGNER_REQUIRED");
    return Object.freeze({
      resolve: input => this.publication.resolve(input),
      deploy: async input => {
        const base = await this.publication.deploy(input);
        const expected = base.files.map(file => file.sha256).sort();
        const operationId = `upload_authorization:${input.operationId.slice("deploy:".length)}`;
        return Object.freeze({
          ...base,
          authorizeExactHashes: async hashes => {
            const actual = [...hashes].map(value => Digest.parse(value)).sort();
            if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) throw new Error("PRODUCTION_EDGE_UPLOAD_HASH_SCOPE_INVALID");
            return signer.signExactOperation({ operationId, purpose: "upload_authorization" });
          },
        });
      },
    });
  }
}
