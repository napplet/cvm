import { createHash } from "node:crypto";
import { z } from "zod";
import { PendingActionIntentSchema } from "../continuity/contracts";
import { validatePendingCommandCheckpointArchive } from "../continuity/checkpoint-envelope";
import { prepareResumePricingQuote, ResumePricingContextSchema, ResumePricingQuoteSchema, verifyStoredResumePricingQuote } from "../continuity/resume-pricing";
import { PrepareResumeCommandSchema, PrepareResumeResultSchema, projectResumePricingQuote } from "../continuity/resume-v2-contracts";
import { convertUsdMicrosToSats, maximumOperationCharge, ModelProfileSchema, type createVertexGeminiProductionPricing } from "../model/price-card";
import type { ContinuationFundingStore } from "../persistence/funding-store";
import { PostgresSqlFundingStore, type PostgresSqlPool } from "../persistence/postgres-sql-funding-store";
import type { PostgresOperationJournal } from "../release/deployment/postgres-operation-journal";
import { canonicalJson } from "../promotion/schema";
import type { GenerationCommand } from "../phase-04/metered-generation-service";
import { ProductionCheckpointCoordinator, assertProductionCheckpointCoordinator } from "./checkpoint-coordinator";
import { readProductionAcceptedPendingPricing, readProductionPendingPricing } from "./pricing-catalog";
import { ProductionResumePricingQuotes } from "./resume-pricing-quotes";
import { readOriginalPendingVertexSettlement } from "./vertex-generation-settlement";
import { bindAccountingRealmPool, createAccountingRealm } from "../funding/accounting-realm";

type PrepareCommand = z.infer<typeof PrepareResumeCommandSchema>;
type PrepareResult = z.infer<typeof PrepareResumeResultSchema>;
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");

function pricingWithinAuthorizedCap(input: Readonly<{
  pricing: Awaited<ReturnType<typeof createVertexGeminiProductionPricing>>;
  maximumSat: bigint;
  at: string;
}>) {
  if (input.maximumSat < 1n) throw new Error("RESUME_CAP_APPROVAL_REQUIRED");
  const full = maximumOperationCharge(input.pricing);
  if (BigInt(convertUsdMicrosToSats({ usdMicros: Number(full), conversion: input.pricing.conversion, at: input.at }).amount) <= input.maximumSat)
    return Object.freeze({ pricing: input.pricing, sourceProfile: input.pricing.profile });
  const scale = 1_000_000n;
  const profileAt = (factor: bigint) => ModelProfileSchema.parse({ ...input.pricing.profile,
    maximumUnits: input.pricing.profile.maximumUnits.map((item) => ({ ...item, units: ((BigInt(item.units) * factor) / scale || 1n).toString() })) });
  let low = 0n, high = scale;
  while (low < high) {
    const middle = (low + high + 1n) / 2n;
    const profile = profileAt(middle);
    const quotedSat = BigInt(convertUsdMicrosToSats({ usdMicros: Number(maximumOperationCharge({ card: input.pricing.card, profile })), conversion: input.pricing.conversion, at: input.at }).amount);
    if (quotedSat <= input.maximumSat) low = middle;
    else high = middle - 1n;
  }
  const sourceProfileSha256 = createHash("sha256").update(canonicalJson(input.pricing.profile)).digest("hex");
  const profile = ModelProfileSchema.parse({ ...profileAt(low), id: `resume-derived:${createHash("sha256").update(canonicalJson({ sourceProfileSha256, maximumUnits: profileAt(low).maximumUnits })).digest("hex")}` });
  const quotedSat = BigInt(convertUsdMicrosToSats({ usdMicros: Number(maximumOperationCharge({ card: input.pricing.card, profile })), conversion: input.pricing.conversion, at: input.at }).amount);
  if (quotedSat > input.maximumSat) throw new Error("RESUME_CAP_APPROVAL_REQUIRED");
  return Object.freeze({ pricing: Object.freeze({ ...input.pricing, profile: Object.freeze(profile) }), sourceProfile: input.pricing.profile });
}

/** The quote owner is the verified request principal. All command, checkpoint,
 * original pricing and FX data comes from server-owned durable authorities.
 * No worker allocation, funds reservation, provider dispatch or signing occurs. */
