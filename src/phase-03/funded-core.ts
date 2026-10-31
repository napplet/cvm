import { SessionCapApprovalService } from "../funding/session-cap";
import { ContextVmFundingAdapter } from "../contextvm/adapter";
import { buildContextVmAnnouncement, configureContextVmToolAvailability, type ContextVmAnnouncementInput } from "../contextvm/announcement";
import type { ContextVmTransportPort } from "../contextvm/sdk-bridge";
import { AccountStatusService, type AccountSessionStatusPort } from "../funding/account-status";
import { FundedAdmissionService, type ReadyCapacityPort } from "../funding/funded-admission";
import { FundingService } from "../funding/funding-service";
import { HmacAdmissionReceiptAuthority, type AdmissionReceiptAuthority } from "../funding/admission-receipt";
import { LightningTopUpCoordinator } from "../funding/lightning-top-up";
import { CashuTopUpCoordinator } from "../funding/cashu-top-up";
import type { LightningReceiptPort } from "../funding/lightning-provider";
import type { CashuSettlementPort, CashuWalletOperations } from "../funding/cashu-provider";
import type { CashuMintPolicyRegistry } from "../funding/cashu-mint-policy";
import { ProtectedRailMaterialVault } from "../funding/protected-rail-material";
import type { FundingStore, MeteredFundingStore } from "../persistence/funding-store";
import { PostgresFundingStore, type PostgresFundingExecutor } from "../persistence/postgres-funding-store";
import type { PostgresSqlPool } from "../persistence/postgres-sql-funding-store";
import { PostgresFundingDatabase } from "../persistence/postgres-funding-database";
import { assertProductionAccountingConfiguration, assertProductionRealm, type AccountingRealmName } from "../funding/accounting-realm";
import type { MeteredGenerationService } from "../phase-04/metered-generation-service";
import { readSessionStatus } from "../phase-04/session-status";
import type { ContinuationService } from "../continuity/continuation-service";
import { validatedAvailablePromotedCliSourceContract } from "../publication/napplet-cli-source-contract";
import type { LifecycleTelemetryPort } from "../telemetry/contracts";

type SurfaceState = "configured" | "blocked" | "unselected";
type BlockedCapacity = ReadyCapacityPort;
const emptySessions: AccountSessionStatusPort = { list: async () => ({ active: [], resumable: [], pendingActions: [] }) };
const blockedCapacity: BlockedCapacity = {
  reserveNow: async () => ({ status: "refused", reason: "CAPACITY_UNCONFIGURED" }),
  observe: async () => ({ status: "unknown" }),
  release: async () => undefined,
};
const unavailableAdmissionReceipts: AdmissionReceiptAuthority = Object.freeze({
  issue: async () => { throw new Error("ADMISSION_RECEIPT_AUTHORITY_UNAVAILABLE"); },
  verify: async () => { throw new Error("ADMISSION_RECEIPT_AUTHORITY_UNAVAILABLE"); },
});

export type FundedCoreOptions = Readonly<{
  /** Explicit monetary authority. Non-Postgres stores are test-only by contract. */
  store?: FundingStore;
  postgresExecutor?: PostgresFundingExecutor;
  postgresPool?: PostgresSqlPool;
  database?: PostgresFundingDatabase;
  /** Real-money composition selects a fresh zero-funded realm, never public history. */
  accountingRealm?: AccountingRealmName;
  /** Non-secret adapter/catalog identity descriptor validated before real-money composition. */
  productionAccountingConfiguration?: unknown;
  capacity?: ReadyCapacityPort;
  sessions?: AccountSessionStatusPort;
  transport?: ContextVmTransportPort;
  lightning?: LightningTopUpCoordinator;
  cashu?: CashuTopUpCoordinator;
  lightningReceiver?: LightningReceiptPort;
  cashuProvider?: CashuSettlementPort;
  cashuPolicies?: CashuMintPolicyRegistry;
  protectedMaterialKey?: Uint8Array;
  announcement?: ContextVmAnnouncementInput;
  /** Phase 4's transport-neutral action authority; never a ContextVM SDK type. */
  meteredService?: Pick<MeteredGenerationService, "startSession" | "reviseSession"> & Partial<Pick<MeteredGenerationService, "dispatchVerifiedCredit" | "reconcileOutstandingWakeDispatches" | "completeResumedAction">>;
  /** Phase 5 explicit-resume facade; no payment or ContextVM authority crosses this seam. */
  continuationService?: Pick<ContinuationService, "resumeSession">;
  /** The separately priced V2 continuation path is opt-in and cannot alter V1 resume. */
  pricedContinuation?: NonNullable<ConstructorParameters<typeof ContextVmFundingAdapter>[0]["pricedContinuation"]>;
  /** Owner-scoped Phase 6 facades. They remain transport-neutral and receive no ContextVM SDK types. */
  preview?: NonNullable<ConstructorParameters<typeof ContextVmFundingAdapter>[0]["preview"]>;
  publication?: NonNullable<ConstructorParameters<typeof ContextVmFundingAdapter>[0]["publication"]>;
  /** A missing, invalid, or unavailable Plan 05 probe keeps publication fail-closed. */
  publicationSourceContract?: unknown;
  /** Server-held HMAC material for opaque status cursors. */
  statusCursorSecret?: Uint8Array;
  /** Server-held HMAC material for expiring admission receipt capabilities. */
  admissionReceiptSecret?: Uint8Array;
  /** Observation-only lifecycle port. It never receives funding, session, or effect authority. */
  lifecycle?: LifecycleTelemetryPort;
  testOnly?: boolean;
}>;

