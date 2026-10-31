import { assertProductionAccountOwnerSchema } from "../../production/account-owner";
import { CashuTsSettlementAdapter } from "../../funding/cashu-provider";
import { CashuMintPolicyRegistry } from "../../funding/cashu-mint-policy";
import { NwcLightningReceiptPort } from "../../funding/nwc-receipt-port";
import type { ReadyCapacityPort } from "../../funding/funded-admission";
import { createFundedCore, type FundedCore, type FundedCoreOptions } from "../../phase-03/funded-core";
import { PostgresFundingDatabase } from "../../persistence/postgres-funding-database";
import type { PostgresSqlPool } from "../../persistence/postgres-sql-funding-store";
import type { MeteredArtifactLineage } from "../../persistence/funding-store";
import type { ContextVmTransportPort } from "../../contextvm/sdk-bridge";
import type { ProductionNwcTransport } from "./payment-clients";
import { createNwcCredentialSigningBroker, openSignedNwcTransport, type NwcCredentialBroker } from "./signed-nwc-transport";
import { convertUsdMicrosToSats, UsdSatConversionSchema, type UsdSatConversion } from "../../model/price-card";
import { createOfficialPricingSources } from "../costs/official-sources";
import type { SealedFundingFeePolicyProjection } from "../costs/funding-fees";
import type { VertexProviderReceipt } from "./vertex-client";
import { assertPostgresOperationJournal, type PostgresOperationJournal } from "./postgres-operation-journal";
import type { ContinuationService } from "../../continuity/continuation-service";

/** The production composition accepts only bounded project-owned ports. It has
 * no faucet, FakeWallet, test realm, fixture model, or synthetic billing path. */
export type ProductionFundingInput = Readonly<{
  postgresPool: PostgresSqlPool;
  transport: ContextVmTransportPort;
  nwcTransport: ProductionNwcTransport;
  nwcReceipt: NwcLightningReceiptPort;
  cashuPolicies: CashuMintPolicyRegistry;
  capacity: ReadyCapacityPort;
  protectedMaterialKey: Uint8Array;
  admissionReceiptSecret: Uint8Array;
  statusCursorSecret: Uint8Array;
  accountingConfiguration: unknown;
  meteredService?: NonNullable<FundedCoreOptions["meteredService"]>;
  continuationService?: Pick<ContinuationService, "resumeSession">;
  pricedContinuation?: FundedCoreOptions["pricedContinuation"];
}>;

export function createSealedFundingFeePolicyProjection(input: Readonly<{ cashuPolicies: CashuMintPolicyRegistry; maximumCashuProofs: number; nwc: Readonly<{ maximumReceiverFeeSats: string; policySha256: string }>; observedAtMs?: number; freshnessMs?: number }>): SealedFundingFeePolicyProjection {
  if (!(input.cashuPolicies instanceof CashuMintPolicyRegistry) || !Number.isSafeInteger(input.maximumCashuProofs) || input.maximumCashuProofs < 1 || input.maximumCashuProofs > 10_000 || !/^(?:0|[1-9][0-9]*)$/u.test(input.nwc.maximumReceiverFeeSats) || !/^[a-f0-9]{64}$/u.test(input.nwc.policySha256)) throw new Error("FUNDING_FEE_POLICY_INVALID");
  const observedAtMs = input.observedAtMs ?? Date.now(); const freshnessMs = input.freshnessMs ?? 60 * 60 * 1000;
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs <= 0 || !Number.isSafeInteger(freshnessMs) || freshnessMs < 1 || freshnessMs > 86_400_000) throw new Error("FUNDING_FEE_POLICY_INVALID");
  const policy = input.cashuPolicies.pinActive();
  return Object.freeze({ observedAtMs, freshUntilMs: observedAtMs + freshnessMs, nwc: Object.freeze({ maximumReceiverFeeSats: input.nwc.maximumReceiverFeeSats, policySha256: input.nwc.policySha256.toLowerCase() }), cashu: Object.freeze({ maximumProofs: input.maximumCashuProofs, mints: Object.freeze(policy.mints.map(mint => Object.freeze({ url: mint.url, keysetIds: Object.freeze([...mint.keysetIds]) }))) }) });
}

