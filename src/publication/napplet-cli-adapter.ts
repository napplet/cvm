import { createHash } from "node:crypto";

import { SignedOwnerManifestEventSchema, type PublicationObservation, type SealedArtifactIdentity, type SignedOwnerManifestEvent } from "./contracts.js";
import { NAPPLET_CLI_LINUX_SHA256, NAPPLET_CLI_SOURCE_COMMIT, type PromotedCliSourceContractResult } from "./napplet-cli-source-contract.js";
import { normalizePublicationDTag } from "./publication-intent.js";

export const NAPPLET_CLI_PROMOTED_IDENTITY = Object.freeze({ version: "0.5.2", sourceCommit: NAPPLET_CLI_SOURCE_COMMIT, linuxSha256: NAPPLET_CLI_LINUX_SHA256 });
export type PromotedNappletCliIdentity = Readonly<typeof NAPPLET_CLI_PROMOTED_IDENTITY>;
export type PreSignedNamedDeployFile = Readonly<{ path: string; mimeType: string; bytes: Uint8Array; sha256: string; size: number }>;
export type PreSignedNamedDeployInput = Readonly<{
  operationId: string;
  artifact: SealedArtifactIdentity;
  target: Readonly<{ kind: 35129; dTag: string }>;
  sealedFiles: readonly PreSignedNamedDeployFile[];
  deployFiles: readonly PreSignedNamedDeployFile[];
  ownerEvent: SignedOwnerManifestEvent;
  servers: readonly string[];
  relays: readonly string[];
  authorizeExactHashes: (hashes: readonly string[]) => Promise<unknown>;
}>;
export type StructuredDeployProgress = Readonly<{ operationId: string; stage: "upload" | "relay"; state: "complete" | "partial" | "failed" | "unknown" }>;
export type StructuredSourceEffect = Readonly<{ operationId: string; state: "complete" | "partial" | "failed" | "unknown"; fullServerUploadId?: string; relayObservation?: string }>;
export type PromotedNappletCliSourcePort = Readonly<{
  uploadFilesToServers(input: Readonly<{ operationId: string; target: Readonly<{ kind: 35129; dTag: string }>; files: readonly PreSignedNamedDeployFile[]; servers: readonly string[]; authorizeExactHashes: (hashes: readonly string[]) => Promise<unknown> }>): Promise<StructuredSourceEffect>;
  publishEventWithSimplePool(input: Readonly<{ operationId: string; event: SignedOwnerManifestEvent; relays: readonly string[] }>): Promise<StructuredSourceEffect>;
  networkDeploySucceeded(input: Readonly<{ upload: StructuredSourceEffect; relay: StructuredSourceEffect }>): boolean;
}>;
export type PromotedDeployResult = Readonly<{ state: "completed" | "partial" | "failed" | "unknown" | "publication_unavailable"; operationId: string; fullServerUploadId?: string; relayObservation?: string; safeReasonCode?: "PUBLICATION_UNAVAILABLE" }>;

const SHA256 = /^[a-f0-9]{64}$/iu;
const bytesEqual = (left: Uint8Array, right: Uint8Array) => left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const exactSet = (left: readonly string[], right: readonly string[]) => left.length === right.length && left.every((value) => right.includes(value)) && new Set(left).size === left.length;

/** Hashes the verified file-manifest facts in a deterministic path order. */
export function canonicalSealedDeployAggregate(files: readonly Readonly<{ path: string; mimeType: string; sha256: string; size: number }>[]): string {
  const ordered = [...files].sort((left, right) => left.path.localeCompare(right.path));
  if (!ordered.length || ordered.some((file, index) => !file.path.startsWith("/") || !file.mimeType || !SHA256.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0 || (index > 0 && ordered[index - 1]?.path === file.path))) throw new Error("SEALED_NAMED_DEPLOY_INVALID");
  return createHash("sha256").update(JSON.stringify({ version: 1, files: ordered.map(({ path, mimeType, sha256, size }) => ({ path, mimeType, sha256: sha256.toLowerCase(), size })) })).digest("hex");
}

export function assertPromotedCliIdentity(identity: PromotedNappletCliIdentity): PromotedNappletCliIdentity {
  if (identity.version !== NAPPLET_CLI_PROMOTED_IDENTITY.version || identity.sourceCommit !== NAPPLET_CLI_PROMOTED_IDENTITY.sourceCommit || identity.linuxSha256 !== NAPPLET_CLI_PROMOTED_IDENTITY.linuxSha256) throw new Error("PROMOTED_CLI_IDENTITY_MISMATCH");
  return NAPPLET_CLI_PROMOTED_IDENTITY;
}

export function assertAvailablePromotedCliSourceContract(contract: PromotedCliSourceContractResult): Extract<PromotedCliSourceContractResult, { status: "available" }> {
  if (contract.status !== "available") throw new Error("PUBLICATION_UNAVAILABLE");
  return contract;
}

