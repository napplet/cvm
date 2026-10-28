import { createHash } from "node:crypto";
import { z } from "zod";

import type { PreSignedNamedDeployFile, StructuredSourceEffect } from "../../publication/napplet-cli-adapter.js";
import { canonicalSealedDeployAggregate } from "../../publication/napplet-cli-adapter.js";
import { ReleaseAuthorizationReceiptSchema, validateAuthorizationReceipt, validateAuthorizationRequest, type ReleaseAuthorizationReceipt, type ReleaseAuthorizationRequest } from "../authorization.js";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu).transform((value) => value.toLowerCase());
const OperationIdSchema = z.string().min(1).max(300);
const TargetReferenceSchema = z.string().min(1).max(256);
const RetentionDaysSchema = z.number().int().min(30).max(3_650);

const UploadConfigSchema = z.object({
  candidateSha256: DigestSchema,
  topologySha256: DigestSchema,
  effectPlanSha256: DigestSchema,
  accountScopeSha256: DigestSchema,
  projectScopeSha256: DigestSchema,
  sealedArtifactSha256: DigestSchema,
  aggregateSha256: DigestSchema,
  targetReference: TargetReferenceSchema,
  retentionDays: RetentionDaysSchema,
  intentExpiresAtMs: z.number().int().positive().optional(),
}).strict();
type UploadConfig = z.infer<typeof UploadConfigSchema>;

type UploadObservation = Readonly<{
  status: "missing" | "complete" | "pending" | "unknown" | "blocked";
  operationId?: string;
  targetReference?: string;
  retentionDays?: number;
  fileChecksums?: readonly string[];
  locationReference?: string;
}>;

/** The protected runner owns storage credentials; this adapter receives only exact operation calls. */
export type ExactSealedUploadPort = Readonly<{
  persist(input: Readonly<{
    operationId: string;
    authorizationRequestSha256: string;
    authorizationReceiptSha256: string;
    candidateSha256: string;
    sealedArtifactSha256: string;
    aggregateSha256: string;
    targetReference: string;
    retentionDays: number;
  }>): Promise<void>;
  observeOriginalUpload(input: Readonly<{ operationId: string; targetReference: string }>): Promise<unknown>;
  uploadExact(input: Readonly<{
    operationId: string;
    targetReference: string;
    retentionDays: number;
    files: readonly PreSignedNamedDeployFile[];
    authorization?: unknown;
  }>): Promise<void>;
}>;

export type ExactSealedUploadAdapter = Readonly<{
  uploadExact(input: Readonly<{
    operationId: string;
    files: readonly PreSignedNamedDeployFile[];
    authorizeExactHashes: (hashes: readonly string[]) => Promise<unknown>;
  }>): Promise<StructuredSourceEffect>;
  reconcileOriginalUpload(input: Readonly<{ operationId: string; files: readonly PreSignedNamedDeployFile[] }>): Promise<StructuredSourceEffect>;
}>;

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value)) && new Set(left).size === left.length;
}

function parseObservation(value: unknown): UploadObservation {
  const parsed = z.object({
    status: z.enum(["missing", "complete", "pending", "unknown", "blocked"]),
    operationId: OperationIdSchema.optional(), targetReference: TargetReferenceSchema.optional(), retentionDays: RetentionDaysSchema.optional(),
    fileChecksums: z.array(DigestSchema).max(4_096).optional(), locationReference: z.string().min(1).max(512).optional(),
  }).strict().safeParse(value);
  if (!parsed.success) throw new Error("UPLOAD_OBSERVATION_INVALID");
  return parsed.data;
}

async function authorize(input: Readonly<{ request: unknown; receipt: unknown; nowMs: number; readOnly?: boolean }>, config: UploadConfig): Promise<Readonly<{ request: ReleaseAuthorizationRequest; receipt: ReleaseAuthorizationReceipt }>> {
  try {
    const request = await validateAuthorizationRequest(input.request);
    const original = ReleaseAuthorizationReceiptSchema.parse(input.receipt);
    const receipt = await validateAuthorizationReceipt({ request, receipt: original, nowMs: input.readOnly ? Math.min(input.nowMs, original.expiresAtMs - 1) : input.nowMs });
    if (!input.readOnly && config.intentExpiresAtMs !== undefined && input.nowMs >= config.intentExpiresAtMs) throw new Error("intent_expired");
    const effects = request.orderedEffects.filter((effect) => effect.provider === "upload");
    const scopes = request.providerScopes.filter((scope) => scope.provider === "upload");
    if (request.candidateSha256 !== config.candidateSha256 || request.topologySha256 !== config.topologySha256 || request.effectPlanSha256 !== config.effectPlanSha256
      || receipt.candidateSha256 !== config.candidateSha256 || receipt.topologySha256 !== config.topologySha256 || receipt.effectPlanSha256 !== config.effectPlanSha256
      || effects.length !== 1 || effects[0]?.id !== "sealed-upload" || effects[0]?.operation !== "verify_integration"
      || scopes.length !== 1 || scopes[0]?.accountScopeSha256 !== config.accountScopeSha256 || scopes[0]?.projectScopeSha256 !== config.projectScopeSha256) throw new Error("scope");
    return Object.freeze({ request, receipt });
  } catch {
    throw new Error("SEALED_UPLOAD_AUTHORIZATION_INVALID");
  }
}