async function digest(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Real SQL-backed action finalization. The selected action is located by its
 * durable original operation and the same metered transaction both checks the
 * reservation/cap and posts its terminal debit. Unknown/pending results have
 * no receipt type and therefore cannot call this function. */
/** The worker/build outcome, not the model receipt, owns session terminal
 * state. A successful inference may still produce a failed build; only a
 * verified artifact may advance the session to completed. */
export type ProductionModelTerminal =
  | Readonly<{ status: "failed"; result: unknown; sessionVersion: number; artifactVersion: number; artifact?: MeteredArtifactLineage }>
  | Readonly<{ status: "completed"; result: unknown; sessionVersion: number; artifactVersion: number; artifact: MeteredArtifactLineage & Readonly<{ artifactId: string }> }>;

export type ProductionVertexUsageSettlement = Readonly<{
  /** Call before reservation/dispatch; its output is the quote to bind into
   * the action's source-priced model card and maximum sat reservation. */
  prepare(input: Readonly<{ accountId: string; operationId: string; at: string }>): Promise<Readonly<{ conversion: UsdSatConversion; acceptedAt: string }>>;
  /** Settlement reloads the durable pre-dispatch binding. It never fetches or
   * substitutes a newer FX observation after provider work has happened. */
  finalize(input: Readonly<{ accountId: string; receipt: VertexProviderReceipt; terminal: ProductionModelTerminal }>): Promise<Readonly<{ currency: "sat"; amount: string }>>;
}>;

export async function finalizeProductionVertexUsage(input: Readonly<{
  database: PostgresFundingDatabase;
  accountId: string;
  receipt: VertexProviderReceipt;
  conversion: UsdSatConversion;
  at: string;
  terminal: ProductionModelTerminal;
}>): Promise<Readonly<{ currency: "sat"; amount: string }>> {
  if (!(input.database instanceof PostgresFundingDatabase) || input.database.realm.name !== "production-real" || !/^account:[a-f0-9]{64}$/u.test(input.accountId)) throw new Error("PRODUCTION_MODEL_USAGE_SETTLEMENT_REQUIRED");
  if (!Number.isSafeInteger(input.terminal.sessionVersion) || input.terminal.sessionVersion < 0 || !Number.isSafeInteger(input.terminal.artifactVersion) || input.terminal.artifactVersion < 0) throw new Error("PRODUCTION_MODEL_USAGE_FINALIZATION_INVALID");
  const converted = convertUsdMicrosToSats({ usdMicros: input.receipt.cost.micros, conversion: input.conversion, at: input.at });
  const action = await input.database.meteredFunding.findMeteredActionByOperation(input.accountId, input.receipt.operationId);
  if (!action || action.operationId !== input.receipt.operationId) throw new Error("PRODUCTION_MODEL_ACTION_NOT_FOUND");
  const providerReceiptReference = `vertex-receipt:${await digest({ operationId: input.receipt.operationId, requestSha256: input.receipt.requestSha256, interactionId: input.receipt.interactionId, price: input.receipt.price, conversion: converted.conversion, usdMicros: input.receipt.cost.micros })}`;
  await input.database.meteredFunding.transact(input.accountId, transaction => transaction.finalizeMeteredAction({
    idempotencyKey: action.idempotencyKey, operationId: input.receipt.operationId, receiptCharge: converted.amount, providerReceiptReference,
    status: input.terminal.status, result: input.terminal.result,
    sessionVersion: input.terminal.sessionVersion, artifactVersion: input.terminal.artifactVersion,
    ...(input.terminal.artifact ? { artifact: input.terminal.artifact } : {}),
  }));
  return Object.freeze({ currency: "sat" as const, amount: converted.amount });
}

/** Real production model-gateway settlement adapter for the worker/action
 * service. It binds a fresh, source-attributed FX quote at construction and
 * exposes no receipt-charge override, memory store, or synthetic provider. */
type VertexSettlementBinding = Readonly<{ accountId: string; operationId: string; conversion: UsdSatConversion; acceptedAt: string }>;

export function createProductionVertexUsageSettlement(input: Readonly<{ database: PostgresFundingDatabase; sources: ReturnType<typeof createOfficialPricingSources>["sources"]; journal: PostgresOperationJournal }>): ProductionVertexUsageSettlement {
  if (!(input.database instanceof PostgresFundingDatabase) || input.database.realm.name !== "production-real") throw new Error("PRODUCTION_MODEL_USAGE_SETTLEMENT_REQUIRED");
  if (!input.sources || typeof input.sources.readUsdSatConversion !== "function") throw new Error("PRODUCTION_USD_SAT_SOURCE_REQUIRED");
  try { assertPostgresOperationJournal(input.journal); } catch { throw new Error("PRODUCTION_MODEL_USAGE_JOURNAL_REQUIRED"); }
  return Object.freeze({
    async prepare({ accountId, operationId, at }) {
      if (!/^account:[a-f0-9]{64}$/u.test(accountId) || !/^[a-z][a-z0-9_-]{2,127}$/u.test(operationId)) throw new Error("PRODUCTION_MODEL_USAGE_BINDING_INVALID");
      const acceptedAt = new Date(at).toISOString();
      const identitySha256 = await digest({ accountId, operationId });
      const key = `vertex-settlement:${operationId}`;
      const existing = await input.journal.read<VertexSettlementBinding>(key);
      if (existing) {
        if (existing.identitySha256 !== identitySha256 || existing.value.accountId !== accountId || existing.value.operationId !== operationId) throw new Error("PRODUCTION_MODEL_USAGE_BINDING_CONFLICT");
        return Object.freeze({ conversion: UsdSatConversionSchema.parse(existing.value.conversion), acceptedAt: existing.value.acceptedAt });
      }
      const conversion = UsdSatConversionSchema.parse(await input.sources.readUsdSatConversion());
      // Validate freshness at acceptance, before the caller reserves the cap
      // or dispatches paid inference. Later settlement uses this exact quote.
      convertUsdMicrosToSats({ usdMicros: 0, conversion, at: acceptedAt });
      const binding = Object.freeze({ accountId, operationId, conversion, acceptedAt });
      const claimed = await input.journal.claim<VertexSettlementBinding>(key, identitySha256, binding);
      if (claimed.record.value.accountId !== accountId || claimed.record.value.operationId !== operationId) throw new Error("PRODUCTION_MODEL_USAGE_BINDING_CONFLICT");
      return Object.freeze({ conversion: UsdSatConversionSchema.parse(claimed.record.value.conversion), acceptedAt: claimed.record.value.acceptedAt });
    },
    async finalize({ accountId, receipt, terminal }) {
      const key = `vertex-settlement:${receipt.operationId}`;
      const binding = await input.journal.read<VertexSettlementBinding>(key);
      if (!binding || binding.value.accountId !== accountId || binding.value.operationId !== receipt.operationId || binding.identitySha256 !== await digest({ accountId, operationId: receipt.operationId })) throw new Error("PRODUCTION_MODEL_USAGE_BINDING_REQUIRED");
      return finalizeProductionVertexUsage({ database: input.database, accountId, receipt, conversion: UsdSatConversionSchema.parse(binding.value.conversion), at: binding.value.acceptedAt, terminal });
    },
  });
}

function secret(value: Uint8Array, name: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) throw new Error(`${name}_INVALID`);
  return new Uint8Array(value);
}

