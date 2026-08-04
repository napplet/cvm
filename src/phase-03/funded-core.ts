import { ContextVmFundingAdapter } from "../contextvm/adapter";
import { buildContextVmAnnouncement, type ContextVmAnnouncementInput } from "../contextvm/announcement";
import type { ContextVmTransportPort } from "../contextvm/sdk-bridge";
import { AccountStatusService, type AccountSessionStatusPort } from "../funding/account-status";
import { FundedAdmissionService, type ReadyCapacityPort } from "../funding/funded-admission";
import { FundingService } from "../funding/funding-service";
import { LightningTopUpCoordinator } from "../funding/lightning-top-up";
import { CashuTopUpCoordinator } from "../funding/cashu-top-up";
import type { LightningReceiptPort } from "../funding/lightning-provider";
import type { CashuSettlementPort } from "../funding/cashu-provider";
import type { CashuMintPolicyRegistry } from "../funding/cashu-mint-policy";
import { ProtectedRailMaterialVault } from "../funding/protected-rail-material";
import type { FundingStore, MeteredFundingStore } from "../persistence/funding-store";
import { PostgresFundingStore, type PostgresFundingExecutor } from "../persistence/postgres-funding-store";
import { PostgresSqlFundingStore, type PostgresSqlPool } from "../persistence/postgres-sql-funding-store";
import { PostgresFundingDatabase } from "../persistence/postgres-funding-database";
import type { MeteredGenerationService } from "../phase-04/metered-generation-service";
import { readSessionStatus } from "../phase-04/session-status";

type SurfaceState = "configured" | "blocked" | "unselected";
type BlockedCapacity = ReadyCapacityPort;
const emptySessions: AccountSessionStatusPort = { list: async () => ({ active: [], resumable: [], pendingActions: [] }) };
const blockedCapacity: BlockedCapacity = {
  reserveNow: async () => ({ status: "refused", reason: "CAPACITY_UNCONFIGURED" }),
  observe: async () => ({ status: "unknown" }),
  release: async () => undefined,
};

export type FundedCoreOptions = Readonly<{
  /** Explicit monetary authority. Non-Postgres stores are test-only by contract. */
  store?: FundingStore;
  postgresExecutor?: PostgresFundingExecutor;
  postgresPool?: PostgresSqlPool;
  database?: PostgresFundingDatabase;
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
  meteredService?: Pick<MeteredGenerationService, "startSession" | "reviseSession">;
  /** Server-held HMAC material for opaque status cursors. */
  statusCursorSecret?: Uint8Array;
  testOnly?: boolean;
}>;

export type FundedCore = Readonly<{
  mode: "offline_design_ready" | "configured";
  funding: FundingService;
  admissions: FundedAdmissionService;
  accountStatus: AccountStatusService;
  contextvm?: ContextVmFundingAdapter;
  externalSurfaces: Readonly<{ contextvm: SurfaceState; lightning: SurfaceState; cashu: SurfaceState; postgres: SurfaceState; capacity: SurfaceState; modal: "unselected" }>;
}>;

/**
 * Final Phase 3 composition. It intentionally exposes no worker/model handle:
 * Phase 4 alone may consume action-budget reservations for exact usage.
 */
