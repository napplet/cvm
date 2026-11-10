type ServiceFunding = Awaited<ReturnType<typeof import("../../scripts/dev-funding").createDevelopmentFunding>>;
type DevelopmentFunding = Pick<ServiceFunding, "database" | "lightning">;
/**
 * Development-only NWC settlement observer. It has no ledger authority: it
 * discovers durable pending rows, then lets the existing coordinator observe
 * and credit the original local-NWC settlement identity exactly once. The
 * local receiver is the payee; this observer never treats an invoice or a
 * browser action as settlement proof.
 */
export declare class DevelopmentNwcSettlementReconciler {
    #private;
    private readonly app;
    private readonly intervalMs;
    private readonly deadlineMs;
    constructor(app: DevelopmentFunding, intervalMs?: number, deadlineMs?: number);
    start(): void;
    stop(): void;
    /** Safe bounded diagnostics: only counts and durable top-up observation work. */
    diagnostics(): Readonly<{
        checked: number;
        observed: number;
        deadlineReached: boolean;
        at: string;
    }>;
    reconcilePending(): Promise<void>;
}
export {};
