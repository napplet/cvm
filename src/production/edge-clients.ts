import type { CashuSettlementPort, CashuWalletOperations } from "../funding/cashu-provider";
import type { CashuTopUpCoordinator } from "../funding/cashu-top-up";
import type { LightningReceiptPort } from "../funding/lightning-provider";
import type { LightningTopUpCoordinator } from "../funding/lightning-top-up";
import type { OwnerEventVerifierPort } from "../publication/contracts";
import { createNativeCashuProvider } from "../release/native/cashu";
import { createNativeCep8LightningProvider } from "../release/native/cep8-lightning";
import { CompatibleHostBrowserObservationPort, type CompatibleHostBrowserPort, type CompatibleHostPackagePort } from "../release/native/compatible-host";
import { ExternalSignerBoundaryAdapter, type ExternalSignerPort } from "../release/native/external-signer";
import { createNostrRelayPublicationAdapter, type NostrRelayPort } from "../release/native/nostr-relay";
import { createNativePromotedNappletCliSource } from "../release/native/promoted-cli";
import { createExactSealedUploadAdapter, type ExactSealedUploadPort } from "../release/native/upload";
import type { ProductionPaymentScenarioContext, ProductionPublicationContext, ProductionSourceBuildVerifier } from "../release/deployment/production-session-runtime";
import { z } from "zod";

export const MountedPublicationOperationSchema = z.object({
  operationId: z.string().regex(/^[a-z][a-z0-9:_-]{2,300}$/u),
  eventTemplate: z.object({ kind: z.literal(35129), content: z.string().max(64_000), tags: z.array(z.array(z.string().max(4096)).min(1).max(16)).max(128), created_at: z.number().int().positive() }).strict(),
  relaySet: z.array(z.string().url().refine(value => value.startsWith("wss://"))).min(1).max(16),
  persistenceEndpoint: z.string().url().refine(value => new URL(value).protocol === "https:"),
}).strict();
export type MountedPublicationOperation = z.infer<typeof MountedPublicationOperationSchema>;
export function mountedPublicationEndpoints(value: MountedPublicationOperation) {
  const operation = MountedPublicationOperationSchema.parse(value); const base = new URL(operation.persistenceEndpoint);
  const url = new URL(`/internal/edge-publication/operations/${encodeURIComponent(operation.operationId)}`, base).toString();
  return Object.freeze({ persist: url, observe: url });
}

/**
 * The only construction point for Plan 69 native edges. Mounting code supplies
 * authenticated provider transports and durable coordinators, never reports or
 * suite callbacks. Configuration remains reference/hash-only; the user NIP-46
 * signer is an external protocol endpoint and no private owner key crosses
 * this boundary.
 */
export function createProductionEdgeClients(input: Readonly<{
  authorizationRequest: unknown;
  authorizationReceipt: unknown;
  host: Readonly<{ packageHost: CompatibleHostPackagePort; chromium: CompatibleHostBrowserPort }>;
  ownerSigner: Readonly<{ signer: ExternalSignerPort; verifier: OwnerEventVerifierPort }>;
  lightning: Readonly<{ config: unknown; receiver: LightningReceiptPort; coordinator: LightningTopUpCoordinator }>;
  cashu: Readonly<{ config: unknown; settlement: CashuSettlementPort; walletOperations: CashuWalletOperations; coordinator: CashuTopUpCoordinator }>;
  publication: Readonly<{
    upload: Readonly<{ config: unknown; port: ExactSealedUploadPort }>;
    relay: Readonly<{ config: unknown; port: NostrRelayPort }>;
    promotedSnapshot: unknown;
  }>;
  publicationContext: ProductionPublicationContext;
  paymentScenarioContext: ProductionPaymentScenarioContext;
  sourceBuild: ProductionSourceBuildVerifier;
  now?: () => number;
}>) {
  if (input.host.chromium.kind !== "chromium") throw new Error("PRODUCTION_EDGE_CHROMIUM_REQUIRED");
  if (!input.publicationContext || typeof input.publicationContext.resolve !== "function"
    || !input.paymentScenarioContext || typeof input.paymentScenarioContext.resolve !== "function"
    || input.sourceBuild?.authority !== "production-real" || typeof input.sourceBuild.verify !== "function") {
    throw new Error("PRODUCTION_EDGE_DURABLE_CONTEXT_REQUIRED");
  }
  // Constructors must be inert: provider configuration can reference secret
  // material, but it may not resolve it, touch a client, or emit a report until
  // an exact receipt-bound operation has been claimed.  These fixed getters are
  // the only way the sealed broker reaches the native operational adapters.
  let compatibleHost: CompatibleHostBrowserObservationPort | undefined;
  let signer: ExternalSignerBoundaryAdapter | undefined;
  let cep8: ReturnType<typeof createNativeCep8LightningProvider> | undefined;
  let cashu: ReturnType<typeof createNativeCashuProvider> | undefined;
  let upload: ReturnType<typeof createExactSealedUploadAdapter> | undefined;
  let relays: ReturnType<typeof createNostrRelayPublicationAdapter> | undefined;
  let promotedCli: ReturnType<typeof createNativePromotedNappletCliSource> | undefined;
  return Object.freeze({
    get compatibleHost() { return compatibleHost ??= new CompatibleHostBrowserObservationPort({ packageHost: input.host.packageHost, browser: input.host.chromium }); },
    get signer() { return signer ??= new ExternalSignerBoundaryAdapter({ signer: input.ownerSigner.signer, ownerEventVerifier: input.ownerSigner.verifier }); },
    get cep8() { return cep8 ??= createNativeCep8LightningProvider(input.lightning); },
    get cashu() { return cashu ??= createNativeCashuProvider(input.cashu); },
    get relays() {
      return relays ??= createNostrRelayPublicationAdapter({
        config: input.publication.relay.config, request: input.authorizationRequest, receipt: input.authorizationReceipt,
        port: input.publication.relay.port, now: input.now,
      });
    },
    get promotedCli() {
      const relay = this.relays;
      const exactUpload = upload ??= createExactSealedUploadAdapter({
        config: input.publication.upload.config, request: input.authorizationRequest, receipt: input.authorizationReceipt,
        port: input.publication.upload.port, now: input.now,
      });
      return promotedCli ??= createNativePromotedNappletCliSource({ snapshot: input.publication.promotedSnapshot, upload: exactUpload, relay: relay.asPromotedCliSource() });
    },
    publicationContext: input.publicationContext,
    paymentScenarioContext: input.paymentScenarioContext,
    sourceBuild: input.sourceBuild,
  });
}