function assertExactFiles(files: readonly PreSignedNamedDeployFile[], config: UploadConfig): readonly string[] {
  if (!files.length || canonicalSealedDeployAggregate(files) !== config.aggregateSha256) throw new Error("SEALED_UPLOAD_BYTES_INVALID");
  const checksums = files.map((file) => {
    if (file.size !== file.bytes.byteLength || hash(file.bytes) !== file.sha256.toLowerCase()) throw new Error("SEALED_UPLOAD_BYTES_INVALID");
    return file.sha256.toLowerCase();
  });
  if (new Set(checksums).size !== checksums.length) throw new Error("SEALED_UPLOAD_BYTES_INVALID");
  return checksums;
}

function completed(observation: UploadObservation, operationId: string, checksums: readonly string[], config: UploadConfig): StructuredSourceEffect | undefined {
  if (observation.status !== "complete") return undefined;
  if (observation.operationId !== operationId || observation.targetReference !== config.targetReference || observation.retentionDays !== config.retentionDays
    || !observation.fileChecksums || !exactSet(observation.fileChecksums, checksums) || !observation.locationReference) throw new Error("SEALED_UPLOAD_OBSERVATION_MISMATCH");
  return Object.freeze({ operationId, state: "complete", fullServerUploadId: observation.locationReference });
}

/**
 * Exact-byte upload boundary. It persists the original operation before the
 * storage call, revalidates the exact v2 receipt immediately before that call,
 * and observes only the original operation after any ambiguity.
 */
export function createExactSealedUploadAdapter(input: Readonly<{
  config: unknown;
  request: unknown;
  receipt: unknown;
  port: ExactSealedUploadPort;
  now?: () => number;
}>): ExactSealedUploadAdapter {
  const config = Object.freeze(UploadConfigSchema.parse(input.config));
  const now = input.now ?? Date.now;

  async function reconcileOriginalUpload(raw: Readonly<{ operationId: string; files: readonly PreSignedNamedDeployFile[] }>): Promise<StructuredSourceEffect> {
    const operationId = OperationIdSchema.parse(raw.operationId);
    const checksums = assertExactFiles(raw.files, config);
    await authorize({ request: input.request, receipt: input.receipt, nowMs: now(), readOnly: true }, config);
    const observation = parseObservation(await input.port.observeOriginalUpload({ operationId, targetReference: config.targetReference }));
    return completed(observation, operationId, checksums, config) ?? Object.freeze({ operationId, state: observation.status === "blocked" ? "failed" : "unknown" });
  }

  return Object.freeze({
    reconcileOriginalUpload,
    async uploadExact(raw) {
      const operationId = OperationIdSchema.parse(raw.operationId);
      const checksums = assertExactFiles(raw.files, config);
      const authorized = await authorize({ request: input.request, receipt: input.receipt, nowMs: now() }, config);
      await input.port.persist({
        operationId, authorizationRequestSha256: authorized.request.authorizationRequestSha256, authorizationReceiptSha256: authorized.receipt.authorizationReceiptSha256,
        candidateSha256: config.candidateSha256, sealedArtifactSha256: config.sealedArtifactSha256, aggregateSha256: config.aggregateSha256,
        targetReference: config.targetReference, retentionDays: config.retentionDays,
      });
      const existing = parseObservation(await input.port.observeOriginalUpload({ operationId, targetReference: config.targetReference }));
      const prior = completed(existing, operationId, checksums, config);
      if (prior) return prior;
      if (existing.status !== "missing") return Object.freeze({ operationId, state: existing.status === "blocked" ? "failed" : "unknown" });
      const authorization = await raw.authorizeExactHashes(Object.freeze([...checksums]));
      // Revalidate after the authorization callback and immediately before the external upload.
      await authorize({ request: input.request, receipt: input.receipt, nowMs: now() }, config);
      try {
        await input.port.uploadExact({ operationId, targetReference: config.targetReference, retentionDays: config.retentionDays, authorization, files: raw.files.map((file) => Object.freeze({ ...file, bytes: new Uint8Array(file.bytes) })) });
      } catch {
        return reconcileOriginalUpload({ operationId, files: raw.files });
      }
      return reconcileOriginalUpload({ operationId, files: raw.files });
    },
  });
}
