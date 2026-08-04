import { ContextVmFundingAdapter } from "../contextvm/adapter";
import { buildContextVmAnnouncement, type ContextVmAnnouncementInput } from "../contextvm/announcement";
import type { ContextVmTransportPort } from "../contextvm/sdk-bridge";
import { AccountStatusService, type AccountSessionStatusPort } from "../funding/account-status";
import { FundedAdmissionService, type ReadyCapacityPort } from "../funding/funded-admission";
import { FundingService } from "../funding/funding-service";
import type { LightningTopUpCoordinator } from "../funding/lightning-top-up";
import type { CashuTopUpCoordinator } from "../funding/cashu-top-up";
import type { FundingStore } from "../persistence/funding-store";
import { PostgresFundingStore, type PostgresFundingExecutor } from "../persistence/postgres-funding-store";
import { PostgresSqlFundingStore, type PostgresSqlPool } from "../persistence/postgres-sql-funding-store";

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
  capacity?: ReadyCapacityPort;
  sessions?: AccountSessionStatusPort;
  transport?: ContextVmTransportPort;
  lightning?: LightningTopUpCoordinator;
  cashu?: CashuTopUpCoordinator;
  announcement?: ContextVmAnnouncementInput;
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
  if (options.store && !(options.store instanceof PostgresFundingStore) && !(options.store instanceof PostgresSqlFundingStore) && !options.testOnly) throw new Error("PRODUCTION_POSTGRES_FUNDING_STORE_REQUIRED");
  if (options.store && (options.postgresExecutor || options.postgresPool)) throw new Error("CONFLICTING_FUNDING_STORE_CONFIGURATION");
  if (options.postgresExecutor && options.postgresPool) throw new Error("CONFLICTING_POSTGRES_CONFIGURATION");
  const store = options.store ?? (options.postgresPool ? new PostgresSqlFundingStore(options.postgresPool) : options.postgresExecutor ? new PostgresFundingStore(options.postgresExecutor) : undefined);
  const publicFundingSurface = Boolean(options.transport && options.capacity && options.lightning?.durable && options.cashu?.durable);
  const offline = !store || (!options.postgresExecutor && !options.postgresPool) || !publicFundingSurface;
  // The deterministic test-only path has an explicit in-memory authority. It is
  // still offline design evidence, never a selected database/provider claim.
  const authority = store ?? (() => { throw new Error("POSTGRES_FUNDING_STORE_REQUIRED"); })();
  const funding = new FundingService(authority);
  const admissions = new FundedAdmissionService({ funding, store: authority, capacity: options.capacity ?? blockedCapacity });
  const accountStatus = new AccountStatusService({ store: authority, sessions: options.sessions ?? emptySessions });
  if (publicFundingSurface && options.transport) {
    options.transport.configureAnnouncement(buildContextVmAnnouncement(options.announcement ?? {
      topUpCap: { minimum: "1", maximum: String(Number.MAX_SAFE_INTEGER), unit: "sat" },
      pmis: ["bitcoin-lightning-bolt11", "bitcoin-cashu-v4-direct"],
      paymentInteraction: ["transparent", "explicit_gating"],
      tools: [
        { name: "generation", available: false, planned: true }, { name: "account_status", available: true, planned: false },
        { name: "top_up", available: true, planned: false }, { name: "funded_admission", available: true, planned: false },
        { name: "session", available: false, planned: true }, { name: "preview", available: false, planned: true }, { name: "publication", available: false, planned: true },
      ],
    }));
  }
  const contextvm = publicFundingSurface && options.transport && options.lightning && options.cashu
    ? new ContextVmFundingAdapter({ funding, transport: options.transport, admissions, accountStatus, topUps: { lightning: options.lightning, cashu: options.cashu } })
    : undefined;
  return Object.freeze({
    mode: offline ? "offline_design_ready" as const : "configured" as const,
    funding, admissions, accountStatus, ...(contextvm ? { contextvm } : {}),
    externalSurfaces: Object.freeze({
      contextvm: contextvm ? "configured" as const : "blocked" as const,
      lightning: options.lightning ? "configured" as const : "blocked" as const,
      cashu: options.cashu ? "configured" as const : "blocked" as const,
      postgres: options.postgresExecutor || options.postgresPool ? "configured" as const : "blocked" as const,
      capacity: options.capacity ? "configured" as const : "blocked" as const,
      modal: "unselected" as const,
    }),
  });
}
