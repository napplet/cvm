import { maximumOperationCharge, convertUsdMicrosToSats, UsdSatConversionSchema, type UsdSatConversion } from "../model/price-card";
import type { GenerationUsageSettlement } from "../phase-04/metered-generation-service";
import type { PostgresOperationJournal } from "../release/deployment/postgres-operation-journal";
import { assertPostgresOperationJournal } from "../release/deployment/postgres-operation-journal";
import { ProductionVertexModelGateway } from "./vertex-model-gateway";
import { z } from "zod";
import { canonicalJson } from "../promotion/schema";
import type { ProductionResumeAcceptance } from "./resume-acceptance";

export const ProductionVertexSettlementBindingSchema = z.object({
  accountId: z.string().min(1), operationId: z.string().min(1), conversion: UsdSatConversionSchema,
  acceptedAt: z.iso.datetime(), maximumUsdMicros: z.string().regex(/^(0|[1-9][0-9]*)$/u),
}).strict();
type Binding = z.infer<typeof ProductionVertexSettlementBindingSchema>;
const digest = async (value: unknown) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)))), byte => byte.toString(16).padStart(2, "0")).join("");

/** A pre-dispatch pause may have a settlement binding but no metered action.
 * Read its original record only; never create or repair it from current FX. */
export async function readOriginalPendingVertexSettlement(input: Readonly<{ journal: PostgresOperationJournal; accountId: string; operationId: string }>): Promise<Readonly<{ binding: Binding; bindingSha256: string }>> {
  assertPostgresOperationJournal(input.journal);
  const record = await input.journal.read<unknown>(`vertex-generation-settlement:${input.operationId}`);
  if (!record || record.revision !== 1 || record.identitySha256 !== await digest({ accountId: input.accountId, operationId: input.operationId })) throw new Error("PRODUCTION_PENDING_SETTLEMENT_REQUIRED");
  const binding = ProductionVertexSettlementBindingSchema.parse(record.value);
  if (binding.accountId !== input.accountId || binding.operationId !== input.operationId) throw new Error("PRODUCTION_PENDING_SETTLEMENT_BINDING_INVALID");
  const bindingSha256 = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(binding)))).toString("hex");
  return Object.freeze({ binding, bindingSha256 });
}

/** Exact USD receipt to sat settlement. The FX conversion is claimed before
 * the action budget, then the original Vertex receipt is re-read at terminal
 * settlement; no normalized usage estimate is ever charged as a sat amount. */