/** Verifies the service-owned sealed records before any external source facade is called. */
export function assertSealedNamedDeployPlan(input: PreSignedNamedDeployInput): void {
  if (!input.operationId || input.target.kind !== 35129 || normalizePublicationDTag(input.target.dTag) !== input.artifact.normalizedDTag || canonicalSealedDeployAggregate(input.artifact.sealedFiles) !== input.artifact.aggregateSha256) throw new Error("SEALED_NAMED_DEPLOY_INVALID");
  SignedOwnerManifestEventSchema.parse(input.ownerEvent);
  if (input.ownerEvent.kind !== 35129 || input.ownerEvent.tags.find((tag) => tag[0] === "d")?.[1] !== input.artifact.normalizedDTag) throw new Error("SEALED_NAMED_DEPLOY_INVALID");
  if (!input.sealedFiles.length || input.sealedFiles.length !== input.artifact.sealedFiles.length || input.sealedFiles.length !== input.deployFiles.length || !input.servers.length || !input.relays.length) throw new Error("SEALED_NAMED_DEPLOY_INVALID");
  const paths = new Set<string>();
  for (const [index, sealed] of input.sealedFiles.entries()) {
    const deploy = input.deployFiles[index];
    const trusted = input.artifact.sealedFiles.find((file) => file.path === sealed.path);
    if (!deploy || !trusted || !sealed.path.startsWith("/") || !sealed.mimeType || !SHA256.test(sealed.sha256) || sealed.size !== sealed.bytes.byteLength || digest(sealed.bytes) !== sealed.sha256 || paths.has(sealed.path) || sealed.mimeType !== trusted.mimeType || sealed.size !== trusted.size || sealed.sha256.toLowerCase() !== trusted.sha256.toLowerCase() || sealed.path !== deploy.path || sealed.mimeType !== deploy.mimeType || sealed.size !== deploy.size || sealed.sha256 !== deploy.sha256 || !bytesEqual(sealed.bytes, deploy.bytes)) throw new Error("SEALED_NAMED_DEPLOY_INVALID");
    paths.add(sealed.path);
  }
}

export function toPublicationObservation(result: PromotedDeployResult): PublicationObservation {
  const state = result.state === "completed" ? "completed" : result.state === "failed" ? "failed" : "unknown";
  return { operationId: result.operationId, state, observationId: `observation:${result.operationId}`, fullServerUploadId: result.fullServerUploadId, relayObservation: result.relayObservation };
}

/**
 * A narrow facade over the promoted source's typed lower-level functions. No CLI command,
 * filesystem discovery, signer, manifest factory, binary, stdout, or npm package is reachable.
 */
export class PromotedNappletCliAdapter {
  readonly identity: PromotedNappletCliIdentity;

  constructor(private readonly dependencies: Readonly<{ contract: PromotedCliSourceContractResult; source: PromotedNappletCliSourcePort; identity?: PromotedNappletCliIdentity }>) {
    this.identity = assertPromotedCliIdentity(dependencies.identity ?? NAPPLET_CLI_PROMOTED_IDENTITY);
  }

  async deployPreSignedNamed(input: PreSignedNamedDeployInput): Promise<PromotedDeployResult> {
    if (this.dependencies.contract.status !== "available") return { state: "publication_unavailable", operationId: input.operationId, safeReasonCode: "PUBLICATION_UNAVAILABLE" };
    assertSealedNamedDeployPlan(input);
    const hashes = input.sealedFiles.map((file) => file.sha256);
    const authorizeExactHashes = async (requested: readonly string[]) => {
      if (!exactSet([...requested], hashes)) throw new Error("BLOSSOM_AUTHORIZATION_SCOPE_INVALID");
      return input.authorizeExactHashes(hashes);
    };
    const upload = await this.dependencies.source.uploadFilesToServers({ operationId: input.operationId, target: input.target, files: input.sealedFiles, servers: input.servers, authorizeExactHashes });
    if (upload.operationId !== input.operationId) throw new Error("PUBLICATION_OBSERVATION_OPERATION_MISMATCH");
    if (upload.state !== "complete") return { state: upload.state === "partial" ? "partial" : upload.state, operationId: input.operationId, fullServerUploadId: upload.fullServerUploadId };
    const relay = await this.dependencies.source.publishEventWithSimplePool({ operationId: input.operationId, event: input.ownerEvent, relays: input.relays });
    if (relay.operationId !== input.operationId) throw new Error("PUBLICATION_OBSERVATION_OPERATION_MISMATCH");
    const complete = this.dependencies.source.networkDeploySucceeded({ upload, relay });
    return { state: complete ? "completed" : relay.state === "failed" ? "failed" : relay.state === "unknown" ? "unknown" : "partial", operationId: input.operationId, fullServerUploadId: upload.fullServerUploadId, relayObservation: relay.relayObservation };
  }
}
