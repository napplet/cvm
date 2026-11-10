import type { CashuSettlementPort, CashuWalletOperations } from "../funding/cashu-provider";
import type { CashuTopUpCoordinator } from "../funding/cashu-top-up";
import type { LightningReceiptPort } from "../funding/lightning-provider";
import type { LightningTopUpCoordinator } from "../funding/lightning-top-up";
import type { OwnerEventVerifierPort } from "../publication/contracts";
import { CompatibleHostBrowserObservationPort, type CompatibleHostBrowserPort, type CompatibleHostPackagePort } from "../release/native/compatible-host";
import { ExternalSignerBoundaryAdapter, type ExternalSignerPort } from "../release/native/external-signer";
import { type NostrRelayPort } from "../release/native/nostr-relay";
import { type ExactSealedUploadPort } from "../release/native/upload";
import type { ProductionPaymentScenarioContext, ProductionPublicationContext, ProductionSourceBuildVerifier } from "../release/deployment/production-session-runtime";
import { z } from "zod";
export declare const MountedPublicationOperationSchema: z.ZodObject<{
    operationId: z.ZodString;
    eventTemplate: z.ZodObject<{
        kind: z.ZodLiteral<35129>;
        content: z.ZodString;
        tags: z.ZodArray<z.ZodArray<z.ZodString>>;
        created_at: z.ZodNumber;
    }, z.core.$strict>;
    relaySet: z.ZodArray<z.ZodString>;
    persistenceEndpoint: z.ZodString;
}, z.core.$strict>;
export type MountedPublicationOperation = z.infer<typeof MountedPublicationOperationSchema>;
export declare function mountedPublicationEndpoints(value: MountedPublicationOperation): Readonly<{
    persist: string;
    observe: string;
}>;
/**
 * The only construction point for Plan 69 native edges. Mounting code supplies
 * authenticated provider transports and durable coordinators, never reports or
 * suite callbacks. Configuration remains reference/hash-only; the user NIP-46
 * signer is an external protocol endpoint and no private owner key crosses
 * this boundary.
 */
export declare function createProductionEdgeClients(input: Readonly<{
    authorizationRequest: unknown;
    authorizationReceipt: unknown;
    host: Readonly<{
        packageHost: CompatibleHostPackagePort;
        chromium: CompatibleHostBrowserPort;
    }>;
    ownerSigner: Readonly<{
        signer: ExternalSignerPort;
        verifier: OwnerEventVerifierPort;
    }>;
    lightning: Readonly<{
        config: unknown;
        receiver: LightningReceiptPort;
        coordinator: LightningTopUpCoordinator;
    }>;
    cashu: Readonly<{
        config: unknown;
        settlement: CashuSettlementPort;
        walletOperations: CashuWalletOperations;
        coordinator: CashuTopUpCoordinator;
    }>;
    publication: Readonly<{
        upload: Readonly<{
            config: unknown;
            port: ExactSealedUploadPort;
        }>;
        relay: Readonly<{
            config: unknown;
            port: NostrRelayPort;
        }>;
        promotedSnapshot: unknown;
    }>;
    publicationContext: ProductionPublicationContext;
    paymentScenarioContext: ProductionPaymentScenarioContext;
    sourceBuild: ProductionSourceBuildVerifier;
    now?: () => number;
}>): Readonly<{
    compatibleHost: CompatibleHostBrowserObservationPort;
    signer: ExternalSignerBoundaryAdapter;
    cep8: Readonly<{
        discovery(): import("../release/native/cep8-lightning").NativeCep8LightningConfig;
        beginAfterReceipt(input: Readonly<{
            receipt: import("../release/native/cep8-lightning").NativeCep8PaymentReceipt;
            input: import("../funding/lightning-top-up").BeginLightningTopUpInput;
        }>): Promise<import("../funding/lightning-top-up").LightningTopUpResult>;
        reconcileOriginal(input: Readonly<{
            principal: import("../funding/lightning-top-up").BeginLightningTopUpInput["principal"];
            topUpId: string;
        }>): Promise<import("../funding/lightning-top-up").LightningTopUpResult>;
        verifiedSettlementCount(): number;
    }>;
    cashu: Readonly<{
        discovery(): import("../release/native/cashu").NativeCashuConfig;
        submitAfterReceipt(input: Readonly<{
            receipt: import("../release/native/cashu").NativeCashuPaymentReceipt;
            input: unknown;
        }>): Promise<import("../funding/cashu-top-up").CashuTopUpResult>;
        reconcileOriginal(topUpId: string): Promise<import("../funding/cashu-top-up").CashuTopUpResult>;
        verifiedSettlementCount(): number;
    }>;
    promotedCli: Readonly<{
        contract: import("../publication/napplet-cli-source-contract").PromotedCliSourceContractResult;
        port: import("../publication/napplet-cli-adapter").PromotedNappletCliSourcePort;
    }>;
    relays: Readonly<{
        publishOwnerManifest(input: Readonly<{
            operationId: string;
            event: unknown;
            relays: readonly string[];
        }>): Promise<import("../publication/contracts").PublicationObservation>;
        publishAttestation(input: Readonly<{
            operationId: string;
            event: unknown;
            relays: readonly string[];
        }>): Promise<import("../publication/contracts").PublicationObservation>;
        reconcileOriginalEvent(input: Readonly<{
            operationId: string;
        }>): Promise<import("../publication/contracts").PublicationObservation>;
        asPromotedCliSource(): Readonly<{
            publishOriginalEvent(input: Readonly<{
                operationId: string;
                event: unknown;
                relays: readonly string[];
            }>): Promise<import("../publication/napplet-cli-adapter").StructuredSourceEffect>;
            reconcileOriginalEvent(input: Readonly<{
                operationId: string;
            }>): Promise<import("../publication/napplet-cli-adapter").StructuredSourceEffect>;
        }>;
        attestationPort: Readonly<{
            publish(input: Readonly<{
                operationId: string;
                artifact: import("../publication/contracts").SealedArtifactIdentity;
                ownerEventId: string;
            }>): Promise<import("../publication/contracts").PublicationObservation>;
            observe(input: Readonly<{
                operationId: string;
            }>): Promise<import("../publication/contracts").PublicationObservation>;
        }>;
    }>;
    publicationContext: Readonly<{
        resolve(input: Readonly<{
            candidateSha256: string;
            sealedArtifactSha256: string;
            aggregateSha256: string;
        }>): Promise<Readonly<{
            artifact: import("../publication/contracts").SealedArtifactIdentity;
            intent: import("../publication/contracts").PublicationIntent;
            requiredSignerCapabilities: readonly string[];
            relaySet: readonly string[];
        }>>;
        deploy(input: Readonly<{
            candidateSha256: string;
            sealedArtifactSha256: string;
            aggregateSha256: string;
            operationId: string;
        }>): Promise<Readonly<{
            target: Readonly<{
                kind: 35129;
                dTag: string;
            }>;
            files: readonly import("../publication/napplet-cli-adapter").PreSignedNamedDeployFile[];
            servers: readonly string[];
            authorizeExactHashes(hashes: readonly string[]): Promise<unknown>;
        }>>;
    }>;
    paymentScenarioContext: Readonly<{
        resolve(input: Readonly<{
            candidateSha256: string;
            operationId: string;
        }>): Promise<Readonly<{
            lightning: unknown;
            cashu: unknown;
        }>>;
    }>;
    sourceBuild: Readonly<{
        authority: "production-real";
        verify(input: unknown): Promise<unknown>;
    }>;
}>;
