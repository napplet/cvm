/**
 * Rail payloads are bearer/provider material.  This module is deliberately the
 * only place where their plaintext is transformed to or from persistence.
 */
export type ProtectedRail = "lightning" | "cashu";
export type ProtectedRailMaterialMetadata = Readonly<{
    accountId: string;
    topUpId: string;
    rail: ProtectedRail;
}>;
export type ProtectedRailMaterialRecord = Readonly<ProtectedRailMaterialMetadata & {
    id: string;
    payloadDigest: string;
    nonce: Uint8Array;
    ciphertext: Uint8Array;
    createdAt: string;
    expiresAt?: string;
}>;
export interface ProtectedRailMaterialRepository {
    put(record: ProtectedRailMaterialRecord): Promise<void>;
    get(id: string): Promise<ProtectedRailMaterialRecord | undefined>;
    expire(id: string): Promise<void>;
}
export type ProtectedRailMaterialVaultOptions = Readonly<{
    key: Uint8Array;
    repository: ProtectedRailMaterialRepository;
    now?: () => string;
    randomValues?: (bytes: Uint8Array) => Uint8Array;
}>;
export type ProtectedRailMaterialReference = Readonly<{
    id: string;
    payloadDigest: string;
}>;
export type ProtectedRailMaterialOpenRequest = Readonly<ProtectedRailMaterialMetadata & {
    id: string;
}>;
/** In-memory repository is a deterministic test double; production injects durable storage. */
export declare class InMemoryProtectedRailMaterialRepository implements ProtectedRailMaterialRepository {
    #private;
    put(record: ProtectedRailMaterialRecord): Promise<void>;
    get(id: string): Promise<ProtectedRailMaterialRecord | undefined>;
    expire(id: string): Promise<void>;
    snapshot(): readonly ProtectedRailMaterialRecord[];
}
/** AES-GCM boundary with caller-provided 32-byte key material and top-up-bound AAD. */
export declare class ProtectedRailMaterialVault {
    #private;
    constructor(options: ProtectedRailMaterialVaultOptions);
    seal(metadata: ProtectedRailMaterialMetadata, plaintext: Uint8Array, expiresAt?: string): Promise<ProtectedRailMaterialReference>;
    open(request: ProtectedRailMaterialOpenRequest): Promise<Uint8Array>;
    expire(id: string): Promise<void>;
}
