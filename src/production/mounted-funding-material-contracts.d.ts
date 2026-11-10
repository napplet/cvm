import { CashuMintPolicyRegistry } from "../funding/cashu-mint-policy";
import type { ContextVmServiceSignerBroker } from "../release/deployment/contextvm-client";
import type { NwcCredentialBroker } from "../release/deployment/signed-nwc-transport";
import type { MountedProductionSecretMaterial } from "./secret-material";
import type { ProductionConfig } from "./config";
/** Mounted service/NWC key material is parsed only in the coordinator and
 * normalized immediately into SDK signer capabilities.  Generated workers
 * receive neither this broker nor the underlying bytes. */
export declare function createMountedProductionFundingMaterial(input: Readonly<{
    config: ProductionConfig;
    secrets: MountedProductionSecretMaterial;
}>): Promise<Readonly<{
    contextvmSignerBroker: ContextVmServiceSignerBroker;
    nwcCredentialBroker: NwcCredentialBroker;
    cashuPolicies: CashuMintPolicyRegistry;
}>>;