function assertNwc(transport: ProductionNwcTransport, receipt: NwcLightningReceiptPort): void {
  try {
    assertPostgresOperationJournal(transport.journal);
    if (!(receipt instanceof NwcLightningReceiptPort) || receipt.accountingRealm !== "production-real"
      || receipt.connectionScopeDigest !== transport.connectionScopeDigest) throw new Error("invalid");
  } catch { throw new Error("PRODUCTION_NWC_TRANSPORT_REQUIRED"); }
}

/**
 * Builds the real-money ledger core without starting a relay, mint request, or
 * wallet action. Provider effects remain receipt/original-operation gated by
 * the coordinators constructed in `createFundedCore`.
 */
export function createProductionFunding(input: ProductionFundingInput): Readonly<{ database: PostgresFundingDatabase; core: FundedCore }> {
  assertNwc(input.nwcTransport, input.nwcReceipt);
  if (!(input.cashuPolicies && typeof input.cashuPolicies === "object")) throw new Error("PRODUCTION_CASHU_POLICY_REQUIRED");
  if (!input.capacity || typeof input.capacity.reserveNow !== "function" || typeof input.capacity.observe !== "function" || typeof input.capacity.release !== "function") throw new Error("PRODUCTION_CAPACITY_PORT_REQUIRED");
  const database = new PostgresFundingDatabase(input.postgresPool, { realm: "production-real" });
  const core = createFundedCore({
    database,
    accountingRealm: "production-real",
    transport: input.transport,
    capacity: input.capacity,
    lightningReceiver: input.nwcReceipt,
    cashuProvider: new CashuTsSettlementAdapter(),
    cashuPolicies: input.cashuPolicies,
    protectedMaterialKey: secret(input.protectedMaterialKey, "PRODUCTION_PROTECTED_MATERIAL_KEY"),
    admissionReceiptSecret: secret(input.admissionReceiptSecret, "PRODUCTION_ADMISSION_RECEIPT_SECRET"),
    statusCursorSecret: secret(input.statusCursorSecret, "PRODUCTION_STATUS_CURSOR_SECRET"),
    productionAccountingConfiguration: input.accountingConfiguration,
    ...(input.meteredService ? { meteredService: input.meteredService } : {}),
    ...(input.continuationService ? { continuationService: input.continuationService } : {}),
    ...(input.pricedContinuation ? { pricedContinuation: input.pricedContinuation } : {}),
  });
  if (core.mode !== "configured" || core.externalSurfaces.postgres !== "configured" || core.externalSurfaces.lightning !== "configured" || core.externalSurfaces.cashu !== "configured") {
    throw new Error("PRODUCTION_FUNDING_COMPOSITION_BLOCKED");
  }
  return Object.freeze({ database, core });
}

