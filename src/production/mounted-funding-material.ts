import { z } from "zod";
import { PrivateKeySigner } from "@contextvm/sdk/signer/private-key-signer";
import type { NostrSigner } from "@contextvm/sdk/core";
import { CashuMintPolicyRegistry } from "../funding/cashu-mint-policy";
import type { ContextVmServiceSignerBroker } from "../release/deployment/contextvm-client";
import type { NwcCredentialBroker } from "../release/deployment/signed-nwc-transport";
import type { MountedProductionSecretMaterial } from "./secret-material";
import type { ProductionConfig } from "./config";

const Hex = z.string().regex(/^[a-f0-9]{64}$/iu).transform(value => value.toLowerCase());
const Relay = z.string().url().refine(value => new URL(value).protocol === "wss:");
const NwcCredential = z.object({ connectionScopeDigest: Hex, walletPubkey: Hex, relays: z.array(Relay).min(1).max(16), consentedMethods: z.array(z.enum(["make_invoice", "lookup_invoice", "list_transactions"])).min(1).max(3), privateKey: Hex }).strict();
const CashuConsent = z.object({ policy: z.unknown() }).strict();

function signer(privateKey: string): NostrSigner {
  return new PrivateKeySigner(Hex.parse(privateKey));
}

/** Mounted service/NWC key material is parsed only in the coordinator and
 * normalized immediately into SDK signer capabilities.  Generated workers
 * receive neither this broker nor the underlying bytes. */
export async function createMountedProductionFundingMaterial(input: Readonly<{
  config: ProductionConfig;
  secrets: MountedProductionSecretMaterial;
}>): Promise<Readonly<{
  contextvmSignerBroker: ContextVmServiceSignerBroker;
  nwcCredentialBroker: NwcCredentialBroker;
  cashuPolicies: CashuMintPolicyRegistry;
}>> {
  const [contextKey, nwcText, cashuText] = await Promise.all([
    input.secrets.text("contextvm.serviceKeyReference", 256),
    input.secrets.text("funding.nwcConnectionReference", 16_384),
    input.secrets.text("funding.cashuConsentReference", 65_536),
  ]);
  const serviceKey = Hex.parse(contextKey);
  const nwc = NwcCredential.parse(JSON.parse(nwcText));
  const consent = CashuConsent.parse(JSON.parse(cashuText));
  const cashuPolicies = new CashuMintPolicyRegistry(consent.policy);
  return Object.freeze({
    contextvmSignerBroker: Object.freeze({
      async resolveContextVmSigner(request: Readonly<{ reference: string; purpose: "contextvm_service" }>) {
        if (request.reference !== input.config.contextvm.serviceKeyReference || request.purpose !== "contextvm_service") throw new Error("PRODUCTION_CONTEXTVM_SIGNER_REFERENCE_DENIED");
        return signer(serviceKey);
      },
    }),
    nwcCredentialBroker: Object.freeze({
      async resolveNwcLightningCapability(request: Readonly<{ reference: string; purpose: "nwc_lightning_receipts" }>) {
        if (request.reference !== input.config.funding.nwcConnectionReference || request.purpose !== "nwc_lightning_receipts") throw new Error("PRODUCTION_NWC_SIGNER_REFERENCE_DENIED");
        return Object.freeze({ connectionScopeDigest: nwc.connectionScopeDigest, walletPubkey: nwc.walletPubkey, relays: Object.freeze([...nwc.relays]), consentedMethods: Object.freeze([...nwc.consentedMethods]), signer: signer(nwc.privateKey) });
      },
    }),
    cashuPolicies,
  });
}
