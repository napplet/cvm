import { z } from "zod";
import { accountIdForPrincipal } from "../domain/account-command";
import { maximumOperationCharge, type ModelProfile, type PriceCard } from "../model/price-card";
import { canonicalJson } from "../promotion/schema";
import type { PreAdmissionFundingStore } from "../persistence/funding-store";
import { PendingActionEnvelopeService } from "./checkpoint-envelope";
import { PendingActionRecordSchema, PendingStartCommandSchema, ResumePreAdmissionCommandSchema, type PendingActionRecord, type PendingStartCommand } from "./contracts";
import { SessionActionResultSchema, type MeteredGenerationService, type SessionActionResult } from "../phase-04/metered-generation-service";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1_000;
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const OwnerSchema = z.object({ ownerId: z.string().regex(/^[a-f0-9]{64}$/u), accountId: z.string().min(1) }).strict();
const PinsSchema = z.object({ policyVersion: z.string().min(1), profileId: z.string().min(1), priceCardId: z.string().min(1), toolchainId: z.string().min(1), rootManifestSha256: Sha256Schema }).strict();

export type PreAdmissionPins = z.infer<typeof PinsSchema>;
export type PreAdmissionOwner = z.infer<typeof OwnerSchema>;
export type PreAdmissionSaveResult = Readonly<{ status: "saved"; checkpointId: string; reference: string; fingerprint: string; maximum: string; shortfall: string; version: 1; expiresAtMs: number }> | Readonly<{ status: "funded_admission_required"; maximum: string }>;

function freeze<T>(value: T): T { return Object.freeze(value); }
async function hash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function terminal(result: SessionActionResult): result is Extract<SessionActionResult, { operationId: string }> {
  return result.status === "completed" || result.status === "failed" || result.status === "billing_invariant_failed";
}

/**
 * Transport-neutral authority for a command that is valid but currently not
 * admitted.  It owns no session/lease/worker effect; the only transition to
 * generation is a separately signed resume after a same-owner accepted hold.
 */
