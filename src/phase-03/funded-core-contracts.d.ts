import { ContextVmFundingAdapter } from "../contextvm/adapter";
import { type ContextVmAnnouncementInput } from "../contextvm/announcement";
import type { ContextVmTransportPort } from "../contextvm/sdk-bridge";
import { AccountStatusService, type AccountSessionStatusPort } from "../funding/account-status";
import { FundedAdmissionService, type ReadyCapacityPort } from "../funding/funded-admission";
import { FundingService } from "../funding/funding-service";
import { LightningTopUpCoordinator } from "../funding/lightning-top-up";
import { CashuTopUpCoordinator } from "../funding/cashu-top-up";
import type { LightningReceiptPort } from "../funding/lightning-provider";
import type { CashuSettlementPort, CashuWalletOperations } from "../funding/cashu-provider";
import type { CashuMintPolicyRegistry } from "../funding/cashu-mint-policy";
import type { FundingStore } from "../persistence/funding-store";
import { type PostgresFundingExecutor } from "../persistence/postgres-funding-store";
import type { PostgresSqlPool } from "../persistence/postgres-sql-funding-store";
import { PostgresFundingDatabase } from "../persistence/postgres-funding-database";
import { type AccountingRealmName } from "../funding/accounting-realm";
import type { MeteredGenerationService } from "../phase-04/metered-generation-service";
import type { ContinuationService } from "../continuity/continuation-service";
import type { LifecycleTelemetryPort } from "../telemetry/contracts";
type SurfaceState = "configured" | "blocked" | "unselected";
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
        lightning: Readonly<{
            receiver: LightningReceiptPort;
            coordinator: LightningTopUpCoordinator;
        }>;
        cashu: Readonly<{
            settlement: CashuSettlementPort;
            walletOperations: CashuWalletOperations;
            coordinator: CashuTopUpCoordinator;
        }>;
    }>;
    /** Coordinator-only restart lifecycle; this discovers durable wake effects, never queues generation. */
    continuationRecovery?: Readonly<{
        reconcileOutstandingWakeDispatches(accountId: string): ReturnType<MeteredGenerationService["reconcileOutstandingWakeDispatches"]>;
    }>;
    externalSurfaces: Readonly<{
        contextvm: SurfaceState;
        lightning: SurfaceState;
        cashu: SurfaceState;
        postgres: SurfaceState;
        capacity: SurfaceState;
        modal: "unselected";
    }>;
}>;
/**
 * Final Phase 3 composition. It intentionally exposes no worker/model handle:
 * Phase 4 alone may consume action-budget reservations for exact usage.
 */
export declare function createFundedCore(options?: FundedCoreOptions): FundedCore;
export {};