export function createProductionVertexGenerationSettlement(input: Readonly<{ gateway: ProductionVertexModelGateway; conversion: UsdSatConversion; journal: PostgresOperationJournal; resumeSettlements?: Pick<ProductionResumeAcceptance, "readOperation"> }>): GenerationUsageSettlement {
  assertPostgresOperationJournal(input.journal);
  const conversion = UsdSatConversionSchema.parse(input.conversion);
  return Object.freeze({
    async prepare({ accountId, operationId, card, profile, at }) {
      const acceptedAt = new Date(at).toISOString();
      const maximumUsdMicros = maximumOperationCharge({ card, profile });
      const identity = await digest({ accountId, operationId }); const key = `vertex-generation-settlement:${operationId}`;
      const claimed = await input.journal.claim<Binding>(key, identity, { accountId, operationId, conversion, acceptedAt, maximumUsdMicros });
      const parsed = ProductionVertexSettlementBindingSchema.safeParse(claimed.record.value);
      if (!parsed.success || claimed.record.revision !== 1) throw new Error("PRODUCTION_VERTEX_SETTLEMENT_BINDING_CONFLICT");
      const binding = parsed.data;
      if (binding.accountId !== accountId || binding.operationId !== operationId || binding.maximumUsdMicros !== maximumUsdMicros || claimed.record.identitySha256 !== identity) throw new Error("PRODUCTION_VERTEX_SETTLEMENT_BINDING_CONFLICT");
      return Object.freeze({ maximum: convertUsdMicrosToSats({ usdMicros: Number(maximumUsdMicros), conversion: UsdSatConversionSchema.parse(binding.conversion), at: binding.acceptedAt }).amount });
    },
    async finalize({ accountId, intent, receipt }) {
      const record = await input.journal.read<Binding>(`vertex-generation-settlement:${intent.operationId}`);
      const resumed = record ? undefined : await input.resumeSettlements?.readOperation(accountId, intent.operationId);
      const parsed = ProductionVertexSettlementBindingSchema.safeParse(record ? record.value : resumed?.settlement);
      if (!parsed.success || (record && (record.revision !== 1 || record.identitySha256 !== await digest({ accountId, operationId: intent.operationId })))
        || parsed.data.accountId !== accountId || parsed.data.operationId !== intent.operationId) throw new Error("PRODUCTION_VERTEX_SETTLEMENT_BINDING_REQUIRED");
      const binding = parsed.data;
      if (resumed && (resumed.apiClaimedAtMs === null || resumed.apiRequestSha256 !== receipt.provenance.protectedEvidenceDigest
        || intent.accountId !== accountId || intent.sessionId !== resumed.sessionId || intent.actionId !== resumed.actionId
        || intent.operationId !== resumed.operationId || intent.providerRequestId !== resumed.operationId
        || intent.actionBudgetReference !== resumed.actionBudgetReference || intent.requestFingerprint !== resumed.fingerprint
        || intent.expectedVersion !== resumed.quote.context.expectedSessionVersion
        || intent.profileId !== resumed.quote.pricing.profile.id || intent.priceCardId !== resumed.quote.pricing.card.id
        || canonicalJson(intent.maximumUnits) !== canonicalJson(resumed.quote.pricing.profile.maximumUnits)
        || receipt.operationId !== resumed.operationId || receipt.providerRequestId !== resumed.operationId
        || receipt.profileId !== intent.profileId || receipt.priceCardId !== intent.priceCardId
        || receipt.model !== resumed.quote.pricing.profile.model || receipt.provider !== resumed.quote.pricing.profile.provider))
        throw new Error("PRODUCTION_PRICED_SETTLEMENT_BINDING_DENIED");
      const provider = await input.gateway.providerReceipt(intent);
      if (!provider || provider.requestSha256 !== receipt.provenance.protectedEvidenceDigest || provider.usage.inputTokens !== Number(receipt.usage.find(line => line.dimension === "input_tokens")?.units) || provider.usage.cachedInputTokens !== Number(receipt.usage.find(line => line.dimension === "cached_tokens")?.units) || provider.usage.outputTokens !== Number(receipt.usage.find(line => line.dimension === "output_tokens")?.units) || provider.usage.thoughtTokens !== Number(receipt.usage.find(line => line.dimension === "reasoning_tokens")?.units)) throw new Error("PRODUCTION_VERTEX_SETTLEMENT_RECEIPT_MISMATCH");
      if (resumed) {
        const { card, profile } = resumed.quote.pricing;
        const matches = (dimension: "input_tokens" | "cached_tokens" | "output_tokens" | "reasoning_tokens", perMillion: number) => {
          const rate = card.rates[dimension];
          return rate && BigInt(rate.numerator) * 1_000_000n === BigInt(perMillion) * BigInt(rate.denominator);
        };
        if (intent.profileId !== profile.id || intent.priceCardId !== card.id || provider.model !== profile.model
          || card.sources?.provider.capturedBytesSha256 !== provider.price.sourceDocumentSha256 || card.sources.provider.url !== provider.price.sourceUrl
          || !matches("input_tokens", provider.price.inputMicrosPerMillion) || !matches("cached_tokens", provider.price.cachedInputMicrosPerMillion)
          || !matches("output_tokens", provider.price.outputAndThoughtMicrosPerMillion) || !matches("reasoning_tokens", provider.price.outputAndThoughtMicrosPerMillion))
          throw new Error("PRODUCTION_VERTEX_SETTLEMENT_PRICE_MISMATCH");
      }
      if (BigInt(provider.cost.micros) > BigInt(binding.maximumUsdMicros)) throw new Error("PRODUCTION_VERTEX_SETTLEMENT_CAP_EXCEEDED");
      const converted = convertUsdMicrosToSats({ usdMicros: provider.cost.micros, conversion: binding.conversion, at: binding.acceptedAt });
      const maximum = convertUsdMicrosToSats({ usdMicros: Number(binding.maximumUsdMicros), conversion: binding.conversion, at: binding.acceptedAt }).amount;
      if (BigInt(converted.amount) > BigInt(maximum)) throw new Error("PRODUCTION_VERTEX_SETTLEMENT_CAP_EXCEEDED");
      return Object.freeze({ amount: converted.amount, providerReceiptReference: `vertex-receipt:${await digest({ operationId: provider.operationId, requestSha256: provider.requestSha256, interactionId: provider.interactionId, cost: provider.cost, conversion: converted.conversion })}` });
    },
  });
}