export class PreAdmissionSessionService {
  readonly #now: () => number;
  constructor(private readonly options: Readonly<{
    store: PreAdmissionFundingStore;
    envelope: PendingActionEnvelopeService;
    generation: Pick<MeteredGenerationService, "startSessionAfterAdmission">;
    pricing: Readonly<{ card: PriceCard; profile: ModelProfile }>;
    pins: PreAdmissionPins;
    now?: () => number;
  }>) { this.#now = options.now ?? Date.now; PinsSchema.parse(options.pins); }

  async saveStart(input: Readonly<{ owner: PreAdmissionOwner; command: PendingStartCommand }>): Promise<PreAdmissionSaveResult> {
    const owner = OwnerSchema.parse(input.owner); const command = PendingStartCommandSchema.parse(input.command);
    if (await accountIdForPrincipal({ pubkey: owner.ownerId }) !== owner.accountId) throw new Error("PENDING_ACTION_OWNER_ACCOUNT_MISMATCH");
    const ceiling = maximumOperationCharge(this.options.pricing);
    if (BigInt(command.maximum) < BigInt(ceiling)) throw new Error("ACTION_MAXIMUM_BELOW_PROFILE_CEILING");
    const fingerprint = await hash({ owner, command });
    const checkpointId = `pending-action:${(await hash({ accountId: owner.accountId, idempotencyKey: command.idempotencyKey })).slice(0, 32)}`;
    const reference = `pending:${(await hash({ checkpointId, fingerprint })).slice(0, 32)}`;
    const pins = PinsSchema.parse(this.options.pins);
    const status = await this.options.store.status(owner.accountId); const available = BigInt(status?.available ?? "0");
    const existing = await this.options.store.findPendingAction(owner.accountId, command.idempotencyKey);
    if (existing) {
      this.#assertRecord(existing, owner, command, fingerprint, pins);
      if (this.#now() >= existing.expiresAtMs) throw new Error("PENDING_ACTION_EXPIRED");
      if (existing.state === "completed" || existing.state === "failed") throw new Error("PENDING_ACTION_ALREADY_TERMINAL");
      return freeze({ status: "saved", checkpointId: existing.checkpointId, reference: existing.reference, fingerprint: existing.commandFingerprint, maximum: existing.maximum, shortfall: (BigInt(existing.maximum) - available > 0n ? BigInt(existing.maximum) - available : 0n).toString(), version: 1, expiresAtMs: existing.expiresAtMs });
    }
    if (available >= BigInt(command.maximum)) return freeze({ status: "funded_admission_required", maximum: command.maximum });
    const expiresAtMs = this.#now() + THIRTY_DAYS_MS;
    const envelope = await this.options.envelope.seal({
      header: { schemaVersion: "pending-action-envelope-v1", kind: "pending_action", checkpointId, checkpointVersion: 1, ownerId: owner.ownerId, accountId: owner.accountId, commandFingerprint: fingerprint, expiresAtMs, expectedSessionVersion: 0, expectedArtifactVersion: 0, ...pins },
      command,
    });
    const record = await this.options.store.createOrReplayPendingAction({ checkpointId, ownerId: owner.ownerId, accountId: owner.accountId, idempotencyKey: command.idempotencyKey, commandFingerprint: fingerprint, reference, maximum: command.maximum, envelope, expiresAtMs });
    this.#assertRecord(record, owner, command, fingerprint, pins);
    return freeze({ status: "saved", checkpointId: record.checkpointId, reference: record.reference, fingerprint: record.commandFingerprint, maximum: record.maximum, shortfall: (BigInt(record.maximum) - available).toString(), version: 1, expiresAtMs: record.expiresAtMs });
  }

  async status(input: Readonly<{ owner: PreAdmissionOwner; checkpointId: string }>): Promise<PendingActionRecord | undefined> {
    const owner = OwnerSchema.parse(input.owner); const record = await this.options.store.findPendingActionByCheckpoint(owner.accountId, input.checkpointId);
    if (!record || record.ownerId !== owner.ownerId) return undefined;
    return record;
  }

  async resume(input: Readonly<{ owner: PreAdmissionOwner; command: unknown }>): Promise<SessionActionResult> {
    const owner = OwnerSchema.parse(input.owner); const command = ResumePreAdmissionCommandSchema.parse(input.command);
    if (await accountIdForPrincipal({ pubkey: owner.ownerId }) !== owner.accountId) throw new Error("PENDING_ACTION_OWNER_ACCOUNT_MISMATCH");
    const record = await this.options.store.findPendingActionByCheckpoint(owner.accountId, command.checkpointId);
    if (!record || record.ownerId !== owner.ownerId || record.state === "saved" && this.#now() >= record.expiresAtMs) throw new Error("PENDING_ACTION_NOT_FOUND_OR_DENIED");
    if (record.reference !== command.pendingAction.reference || record.commandFingerprint !== command.pendingAction.fingerprint || record.maximum !== command.pendingAction.maximum || command.expectedSessionVersion !== 0 || command.expectedCheckpointVersion !== 1) throw new Error("PENDING_ACTION_RESUME_CONFLICT");
    const restored = await this.options.envelope.open(record.envelope, this.#now());
    const denied = (stage: string) => new Error("PENDING_ACTION_RESTORE_DENIED", { cause: new Error(stage) });
    const pins = PinsSchema.parse(this.options.pins);
    if (restored.header.ownerId !== owner.ownerId) throw denied("PENDING_ACTION_RESTORE_OWNER_MISMATCH");
    if (restored.header.accountId !== owner.accountId) throw denied("PENDING_ACTION_RESTORE_ACCOUNT_MISMATCH");
    if (restored.header.checkpointId !== record.checkpointId) throw denied("PENDING_ACTION_RESTORE_CHECKPOINT_MISMATCH");
    if (restored.header.commandFingerprint !== record.commandFingerprint) throw denied("PENDING_ACTION_RESTORE_HEADER_FINGERPRINT_MISMATCH");
    if (restored.header.expectedSessionVersion !== 0 || restored.header.expectedArtifactVersion !== 0) throw denied("PENDING_ACTION_RESTORE_VERSION_MISMATCH");
    if (restored.header.policyVersion !== pins.policyVersion) throw denied("PENDING_ACTION_RESTORE_POLICY_PIN_MISMATCH");
    if (restored.header.profileId !== pins.profileId) throw denied("PENDING_ACTION_RESTORE_PROFILE_PIN_MISMATCH");
    if (restored.header.priceCardId !== pins.priceCardId) throw denied("PENDING_ACTION_RESTORE_PRICE_CARD_PIN_MISMATCH");
    if (restored.header.toolchainId !== pins.toolchainId) throw denied("PENDING_ACTION_RESTORE_TOOLCHAIN_PIN_MISMATCH");
    if (restored.header.rootManifestSha256 !== pins.rootManifestSha256) throw denied("PENDING_ACTION_RESTORE_MANIFEST_PIN_MISMATCH");
    if (restored.command.maximum !== record.maximum) throw denied("PENDING_ACTION_RESTORE_MAXIMUM_MISMATCH");
    const exactFingerprint = await hash({ owner, command: restored.command });
    if (exactFingerprint !== record.commandFingerprint) throw denied("PENDING_ACTION_RESTORE_COMMAND_FINGERPRINT_MISMATCH");
    if (restored.command.idempotencyKey !== record.idempotencyKey) throw denied("PENDING_ACTION_RESTORE_IDEMPOTENCY_MISMATCH");
    const resumeFingerprint = await hash({ owner, checkpointId: command.checkpointId, idempotencyKey: command.idempotencyKey, admissionReference: command.admissionReference, pendingAction: command.pendingAction });
    if ((record.state === "completed" || record.state === "failed") && (record.admissionReference !== command.admissionReference || record.resumeIdempotencyKey !== command.idempotencyKey || record.resumeFingerprint !== resumeFingerprint)) throw new Error("PENDING_ACTION_RESUME_CONFLICT");
    if (record.state === "completed" || record.state === "failed") return SessionActionResultSchema.parse(record.result);
    const claim = await this.options.store.claimPendingActionResume({ accountId: owner.accountId, ownerId: owner.ownerId, checkpointId: command.checkpointId, idempotencyKey: command.idempotencyKey, resumeFingerprint, admissionReference: command.admissionReference, nowMs: this.#now() });
    const result = await this.options.generation.startSessionAfterAdmission({ principal: { pubkey: owner.ownerId }, admissionReference: command.admissionReference, idempotencyKey: restored.command.idempotencyKey, expectedVersion: 0, maximum: restored.command.maximum, policyVersion: restored.command.policyVersion, idea: restored.command.idea, ...(restored.command.remixReference ? { remixReference: restored.command.remixReference } : {}) });
    if (terminal(result)) await this.options.store.completePendingAction({ checkpointId: claim.action.checkpointId, operationId: result.operationId, result, state: result.status === "completed" ? "completed" : "failed" });
    return result;
  }

  #assertRecord(record: PendingActionRecord, owner: PreAdmissionOwner, command: PendingStartCommand, fingerprint: string, pins: PreAdmissionPins): void {
    const parsed = PendingActionRecordSchema.parse(record);
    if (parsed.ownerId !== owner.ownerId || parsed.accountId !== owner.accountId || parsed.idempotencyKey !== command.idempotencyKey || parsed.commandFingerprint !== fingerprint || parsed.maximum !== command.maximum || parsed.envelope.header.commandFingerprint !== fingerprint || parsed.envelope.header.policyVersion !== pins.policyVersion || parsed.envelope.header.profileId !== pins.profileId || parsed.envelope.header.priceCardId !== pins.priceCardId || parsed.envelope.header.toolchainId !== pins.toolchainId || parsed.envelope.header.rootManifestSha256 !== pins.rootManifestSha256) throw new Error("PENDING_ACTION_REPLAY_CONFLICT");
  }
}