export class ProductionResumePricingPreparer {
  readonly #pool: PostgresSqlPool;
  readonly #funding: PostgresSqlFundingStore;
  constructor(private readonly input: Readonly<{
    pool: PostgresSqlPool;
    store: Pick<ContinuationFundingStore, "findContinuationCheckpoint" | "findContinuationPause">;
    checkpoint: ProductionCheckpointCoordinator;
    quotes: ProductionResumePricingQuotes;
    vertexJournal: PostgresOperationJournal;
    currentPricing: Awaited<ReturnType<typeof createVertexGeminiProductionPricing>>;
    compatibility: Readonly<{ policyVersion: string; acceptedToolchains: readonly string[] }>;
    now?: () => number;
  }>) {
    assertProductionCheckpointCoordinator(input.checkpoint);
    this.#pool = bindAccountingRealmPool(input.pool, createAccountingRealm("production-real"));
    this.#funding = new PostgresSqlFundingStore(this.#pool, { deadlineMs: 5000, maxAttempts: 4 });
  }

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
      const funding = await this.#funding.transactWithSql(command.principal.id,
        transaction => transaction.continuationFundingSnapshot(authority.intent.admissionReference));
      const maximumSat = funding.availableBalance + funding.remainingCap < funding.remainingCap
        ? funding.availableBalance + funding.remainingCap : funding.remainingCap;
      const nowMs = (this.input.now ?? Date.now)();
      const bounded = pricingWithinAuthorizedCap({ pricing: this.input.currentPricing, maximumSat, at: new Date(nowMs).toISOString() });
      const quote = await prepareResumePricingQuote({ context: authority.context, pricing: bounded.pricing, sourceProfile: bounded.sourceProfile,
        preparationKey: command.idempotencyKey, nowMs, lifetimeMs: 300_000 });
      return await projectResumePricingQuote(await this.input.quotes.save(quote));
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code === "RESUME_CHECKPOINT_NOT_FOUND_OR_DENIED") return { status: "denied", code };
      if (code === "RESUME_STALE_OR_CONFLICTING" || code === "RESUME_QUOTE_PREPARATION_CONFLICT") return { status: "denied", code: "RESUME_STALE_OR_CONFLICTING" };
      if (code === "RESUME_CAP_APPROVAL_REQUIRED") return { status: "blocked", code };
      if (code === "RESUME_COMPATIBILITY_DENIED" || code === "RESUME_QUOTE_EXCEEDS_COMMAND_MAXIMUM") return { status: "blocked", code };
      return { status: "blocked", code: "RESUME_PRICE_AUTHORITY_UNAVAILABLE" };
    }
  }

  /** Coordinator-only read for preparation and later acceptance revalidation.
   * Returned private material must never be projected as a tool response. */
  async loadAuthority(raw: unknown) {
    return this.#loadAuthority(PrepareResumeCommandSchema.parse(raw));
  }

  /** Historical private command custody for an existing accepted operation.
   * Only an owned SQL claim selects its quote; callers cannot supply replay,
   * quote/context, current pricing, retention or expiry overrides. */
  async loadAcceptedAuthority(raw: unknown) {
    const request = z.object({ principal: z.object({ id: z.string().min(1).max(256) }).strict(), idempotencyKey: z.string().min(1).max(160) }).strict().parse(raw);
    const saved = await (async () => {
      const client = await this.#pool.connect();
      try {
        return (await client.query(`SELECT c.claim_reference AS "claimReference",c.account_id AS "accountId",c.session_id AS "sessionId",
        c.checkpoint_id AS "checkpointId",c.accepted_at_ms AS "acceptedAtMs",c.quote_reference AS "quoteReference",c.quote_sha256 AS "quoteSha256",q.quote_json AS quote
        FROM production_real.priced_continuation_claims c JOIN production_real.resume_pricing_quotes q ON q.quote_reference=c.quote_reference
        WHERE c.account_id=$1 AND c.idempotency_key=$2 AND c.state IN ('accepted','dispatching')`, [request.principal.id, request.idempotencyKey])).rows[0];
      } finally { client.release(); }
    })();
    if (!saved) throw new Error("RESUME_ACCEPTED_COMMAND_NOT_FOUND_OR_DENIED");
    const accepted = z.object({ claimReference: z.string().min(1).max(256), accountId: z.string().min(1).max(256), sessionId: z.string().min(1).max(256),
      checkpointId: z.string().min(1).max(256), acceptedAtMs: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      quoteReference: z.string().min(1).max(256), quoteSha256: z.string().regex(/^[a-f0-9]{64}$/u), quote: ResumePricingQuoteSchema }).strict().parse(saved);
    const quote = await verifyStoredResumePricingQuote({ stored: accepted.quote, expectedContext: accepted.quote.context, nowMs: accepted.acceptedAtMs,
      approval: { quoteReference: accepted.quoteReference, quoteSha256: accepted.quoteSha256, maximumSat: accepted.quote.maximumSat } });
    if (accepted.accountId !== request.principal.id || quote.context.accountId !== request.principal.id || quote.context.sessionId !== accepted.sessionId
      || quote.context.checkpointId !== accepted.checkpointId) throw new Error("RESUME_ACCEPTED_COMMAND_BINDING_DENIED");
    const authority = await this.#loadAuthority({ principal: request.principal, sessionId: accepted.sessionId, checkpointId: accepted.checkpointId,
      expectedSessionVersion: quote.context.expectedSessionVersion, expectedCheckpointVersion: 1, idempotencyKey: quote.preparationKey }, accepted.claimReference);
    if (canonicalJson(authority.context) !== canonicalJson(quote.context)) throw new Error("RESUME_ACCEPTED_COMMAND_BINDING_DENIED");
    return Object.freeze({ ...authority, quote, claimReference: accepted.claimReference });
  }

  async #loadAuthority(request: PrepareCommand, acceptedClaimReference?: string) {
    const accountId = request.principal.id;
    const checkpoint = await this.input.store.findContinuationCheckpoint(accountId, request.checkpointId);
    if (!checkpoint || checkpoint.accountId !== accountId || checkpoint.sessionId !== request.sessionId) throw new Error("RESUME_CHECKPOINT_NOT_FOUND_OR_DENIED");
    const nowMs = (this.input.now ?? Date.now)();
    if (checkpoint.state !== (acceptedClaimReference === undefined ? "resume_required" : "claimed") || checkpoint.expectedSessionVersion !== request.expectedSessionVersion || checkpoint.retentionDeadlineMs <= nowMs)
      throw new Error("RESUME_STALE_OR_CONFLICTING");
    const pause = await this.input.store.findContinuationPause(accountId, request.sessionId, checkpoint.pauseGeneration);
    if (!pause || (acceptedClaimReference === undefined ? pause.state !== "resume_required" : pause.state !== "claimed" && pause.state !== "restored")) throw new Error("RESUME_STALE_OR_CONFLICTING");
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
    const originalPricing = acceptedClaimReference === undefined
      ? await readProductionPendingPricing({ pool: this.input.pool, intent, pauseGeneration: checkpoint.pauseGeneration })
      : await readProductionAcceptedPendingPricing({ pool: this.input.pool, intent, pauseGeneration: checkpoint.pauseGeneration, claimReference: acceptedClaimReference });
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
