import type { PostgresSqlClient, PostgresSqlPool } from "../src/persistence/postgres-sql-funding-store";
export type DevPayments = {
    version: 1;
    developmentOnly: true;
    mintUrl: string;
    secondaryMintUrl: string;
    relayUrl: string;
    hubUrl: string;
    nwcUri: string;
    cashuToken: string;
    databaseUrl: string;
    fundingKey: string;
};
type DevelopmentPool = PostgresSqlPool & Pick<PostgresSqlClient, "query"> & {
    end(): Promise<void>;
};
export declare const DEVELOPMENT_MIGRATIONS: readonly ["phase-03/001_funding.sql", "phase-03/003_cashu_custody_and_identities.sql", "phase-04/001_metered_generation.sql", "phase-04/002_action_budget_lifecycle.sql", "phase-05/001_continuation.sql", "phase-06/001_publication.sql", "development/001_generation.sql", "development/002_provider_observations.sql", "development/003_artifact_preview.sql", "development/004_source_proposal_bindings.sql", "development/005_pending_actions.sql", "development/006_worker_results.sql", "development/007_chatgpt_operations.sql", "development/008_chatgpt_diagnostics.sql", "development/009_operator_publication.sql", "development/010_projects.sql", "development/011_publication_relays.sql", "development/012_remix_imports.sql", "development/013_publication_tracking.sql", "development/014_request_cost_history.sql", "development/015_revision_restore.sql", "development/016_usage_evidence.sql", "service/001_service_realm.sql", "development/017_validation_failures.sql", "development/018_model_turn_evidence.sql"];
export declare function createDevelopmentPool(databaseUrl: string): DevelopmentPool;
/** Real encrypted NIP-47 request over the local relay only. */
export declare function nwcRequest(uri: string, method: string, params?: Record<string, unknown>, callerSignal?: AbortSignal): Promise<any>;
export declare function expectedDevelopmentMigrations(): Promise<Array<Readonly<{
    name: string;
    sha256: string;
    sql: string;
}>>>;
export declare function waitUntil(check: () => Promise<boolean>, label: string, timeoutMs?: number): Promise<void>;
export declare function developmentStack(test?: boolean, options?: Readonly<{
    instance?: string;
}>): {
    directory: string;
    externalTestInvoice(): Promise<string>;
    down(reset?: boolean): Promise<void>;
    up(): Promise<DevPayments>;
};
export declare function withRunOwnedStack<T>(stack: Readonly<{
    down(reset?: boolean): Promise<void>;
}>, work: () => Promise<T>): Promise<T>;
export {};
