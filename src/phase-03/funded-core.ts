import { ContextVmFundingAdapter } from "../contextvm/adapter";
import type { ContextVmTransportPort } from "../contextvm/sdk-bridge";
import { AccountStatusService, type AccountSessionStatusPort } from "../funding/account-status";
import { FundedAdmissionService, type ReadyCapacityPort } from "../funding/funded-admission";
import { FundingService } from "../funding/funding-service";
import type { FundingStore } from "../persistence/funding-store";
import { PostgresFundingStore, type PostgresFundingExecutor } from "../persistence/postgres-funding-store";

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
  capacity?: ReadyCapacityPort;
  sessions?: AccountSessionStatusPort;
  transport?: ContextVmTransportPort;
  lightning?: unknown;
  cashu?: unknown;
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
  if (options.store && !(options.store instanceof PostgresFundingStore) && !options.testOnly) throw new Error("PRODUCTION_POSTGRES_FUNDING_STORE_REQUIRED");
  if (options.store && options.postgresExecutor) throw new Error("CONFLICTING_FUNDING_STORE_CONFIGURATION");
  const store = options.store ?? (options.postgresExecutor ? new PostgresFundingStore(options.postgresExecutor) : undefined);
  const offline = !store || !options.postgresExecutor || !options.capacity || !options.transport || !options.lightning || !options.cashu;
  // The deterministic test-only path has an explicit in-memory authority. It is
  // still offline design evidence, never a selected database/provider claim.
  const authority = store ?? (() => { throw new Error("POSTGRES_FUNDING_STORE_REQUIRED"); })();
  const funding = new FundingService(authority);
  const admissions = new FundedAdmissionService({ funding, store: authority, capacity: options.capacity ?? blockedCapacity });
  const accountStatus = new AccountStatusService({ store: authority, sessions: options.sessions ?? emptySessions });
  const contextvm = options.transport ? new ContextVmFundingAdapter({ funding, transport: options.transport }) : undefined;
  return Object.freeze({
    mode: offline ? "offline_design_ready" as const : "configured" as const,
    funding, admissions, accountStatus, ...(contextvm ? { contextvm } : {}),
    externalSurfaces: Object.freeze({
      contextvm: options.transport ? "configured" as const : "blocked" as const,
      lightning: options.lightning ? "configured" as const : "blocked" as const,
      cashu: options.cashu ? "configured" as const : "blocked" as const,
      postgres: options.postgresExecutor ? "configured" as const : "blocked" as const,
      capacity: options.capacity ? "configured" as const : "blocked" as const,
      modal: "unselected" as const,
    }),
  });
}
