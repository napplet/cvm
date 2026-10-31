import { z } from "zod";
import { verifyEvent } from "nostr-tools/pure";
import { SignedOwnerManifestEventSchema } from "../../publication/contracts";
import type { PreSignedNamedDeployFile } from "../../publication/napplet-cli-adapter";
import { ReleaseAuthorizationReceiptSchema, validateAuthorizationReceipt, validateAuthorizationRequest } from "../authorization";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Origin = z.string().url().max(512).refine(value => { const url = new URL(value); return !url.username && !url.password && !url.search && !url.hash && url.pathname === "/"
  && (url.protocol === "https:" || url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)); }).transform(value => new URL(value).origin);
const Base = z.object({ version: z.literal("direct-sealed-upload-v1"), operationId: z.string().regex(/^direct-upload:[a-f0-9]{64}$/u), intentReference: z.string().min(1).max(256),
  candidateSha256: Digest, topologySha256: Digest, effectPlanSha256: Digest,
  artifactHash: Digest, archiveSha256: Digest, ownerManifest: SignedOwnerManifestEventSchema, server: Origin,
  targetReference: z.string().min(1).max(256), retentionDays: z.number().int().min(30).max(3650), intentExpiresAtMs: z.number().int().positive().safe(),
}).strict();
export const DirectUploadScopeSchema = Base.extend({ authorizationRequestSha256: Digest, authorizationReceiptSha256: Digest }).strict();
const Config = Base.extend({ accountScopeSha256: Digest, projectScopeSha256: Digest }).strict().refine(value => value.server.startsWith("https:"), "DIRECT_UPLOAD_HTTPS_REQUIRED");
const Observation = z.object({ status: z.enum(["missing", "complete", "unknown", "pending", "blocked"]), operationId: Base.shape.operationId.optional(),
  server: Origin.optional(), targetReference: Base.shape.targetReference.optional(), retentionDays: Base.shape.retentionDays.optional(),
  artifactHash: Digest.optional(), archiveSha256: Digest.optional(), ownerEventId: Digest.optional(), fileChecksums: z.array(Digest).length(1).optional(), locationReference: z.string().max(1024).optional(),
}).strict();
export interface DirectSealedUploadPort {
  persist(value: z.input<typeof DirectUploadScopeSchema>): Promise<void>;
  observeOriginalUpload(value: Readonly<{ operationId: string; targetReference: string }>): Promise<unknown>;
  uploadExact(value: Readonly<{ operationId: string; targetReference: string; retentionDays: number; files: readonly PreSignedNamedDeployFile[]; authorization: unknown;
    effectAuthorization: Readonly<{ request: unknown; receipt: unknown }> }>): Promise<void>;
}
const sha = (value: Uint8Array) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
export function assertDirectUploadOwner(scope: z.infer<typeof Base>) {
  const tags = scope.ownerManifest.tags;
  const names = tags.filter(tag => tag[0] === "d");
  if (!verifyEvent(scope.ownerManifest) || JSON.stringify(tags.filter(tag => tag[0] === "x")) !== JSON.stringify([["x", scope.artifactHash]])
    || JSON.stringify(tags.filter(tag => tag[0] === "server")) !== JSON.stringify([["server", scope.server]]) || tags.some(tag => ["path", "requires"].includes(tag[0]!))
    || names.length !== 1 || names[0]!.length !== 2 || !/^[a-z0-9][a-z0-9-]{0,127}$/u.test(names[0]![1]!)) throw new Error("DIRECT_UPLOAD_OWNER_MANIFEST_REQUIRED");
}
type Result = Readonly<{ operationId: string; state: "complete" | "failed" | "unknown"; fullServerUploadId?: string }>;

/** Certification-only receipt boundary. Ordinary post-cutover user publication
 * must use its approved service/owner actor; this does not define that policy. */