/** Opens the project-owned NIP-47 rail from a broker reference, then composes
 * the production core.  It deliberately does not accept a relay, raw NWC URI,
 * or private key: the broker is the only authority able to use the connection
 * capability and the concrete journal is the only durable original-request
 * authority.  Network I/O starts only while opening the consented connection. */
export async function openProductionFunding(input: Readonly<
  Omit<ProductionFundingInput, "nwcTransport" | "nwcReceipt"> & {
    nwcConnectionReference: string;
    nwcCredentialBroker: NwcCredentialBroker;
    nwcJournal: PostgresOperationJournal;
  }
>): Promise<Readonly<{ database: PostgresFundingDatabase; core: FundedCore; close(): Promise<void> }>> {
  await assertProductionAccountOwnerSchema(input.postgresPool);
  const nwcTransport = await openSignedNwcTransport({
    connectionReference: input.nwcConnectionReference,
    broker: createNwcCredentialSigningBroker({ credentials: input.nwcCredentialBroker }),
    journal: input.nwcJournal,
  });
  try {
    const funding = createProductionFunding({ ...input, nwcTransport, nwcReceipt: new NwcLightningReceiptPort(nwcTransport) });
    return Object.freeze({ ...funding, close: () => nwcTransport.close() });
  } catch (error) {
    await nwcTransport.close();
    throw error;
  }
}