export type FundedCore = Readonly<{
  mode: "offline_design_ready" | "configured";
  funding: FundingService;
  admissions: FundedAdmissionService;
  accountStatus: AccountStatusService;
  contextvm?: ContextVmFundingAdapter;
  /** Project-owned rail authorities exposed only to the production session
   * compositor. They are the same coordinators used by the public funding
   * surface, never reconstructed from mounted JSON. */
  rails?: Readonly<{
    lightning: Readonly<{ receiver: LightningReceiptPort; coordinator: LightningTopUpCoordinator }>;
    cashu: Readonly<{ settlement: CashuSettlementPort; walletOperations: CashuWalletOperations; coordinator: CashuTopUpCoordinator }>;
  }>;
  /** Coordinator-only restart lifecycle; this discovers durable wake effects, never queues generation. */
  continuationRecovery?: Readonly<{ reconcileOutstandingWakeDispatches(accountId: string): ReturnType<MeteredGenerationService["reconcileOutstandingWakeDispatches"]> }>;
  externalSurfaces: Readonly<{ contextvm: SurfaceState; lightning: SurfaceState; cashu: SurfaceState; postgres: SurfaceState; capacity: SurfaceState; modal: "unselected" }>;
}>;

/**
 * Final Phase 3 composition. It intentionally exposes no worker/model handle:
 * Phase 4 alone may consume action-budget reservations for exact usage.
 */
