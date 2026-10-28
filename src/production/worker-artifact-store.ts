import { createHash } from "node:crypto";
import { z } from "zod";
import { ImmutableObjectReferenceSchema, type ObjectStorePort } from "../continuity/object-store";
import { WorkerRunRequestSchema, WorkerRunResultSchema, type WorkerRunRequest } from "../phase-02/contracts";
import { canonicalJson } from "../promotion/schema";
import { assertPostgresOperationJournal, PostgresOperationJournal } from "../release/deployment/postgres-operation-journal";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Completed = WorkerRunResultSchema.options[1];
const Evidence = z.object({
  version: z.literal(1), requestSha256: Digest, toolchainSha256: Digest,
  accountId: z.string().regex(/^account:[a-f0-9]{64}$/u), ownerId: Digest,
  scannerReportSha256: Digest, conformanceReportSha256: Digest,
  result: Completed, checksum: Digest,
}).strict();
const Record = z.object({ evidence: Evidence, reference: ImmutableObjectReferenceSchema.optional() }).strict();
type Evidence = z.infer<typeof Evidence>;
const objectKey = (evidence: Evidence) => `artifacts/${evidence.requestSha256}/${evidence.checksum}.json`;
const operation = (request: WorkerRunRequest) => `worker-artifact:${sha(canonicalJson({ sessionId: request.sessionId, actionId: request.actionId, expectedVersion: request.expectedVersion }))}`;

/** Internal verified-output writer. The original claim is the sole upload
 * permission; all later calls reconcile its exact key/checksum without writes.
 * This index is not a customer artifact authorization or a publication receipt. */
export class ProductionWorkerArtifactStore {
  constructor(private readonly input: Readonly<{ journal: PostgresOperationJournal; objects: ObjectStorePort; toolchainSha256: string; retainedToolchainSha256s?: readonly string[] }>) {
    assertPostgresOperationJournal(input.journal); Digest.parse(input.toolchainSha256);
    if ((input.retainedToolchainSha256s?.length ?? 0) > 9) throw new Error("PRODUCTION_ARTIFACT_TOOLCHAINS_INVALID");
    input.retainedToolchainSha256s?.forEach(value => Digest.parse(value));
    this.input = Object.freeze({ ...input, retainedToolchainSha256s: Object.freeze([...(input.retainedToolchainSha256s ?? [])]) });
  }
  async persist(input: Readonly<{ request: WorkerRunRequest; accountId: string; ownerId: string; bytes: Uint8Array; scannerReportSha256: string; conformanceReportSha256: string; result: z.input<typeof Completed> }>) {
    const request = WorkerRunRequestSchema.parse(input.request);
    if (input.bytes.byteLength > 24 * 1024 * 1024) throw new Error("PRODUCTION_ARTIFACT_ARCHIVE_LIMIT");
    const evidence = Evidence.parse({ version: 1, requestSha256: sha(canonicalJson(request)), toolchainSha256: this.input.toolchainSha256, accountId: input.accountId, ownerId: input.ownerId, checksum: sha(input.bytes), scannerReportSha256: input.scannerReportSha256, conformanceReportSha256: input.conformanceReportSha256, result: input.result });
    this.#validate(request, evidence);
    const identity = sha(canonicalJson(evidence));
    const claim = await this.input.journal.claim(operation(request), identity, { evidence });
    if (claim.claimed) {
      // A thrown acknowledgement is ambiguous. Leave the original intent for
      // observation; never give its loser permission to upload again.
      const reference = ImmutableObjectReferenceSchema.parse(await this.input.objects.createImmutable({ key: objectKey(evidence), bytes: input.bytes }));
      if (reference.key !== objectKey(evidence) || reference.checksum !== evidence.checksum) throw new Error("PRODUCTION_ARTIFACT_REFERENCE_MISMATCH");
      await this.input.journal.compareAndSet(operation(request), identity, claim.record.revision, { evidence, reference });
    }
    const stored = await this.read(request);
    if (!stored) throw new Error("PRODUCTION_ARTIFACT_UPLOAD_UNCERTAIN");
    return stored;
  }
  /** Query-only recovery, including a create acknowledgement lost before CAS. */
  async read(value: WorkerRunRequest) {
    const request = WorkerRunRequestSchema.parse(value), id = operation(request);
    const original = await this.input.journal.read(id);
    if (!original) return undefined; // Historical cache-only builds stay unavailable.
    const record = Record.parse(original.value), evidence = record.evidence;
    this.#validate(request, evidence);
    if (original.identitySha256 !== sha(canonicalJson(evidence))) throw new Error("PRODUCTION_ARTIFACT_RECORD_MISMATCH");
    const reference = record.reference ?? await this.input.objects.observeExactByKey({ key: objectKey(evidence), checksum: evidence.checksum });
    if (!reference) return undefined;
    if (reference.key !== objectKey(evidence) || reference.checksum !== evidence.checksum) throw new Error("PRODUCTION_ARTIFACT_REFERENCE_MISMATCH");
    const bytes = await this.input.objects.readExact(reference);
    if (!bytes || bytes.byteLength > 24 * 1024 * 1024 || sha(bytes) !== evidence.checksum) return undefined;
    if (!record.reference) await this.input.journal.compareAndSet(id, original.identitySha256, original.revision, { evidence, reference });
    return Object.freeze({ ...evidence, reference, bytes });
  }
  #validate(request: WorkerRunRequest, evidence: Evidence) {
    if (evidence.requestSha256 !== sha(canonicalJson(request)) || (evidence.toolchainSha256 !== this.input.toolchainSha256 && !this.input.retainedToolchainSha256s?.includes(evidence.toolchainSha256)) || evidence.result.artifact.artifactId !== `artifact:${evidence.checksum}`) throw new Error("PRODUCTION_ARTIFACT_REQUEST_MISMATCH");
    for (const field of ["sessionId", "actionId", "expectedVersion", "policyVersion", "capabilityGrant", "workspaceId"] as const) if (request[field] !== evidence.result.artifact[field]) throw new Error("PRODUCTION_ARTIFACT_REQUEST_MISMATCH");
  }
}
