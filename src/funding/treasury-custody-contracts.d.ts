type BlindedMessage = Readonly<{
    B_: string;
    amount: string;
    id: string;
}>;
type RecoveredOutput = Readonly<BlindedMessage & {
    proof: string;
}>;
type PreparedCustody = Readonly<{
    operationId: string;
    accountId: string;
    mintUrl: string;
    keysetId: string;
    unit: "sat";
    amount: string;
    inputToken: Uint8Array;
    semanticProofIdentity: string;
    blindedMessages: readonly BlindedMessage[];
}>;
export type CashuCustodyRecord = Readonly<{
    operationId: string;
    accountId: string;
    mintUrl: string;
    keysetId: string;
    unit: "sat";
    amount: string;
    semanticProofIdentity: string;
    state: "prepared" | "owned_outputs";
    inputCiphertext: Uint8Array;
    blindedCiphertext: Uint8Array;
    outputCiphertext?: Uint8Array;
}>;
/**
 * The bearer-token wire format is deliberately not a replay identity. Each
 * parsed proof is committed individually with the exact UTF-8 secret bytes;
 * ordering and token re-encoding therefore cannot manufacture a new claim.
 * Signature/DLEQ policy validation is performed by the adapter before this
 * identity becomes eligible for a credit.
 */
export declare function canonicalCashuTokenIdentity(token: Uint8Array, allowedKeysetIds: readonly string[]): Promise<string>;
/** Canonical individual proof commitments are the replay authority. */
export declare function canonicalCashuProofIdentities(token: Uint8Array, allowedKeysetIds: readonly string[]): Promise<readonly string[]>;
/**
 * Test/durable-port reference custody implementation. The payloads are
 * AES-GCM ciphertexts, never bearer material; callers can replace the backing
 * map with a production envelope repository without changing the state rules.
 */
export declare class InMemoryCashuTreasuryCustody {
    #private;
    constructor(key?: Uint8Array<ArrayBuffer>);
    prepare(input: PreparedCustody): Promise<CashuCustodyRecord>;
    restoreRequest(operationId: string): Promise<readonly BlindedMessage[]>;
    recordRecoveredOutputs(operationId: string, outputs: readonly RecoveredOutput[]): Promise<CashuCustodyRecord>;
    get(operationId: string): CashuCustodyRecord | undefined;
}
export {};