export function createFundedCore(options: FundedCoreOptions = {}): FundedCore {
  if (!options.testOnly && options.meteredService && !options.statusCursorSecret) throw new Error("PRODUCTION_STATUS_CURSOR_SECRET_REQUIRED");
  if (options.database && !(options.database instanceof PostgresFundingDatabase)) throw new Error("PRODUCTION_POSTGRES_DATABASE_ADAPTER_REQUIRED");
  // A store/executor can point at public development history while presenting
  // the same funding interface. Real-money composition must start from the
  // realm-bound database capability, never a caller-supplied SQL bypass.
  if (!options.testOnly && (options.store || options.postgresExecutor)) throw new Error("PRODUCTION_POSTGRES_DATABASE_ADAPTER_REQUIRED");
  if (options.store && (options.postgresExecutor || options.postgresPool || options.database)) throw new Error("CONFLICTING_FUNDING_STORE_CONFIGURATION");
  if ([options.postgresExecutor, options.postgresPool, options.database].filter(Boolean).length > 1) throw new Error("CONFLICTING_POSTGRES_CONFIGURATION");
  if (!options.testOnly && (options.lightning || options.cashu)) throw new Error("PRODUCTION_RAIL_COMPOSITION_REQUIRED");
  const requestedRealm = options.accountingRealm ?? (options.testOnly ? "development-test" : "production-real");
  if (options.testOnly && (requestedRealm === "production-real" || options.database?.realm.name === "production-real")) throw new Error("TEST_ACCOUNTING_REALM_DENIED");
  const railConfigurationStarted = Boolean(options.lightningReceiver || options.cashuProvider || options.cashuPolicies || options.protectedMaterialKey);
  if (!options.testOnly && railConfigurationStarted) assertProductionAccountingConfiguration(options.productionAccountingConfiguration);
  // Test doubles and custom wallet-operation hooks cannot prove that a swap's
  // exact output data was durably captured before credit.  Production only
  // accepts the default cashu-ts adapter; it receives the coordinator's
  // database-backed custody callback below.
  if (!options.testOnly && options.cashuProvider && options.cashuProvider.productionSafe !== true) throw new Error("PRODUCTION_CASHU_CUSTODY_ADAPTER_REQUIRED");
  const database = options.database ?? (options.postgresPool ? new PostgresFundingDatabase(options.postgresPool, { realm: requestedRealm }) : undefined);
  if (!options.testOnly && database) assertProductionRealm(database.realm);
  const store = options.store ?? database?.funding ?? (options.postgresExecutor ? new PostgresFundingStore(options.postgresExecutor) : undefined);
  // The deterministic test-only path has an explicit in-memory authority. It is
  // still offline design evidence, never a selected database/provider claim.
  const authority = store ?? (() => { throw new Error("POSTGRES_FUNDING_STORE_REQUIRED"); })();
  const funding = new FundingService(authority, options.lifecycle);
  if (railConfigurationStarted && (!database || !options.lightningReceiver || !options.cashuProvider || !options.cashuPolicies || !options.protectedMaterialKey)) throw new Error("PRODUCTION_RAIL_COMPOSITION_REQUIRED");
  const vault = database && options.protectedMaterialKey ? new ProtectedRailMaterialVault({ key: options.protectedMaterialKey, repository: database.protectedMaterials }) : undefined;
  const verifiedCreditWake = options.meteredService?.dispatchVerifiedCredit
    ? Object.freeze({ dispatchVerifiedCredit: (accountId: string) => options.meteredService!.dispatchVerifiedCredit!(accountId) })
    : undefined;
  const lightning = database && vault && options.lightningReceiver
    ? new LightningTopUpCoordinator({ funding, receiver: options.lightningReceiver, repository: database.lightning, vault, ...(verifiedCreditWake ? { verifiedCreditWake } : {}) })
    : options.testOnly ? options.lightning : undefined;
  const cashu = database && vault && options.cashuProvider && options.cashuPolicies
    ? new CashuTopUpCoordinator({ funding, provider: options.cashuProvider, policies: options.cashuPolicies, repository: database.cashu, vault, ...(verifiedCreditWake ? { verifiedCreditWake } : {}) })
    : options.testOnly ? options.cashu : undefined;
  const admissionReceipts = options.admissionReceiptSecret
    ? new HmacAdmissionReceiptAuthority({ secret: options.admissionReceiptSecret })
    : unavailableAdmissionReceipts;
  const otherwisePublicFundingSurface = Boolean(options.transport && options.capacity && database && vault && lightning && cashu);
  if (otherwisePublicFundingSurface && !options.admissionReceiptSecret) throw new Error("PRODUCTION_ADMISSION_RECEIPT_SECRET_REQUIRED");
  const publicFundingSurface = Boolean(otherwisePublicFundingSurface && options.admissionReceiptSecret);
  const publicGenerationSurface = Boolean(publicFundingSurface && options.meteredService);
  if (publicGenerationSurface && !verifiedCreditWake) throw new Error("PRODUCTION_VERIFIED_CREDIT_WAKE_REQUIRED");
  const sessionCaps = publicGenerationSurface && database ? new SessionCapApprovalService(database.funding) : undefined;
  const publicContinuationSurface = Boolean(publicFundingSurface && options.continuationService);
  const publicPreviewSurface = Boolean(publicFundingSurface && options.preview);
  // Do not let a caller-provided `{ status: "available" }` become a public
  // publication capability. The exact Plan 05 identity/provenance/surface is
  // checked here and again in the announcement, transport adapter, and facade.
  const sourceContract = validatedAvailablePromotedCliSourceContract(options.publicationSourceContract);
  const publicPublicationSurface = Boolean(publicFundingSurface && options.publication && sourceContract);
  const offline = !store || !database || !publicFundingSurface;
  const admissions = new FundedAdmissionService({ funding, store: authority, capacity: options.capacity ?? blockedCapacity, receiptAuthority: admissionReceipts, ...(options.lifecycle ? { telemetry: options.lifecycle } : {}) });
  const accountStatus = new AccountStatusService({ store: authority, sessions: options.sessions ?? emptySessions, ...(database ? { rails: database.railStatuses } : {}) });
  if (publicFundingSurface && options.transport) {
    const announcement = options.announcement ?? {
      topUpCap: { minimum: "1", maximum: String(Number.MAX_SAFE_INTEGER), unit: "sat" },
      pmis: ["bitcoin-lightning-bolt11", "bitcoin-cashu-v4-direct"],
      paymentInteraction: ["transparent", "explicit_gating"],
      tools: [
        { name: "start_session", available: publicGenerationSurface, planned: !publicGenerationSurface }, { name: "revise_session", available: publicGenerationSurface, planned: !publicGenerationSurface }, { name: "resume_session", available: publicContinuationSurface, planned: !publicContinuationSurface }, { name: "session_status", available: publicGenerationSurface, planned: !publicGenerationSurface }, { name: "account_status", available: true, planned: false },
        { name: "top_up", available: true, planned: false }, { name: "funded_admission", available: true, planned: false },
        { name: "preview", available: false, planned: true }, { name: "publication", available: false, planned: true },
      ],
    };
    options.transport.configureAnnouncement(buildContextVmAnnouncement(configureContextVmToolAvailability(announcement, {
      preview: publicPreviewSurface,
      sessionCaps: Boolean(sessionCaps),
      publicationSourceContract: publicPublicationSurface ? sourceContract : undefined,
    })));
  }
  const statusCursorSecret = options.statusCursorSecret ?? crypto.getRandomValues(new Uint8Array(32));
  const contextvm = publicFundingSurface && options.transport && lightning && cashu
    ? new ContextVmFundingAdapter({ ...(sessionCaps ? { sessionCaps } : {}), service: funding, transport: options.transport, admissions, admissionReceipts, accountStatus, topUps: { lightning, cashu },
      ...(options.meteredService ? { generation: options.meteredService, sessionStatus: { read: (query: unknown) => readSessionStatus({ store: authority as MeteredFundingStore, query, cursorSecret: statusCursorSecret }) } } : {}),
      ...(options.continuationService ? { continuation: options.continuationService } : {}),
      ...(options.pricedContinuation ? { pricedContinuation: options.pricedContinuation } : {}),
      ...(options.preview ? { preview: options.preview } : {}),
      ...(options.publication ? { publication: options.publication } : {}),
      ...(options.publicationSourceContract !== undefined ? { publicationSourceContract: options.publicationSourceContract } : {}),
    })
    : undefined;
  const continuationRecovery = options.meteredService?.reconcileOutstandingWakeDispatches
    ? Object.freeze({ reconcileOutstandingWakeDispatches: (accountId: string) => options.meteredService!.reconcileOutstandingWakeDispatches!(accountId) })
    : undefined;
  const rails = lightning && cashu && options.lightningReceiver && options.cashuProvider?.walletOperations
    ? Object.freeze({
      lightning: Object.freeze({ receiver: options.lightningReceiver, coordinator: lightning }),
      /* This is the default adapter's bounded persisted-swap transport, not
       * a separately injected wallet callback. */
      cashu: Object.freeze({ settlement: options.cashuProvider, walletOperations: options.cashuProvider.walletOperations, coordinator: cashu }),
    })
    : undefined;
  return Object.freeze({
    mode: offline ? "offline_design_ready" as const : "configured" as const,
    funding, admissions, accountStatus, ...(contextvm ? { contextvm } : {}), ...(continuationRecovery ? { continuationRecovery } : {}),
    ...(rails ? { rails } : {}),
    externalSurfaces: Object.freeze({
      contextvm: contextvm ? "configured" as const : "blocked" as const,
      lightning: lightning && publicFundingSurface ? "configured" as const : "blocked" as const,
      cashu: cashu && publicFundingSurface ? "configured" as const : "blocked" as const,
      postgres: database || options.postgresExecutor ? "configured" as const : "blocked" as const,
      capacity: options.capacity ? "configured" as const : "blocked" as const,
      modal: "unselected" as const,
    }),
  });
}
