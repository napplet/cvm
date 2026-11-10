import { type OperatorFundingRail, type OperatorFundingReadiness, type OperatorFundingReadinessStore } from "./operator-funding";
export type LocalFundingLoopbackPort = Readonly<{
    listen(input: Readonly<{
        host: "127.0.0.1";
        state: string;
        csrf: string;
        expiresAtMs: number;
        submit(input: unknown): Promise<void>;
    }>): Promise<Readonly<{
        url: string;
        close(): Promise<void>;
    }>>;
}>;
export type LocalFundingBrowserPort = Readonly<{
    open(url: string): Promise<void>;
}>;
export type OsSecretStorePort = Readonly<{
    store(input: Readonly<{
        rail: OperatorFundingRail;
        material: Uint8Array;
    }>): Promise<Readonly<{
        secretReference: string;
        capabilitySha256: string;
        accountScopeSha256: string;
    }>>;
}>;
export type LocalFundingSetupDescriptor = Readonly<{
    kind: "local_operator_funding_setup";
    status: "action_required";
    plan: "07-20";
    candidateSha256: string;
    authorizationRequestSha256?: string;
    rails: readonly OperatorFundingRail[];
}>;
export type LocalOperatorFundingSetupOptions = Readonly<{
    candidateSha256: string;
    authorizationRequestSha256?: string;
    loopback: LocalFundingLoopbackPort;
    browser: LocalFundingBrowserPort;
    secrets: OsSecretStorePort;
    readinessStore: OperatorFundingReadinessStore;
    now?: () => number;
    expiresInMs?: number;
    railReadinessExpiresInMs?: number;
}>;
/**
 * Creates, but does not launch, the Plan 07-20 local wallet setup flow. It is
 * intentionally all-injected: this autonomous plan never opens a browser,
 * wallet, keychain, listener, or OS secret facility. On a real macOS launch,
 * Plan 07-20 supplies an OS-keychain-backed `secrets` port; unsupported
 * platforms must reject rather than fall back to a plaintext file.
 */
export declare function createLocalOperatorFundingSetup(options: LocalOperatorFundingSetupOptions): Promise<Readonly<{
    descriptor: () => LocalFundingSetupDescriptor;
    launch(): Promise<void>;
    readiness(): Promise<OperatorFundingReadiness>;
}>>;
/** Explicitly reject implicit cross-platform fallback. A real production port
 * is supplied only by the authorized Plan 07-20 macOS launcher. */
export declare function requireMacOsSecretStore(): void;
/** macOS Keychain writer. Native wallet bytes cross only the subprocess stdin
 * pipe; argv contains only fixed locator labels and stdout/stderr are
 * discarded. */
export declare function createMacOsKeychainSecretStore(): OsSecretStorePort;
export declare function createMacOsBrowserPort(): LocalFundingBrowserPort;
/** A single-use loopback-only browser surface. It accepts bounded form bytes,
 * never logs requests, serves no external assets, and delays shutdown just
 * long enough for the final success response to reach the browser. */
export declare function createBunLocalFundingLoopbackPort(): LocalFundingLoopbackPort;
export declare function createFileOperatorFundingReadinessStore(path: string): OperatorFundingReadinessStore;