export function createExactDirectSealedUploadAdapter(input: Readonly<{ config: unknown; request: unknown; receipt: unknown; port: DirectSealedUploadPort; now?: () => number }>) {
  const config = Config.parse(input.config), now = input.now ?? Date.now;
  assertDirectUploadOwner(config);
  const authorize = async (readOnly: boolean) => {
    try {
      const request = await validateAuthorizationRequest(input.request), original = ReleaseAuthorizationReceiptSchema.parse(input.receipt);
      const receipt = await validateAuthorizationReceipt({ request, receipt: original, nowMs: readOnly ? Math.min(now(), original.expiresAtMs - 1) : now() });
      const scopes = request.providerScopes.filter(scope => scope.provider === "upload"), effects = request.orderedEffects.filter(effect => effect.provider === "upload");
      if (request.candidateSha256 !== config.candidateSha256 || request.topologySha256 !== config.topologySha256 || request.effectPlanSha256 !== config.effectPlanSha256
        || scopes.length !== 1 || scopes[0]!.accountScopeSha256 !== config.accountScopeSha256 || scopes[0]!.projectScopeSha256 !== config.projectScopeSha256
        || effects.length !== 1 || effects[0]!.id !== "sealed-upload" || effects[0]!.operation !== "verify_integration" || request.artifactRetentionDays !== config.retentionDays
        || !readOnly && now() >= config.intentExpiresAtMs) throw new Error("scope");
      return { request, receipt };
    } catch { throw new Error("DIRECT_SEALED_UPLOAD_AUTHORIZATION_INVALID"); }
  };
  const complete = (raw: unknown): Result => {
    const observation = Observation.parse(raw);
    if (observation.status !== "complete") return { operationId: config.operationId, state: observation.status === "blocked" ? "failed" : "unknown" };
    if (observation.operationId !== config.operationId || observation.server !== config.server || observation.targetReference !== config.targetReference || observation.retentionDays !== config.retentionDays
      || observation.artifactHash !== config.artifactHash || observation.archiveSha256 !== config.archiveSha256 || observation.ownerEventId !== config.ownerManifest.id
      || JSON.stringify(observation.fileChecksums) !== JSON.stringify([config.artifactHash]) || observation.locationReference !== `${config.server}/${config.artifactHash}`) throw new Error("DIRECT_SEALED_UPLOAD_OBSERVATION_MISMATCH");
    return { operationId: config.operationId, state: "complete", fullServerUploadId: observation.locationReference };
  };
  const reconcileOriginalUpload = async (raw: Readonly<{ operationId: string }>) => {
    if (raw.operationId !== config.operationId) throw new Error("DIRECT_UPLOAD_ORIGINAL_OPERATION_REQUIRED");
    await authorize(true);
    return complete(await input.port.observeOriginalUpload({ operationId: config.operationId, targetReference: config.targetReference }));
  };
  return Object.freeze({ reconcileOriginalUpload, async uploadExact(raw: Readonly<{ operationId: string; files: readonly PreSignedNamedDeployFile[]; authorization: unknown }>) {
    if (raw.operationId !== config.operationId || raw.files.length !== 1) throw new Error("DIRECT_UPLOAD_ORIGINAL_OPERATION_REQUIRED");
    const selected = raw.files[0]!;
    if (!(selected.bytes instanceof Uint8Array) || selected.bytes.length < 1 || selected.bytes.length > 2_000_000) throw new Error("DIRECT_SEALED_UPLOAD_BYTES_INVALID");
    const file = { ...selected, bytes: new Uint8Array(selected.bytes) };
    if (file.path !== "/index.html" || file.mimeType !== "text/html" || file.size !== file.bytes.length || file.sha256 !== config.artifactHash || sha(file.bytes) !== config.artifactHash) throw new Error("DIRECT_SEALED_UPLOAD_BYTES_INVALID");
    const authorized = await authorize(false);
    const { accountScopeSha256: _account, projectScopeSha256: _project, ...base } = config;
    const scope = DirectUploadScopeSchema.parse({ ...base, authorizationRequestSha256: authorized.request.authorizationRequestSha256, authorizationReceiptSha256: authorized.receipt.authorizationReceiptSha256 });
    await input.port.persist(scope);
    const observed = Observation.parse(await input.port.observeOriginalUpload({ operationId: config.operationId, targetReference: config.targetReference }));
    if (observed.status !== "missing") return complete(observed);
    const dispatch = await authorize(false);
    try { await input.port.uploadExact({ operationId: config.operationId, targetReference: config.targetReference, retentionDays: config.retentionDays, files: [file], authorization: raw.authorization, effectAuthorization: dispatch }); }
    catch { return reconcileOriginalUpload({ operationId: config.operationId }); }
    return reconcileOriginalUpload({ operationId: config.operationId });
  } });
}