export function createFundedCore(options: FundedCoreOptions = {}): FundedCore {
  if (options.database && !(options.database instanceof PostgresFundingDatabase)) throw new Error("PRODUCTION_POSTGRES_DATABASE_ADAPTER_REQUIRED");
  if (options.store && !(options.store instanceof PostgresFundingStore) && !(options.store instanceof PostgresSqlFundingStore) && !options.testOnly) throw new Error("PRODUCTION_POSTGRES_FUNDING_STORE_REQUIRED");
  if (options.store && (options.postgresExecutor || options.postgresPool || options.database)) throw new Error("CONFLICTING_FUNDING_STORE_CONFIGURATION");
  if ([options.postgresExecutor, options.postgresPool, options.database].filter(Boolean).length > 1) throw new Error("CONFLICTING_POSTGRES_CONFIGURATION");
  if (!options.testOnly && (options.lightning || options.cashu)) throw new Error("PRODUCTION_RAIL_COMPOSITION_REQUIRED");
  const database = options.database ?? (options.postgresPool ? new PostgresFundingDatabase(options.postgresPool) : undefined);
  const store = options.store ?? database?.funding ?? (options.postgresExecutor ? new PostgresFundingStore(options.postgresExecutor) : undefined);
  // The deterministic test-only path has an explicit in-memory authority. It is
  // still offline design evidence, never a selected database/provider claim.
  const authority = store ?? (() => { throw new Error("POSTGRES_FUNDING_STORE_REQUIRED"); })();
  const funding = new FundingService(authority);
  const railConfigurationStarted = Boolean(options.lightningReceiver || options.cashuProvider || options.cashuPolicies || options.protectedMaterialKey);
  if (railConfigurationStarted && (!database || !options.lightningReceiver || !options.cashuProvider || !options.cashuPolicies || !options.protectedMaterialKey)) throw new Error("PRODUCTION_RAIL_COMPOSITION_REQUIRED");
  const vault = database && options.protectedMaterialKey ? new ProtectedRailMaterialVault({ key: options.protectedMaterialKey, repository: database.protectedMaterials }) : undefined;
  const lightning = database && vault && options.lightningReceiver
    ? new LightningTopUpCoordinator({ funding, receiver: options.lightningReceiver, repository: database.lightning, vault })
    : options.testOnly ? options.lightning : undefined;
  const cashu = database && vault && options.cashuProvider && options.cashuPolicies
    ? new CashuTopUpCoordinator({ funding, provider: options.cashuProvider, policies: options.cashuPolicies, repository: database.cashu, vault })
    : options.testOnly ? options.cashu : undefined;
  const publicFundingSurface = Boolean(options.transport && options.capacity && database && vault && lightning && cashu);
  const publicGenerationSurface = Boolean(publicFundingSurface && options.meteredService);
  const offline = !store || !database || !publicFundingSurface;
  const admissions = new FundedAdmissionService({ funding, store: authority, capacity: options.capacity ?? blockedCapacity });
  const accountStatus = new AccountStatusService({ store: authority, sessions: options.sessions ?? emptySessions, ...(database ? { rails: database.railStatuses } : {}) });
  if (publicFundingSurface && options.transport) {
    options.transport.configureAnnouncement(buildContextVmAnnouncement(options.announcement ?? {
      topUpCap: { minimum: "1", maximum: String(Number.MAX_SAFE_INTEGER), unit: "sat" },
      pmis: ["bitcoin-lightning-bolt11", "bitcoin-cashu-v4-direct"],
      paymentInteraction: ["transparent", "explicit_gating"],
      tools: [
        { name: "start_session", available: publicGenerationSurface, planned: !publicGenerationSurface }, { name: "revise_session", available: publicGenerationSurface, planned: !publicGenerationSurface }, { name: "session_status", available: publicGenerationSurface, planned: !publicGenerationSurface }, { name: "account_status", available: true, planned: false },
        { name: "top_up", available: true, planned: false }, { name: "funded_admission", available: true, planned: false },
        { name: "preview", available: false, planned: true }, { name: "publication", available: false, planned: true },
      ],
    }));
  }
  const statusCursorSecret = options.statusCursorSecret ?? crypto.getRandomValues(new Uint8Array(32));
  const contextvm = publicFundingSurface && options.transport && lightning && cashu
    ? new ContextVmFundingAdapter({ service: funding, transport: options.transport, admissions, accountStatus, topUps: { lightning, cashu },
      ...(options.meteredService ? { generation: options.meteredService, sessionStatus: { read: (query: unknown) => readSessionStatus({ store: authority as MeteredFundingStore, query, cursorSecret: statusCursorSecret }) } } : {}),
    })
    : undefined;
  return Object.freeze({
    mode: offline ? "offline_design_ready" as const : "configured" as const,
    funding, admissions, accountStatus, ...(contextvm ? { contextvm } : {}),
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
