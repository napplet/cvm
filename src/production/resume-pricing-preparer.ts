import { createHash } from "node:crypto";
import { z } from "zod";
import { PendingActionIntentSchema } from "../continuity/contracts";
import { validatePendingCommandCheckpointArchive } from "../continuity/checkpoint-envelope";
import { prepareResumePricingQuote, ResumePricingContextSchema } from "../continuity/resume-pricing";
import { PrepareResumeCommandSchema, PrepareResumeResultSchema, projectResumePricingQuote } from "../continuity/resume-v2-contracts";
import { convertUsdMicrosToSats, maximumOperationCharge, type createVertexGeminiProductionPricing } from "../model/price-card";
import type { ContinuationFundingStore } from "../persistence/funding-store";
import type { PostgresSqlPool } from "../persistence/postgres-sql-funding-store";
import type { PostgresOperationJournal } from "../release/deployment/postgres-operation-journal";
import { canonicalJson } from "../promotion/schema";
import type { GenerationCommand } from "../phase-04/metered-generation-service";
import { ProductionCheckpointCoordinator, assertProductionCheckpointCoordinator } from "./checkpoint-coordinator";
import { readProductionPendingPricing } from "./pricing-catalog";
import { ProductionResumePricingQuotes } from "./resume-pricing-quotes";
import { readOriginalPendingVertexSettlement } from "./vertex-generation-settlement";

type PrepareCommand = z.infer<typeof PrepareResumeCommandSchema>;
type PrepareResult = z.infer<typeof PrepareResumeResultSchema>;
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");

/** The quote owner is the verified request principal. All command, checkpoint,
 * original pricing and FX data comes from server-owned durable authorities.
 * No worker allocation, funds reservation, provider dispatch or signing occurs. */
export class ProductionResumePricingPreparer {
  constructor(private readonly input: Readonly<{
    pool: PostgresSqlPool;
    store: Pick<ContinuationFundingStore, "findContinuationCheckpoint" | "findContinuationPause">;
    checkpoint: ProductionCheckpointCoordinator;
    quotes: ProductionResumePricingQuotes;
    vertexJournal: PostgresOperationJournal;
    currentPricing: Awaited<ReturnType<typeof createVertexGeminiProductionPricing>>;
    compatibility: Readonly<{ policyVersion: string; acceptedToolchains: readonly string[] }>;
    now?: () => number;
  }>) { assertProductionCheckpointCoordinator(input.checkpoint); }

  async prepare(raw: unknown): Promise<PrepareResult> {
    const parsed = PrepareResumeCommandSchema.safeParse(raw);
    if (!parsed.success) return { status: "denied", code: "RESUME_INVALID_COMMAND" };
    const command = parsed.data;
    try {
      const prior = await this.input.quotes.findPreparation(command.principal.id, command.idempotencyKey);
      if (prior) {
        if (prior.context.sessionId !== command.sessionId || prior.context.checkpointId !== command.checkpointId
          || prior.context.expectedSessionVersion !== command.expectedSessionVersion || prior.context.checkpointVersion !== command.expectedCheckpointVersion)
          return { status: "denied", code: "RESUME_STALE_OR_CONFLICTING" };
        return await projectResumePricingQuote(prior);
      }
      const authority = await this.loadAuthority(command);
      const quote = await prepareResumePricingQuote({ context: authority.context, pricing: this.input.currentPricing,
        preparationKey: command.idempotencyKey, nowMs: (this.input.now ?? Date.now)(), lifetimeMs: 300_000 });
      return await projectResumePricingQuote(await this.input.quotes.save(quote));
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code === "RESUME_CHECKPOINT_NOT_FOUND_OR_DENIED") return { status: "denied", code };
      if (code === "RESUME_STALE_OR_CONFLICTING" || code === "RESUME_QUOTE_PREPARATION_CONFLICT") return { status: "denied", code: "RESUME_STALE_OR_CONFLICTING" };
      if (code === "RESUME_COMPATIBILITY_DENIED" || code === "RESUME_QUOTE_EXCEEDS_COMMAND_MAXIMUM") return { status: "blocked", code };
      return { status: "blocked", code: "RESUME_PRICE_AUTHORITY_UNAVAILABLE" };
    }
  }

  /** Coordinator-only read for preparation and later acceptance revalidation.
   * Returned private material must never be projected as a tool response. */
  async loadAuthority(raw: unknown) {
    const request = PrepareResumeCommandSchema.parse(raw), accountId = request.principal.id;
    const checkpoint = await this.input.store.findContinuationCheckpoint(accountId, request.checkpointId);
    if (!checkpoint || checkpoint.accountId !== accountId || checkpoint.sessionId !== request.sessionId) throw new Error("RESUME_CHECKPOINT_NOT_FOUND_OR_DENIED");
    const nowMs = (this.input.now ?? Date.now)();
    if (checkpoint.state !== "resume_required" || checkpoint.expectedSessionVersion !== request.expectedSessionVersion || checkpoint.retentionDeadlineMs <= nowMs)
      throw new Error("RESUME_STALE_OR_CONFLICTING");
    const pause = await this.input.store.findContinuationPause(accountId, request.sessionId, checkpoint.pauseGeneration);
    if (!pause || pause.state !== "resume_required") throw new Error("RESUME_STALE_OR_CONFLICTING");
    const intent = PendingActionIntentSchema.parse(pause.intent);
    if (intent.accountId !== accountId || intent.sessionId !== request.sessionId || intent.fingerprint !== pause.pendingFingerprint
      || intent.expectedSessionVersion !== checkpoint.expectedSessionVersion || intent.expectedArtifactVersion !== checkpoint.expectedArtifactVersion
      || !intent.commandSha256) throw new Error("RESUME_STALE_OR_CONFLICTING");
    if (intent.policyVersion !== this.input.compatibility.policyVersion || !this.input.compatibility.acceptedToolchains.includes(intent.toolchainId))
      throw new Error("RESUME_COMPATIBILITY_DENIED");
    const material = await this.input.checkpoint.loadExact({ checkpointId: request.checkpointId, accountId, sessionId: request.sessionId });
    const { manifest, envelope } = material;
    if (manifest.checkpointId !== checkpoint.checkpointId || manifest.accountId !== accountId || manifest.sessionId !== request.sessionId
      || manifest.pauseGeneration !== checkpoint.pauseGeneration || manifest.sessionVersion !== intent.expectedSessionVersion
      || manifest.artifactVersion !== intent.expectedArtifactVersion || manifest.action.pendingActionReference !== intent.reference
      || manifest.action.idempotencyKey !== intent.idempotencyKey || manifest.action.ledgerReference !== intent.admissionReference
      || manifest.compatibility.policyVersion !== intent.policyVersion || manifest.compatibility.modelIdentity !== intent.profileId
      || manifest.compatibility.nappletSdkIdentity !== intent.priceCardId || manifest.compatibility.toolchainIdentity !== intent.toolchainId
      || Date.parse(manifest.retentionUntil) !== checkpoint.retentionDeadlineMs
      || envelope.manifestSha256 !== hash(manifest) || envelope.object.key !== checkpoint.objectKey
      || String(envelope.object.generation) !== checkpoint.objectGeneration || envelope.object.checksum !== checkpoint.objectChecksum
      || envelope.crypto.keyReference !== checkpoint.keyReference) throw new Error("RESUME_CHECKPOINT_BINDING_DENIED");

    const archive = await this.input.checkpoint.restore({ checkpointId: request.checkpointId, accountId, sessionId: request.sessionId });
    let command: GenerationCommand;
    try {
      command = manifest.payloadKind === "pending_command"
        ? await this.input.checkpoint.pendingCommands.validateRetained(validatePendingCommandCheckpointArchive(archive, intent), intent)
        : await this.input.checkpoint.readRetainedPendingCommand({ checkpointId: request.checkpointId, accountId, sessionId: request.sessionId, intent });
    } finally { archive.fill(0); }
    const originalPricing = await readProductionPendingPricing({ pool: this.input.pool, intent, pauseGeneration: checkpoint.pauseGeneration });
    const originalOperationId = `operation:${hash({ accountId, key: intent.idempotencyKey, profile: intent.profileId }).slice(0, 24)}`;
    const originalSettlement = await readOriginalPendingVertexSettlement({ journal: this.input.vertexJournal, accountId, operationId: originalOperationId });
    const { binding } = originalSettlement;
    const originalMaximumUsdMicros = maximumOperationCharge(originalPricing);
    const acceptedAtMs = Date.parse(binding.acceptedAt);
    const originalMaximumSat = convertUsdMicrosToSats({ usdMicros: Number(binding.maximumUsdMicros), conversion: binding.conversion, at: binding.acceptedAt }).amount;
    if (originalMaximumUsdMicros !== binding.maximumUsdMicros || originalMaximumSat !== intent.actionMaximum
      || !originalPricing.card.sources || canonicalJson(originalPricing.card.sources.conversion) !== canonicalJson(binding.conversion.source)
      || acceptedAtMs < Date.parse(originalPricing.card.validity.notBefore) || acceptedAtMs > Date.parse(originalPricing.card.validity.notAfter))
      throw new Error("PRODUCTION_PENDING_SETTLEMENT_BINDING_INVALID");
    const context = ResumePricingContextSchema.parse({ realm: "production-real", accountId, sessionId: request.sessionId,
      checkpointId: request.checkpointId, checkpointSha256: envelope.manifestSha256, checkpointVersion: 1,
      expectedSessionVersion: intent.expectedSessionVersion, expectedArtifactVersion: intent.expectedArtifactVersion,
      pendingAction: { reference: intent.reference, fingerprint: intent.fingerprint, kind: intent.actionKind, maximum: intent.actionMaximum },
      commandSha256: intent.commandSha256, originalOperationId, originalSettlementSha256: originalSettlement.bindingSha256,
      originalCommandMaximum: command.maximum, policyVersion: intent.policyVersion, toolchainId: intent.toolchainId,
      retentionUntilMs: checkpoint.retentionDeadlineMs });
    return Object.freeze({ context, command, intent, checkpoint, material, originalPricing, originalSettlement });
  }
}
