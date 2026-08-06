import type { PreSignedNamedDeployFile, PromotedNappletCliSourcePort, StructuredSourceEffect } from "../../publication/napplet-cli-adapter.js";
import { probePromotedCliPreSignedRoute, type PromotedCliSourceContractResult } from "../../publication/napplet-cli-source-contract.js";
import type { ExactSealedUploadAdapter } from "./upload.js";

export type NativeRelaySourcePort = Readonly<{
  publishOriginalEvent(input: Readonly<{ operationId: string; event: unknown; relays: readonly string[] }>): Promise<StructuredSourceEffect>;
  reconcileOriginalEvent(input: Readonly<{ operationId: string }>): Promise<StructuredSourceEffect>;
}>;

export type NativePromotedCliSource = Readonly<{
  contract: PromotedCliSourceContractResult;
  port: PromotedNappletCliSourcePort;
}>;

/**
 * Composes only the reviewed promoted source surface. The source snapshot is
 * verified before every delegated upload/relay effect; it never discovers a
 * package, executes a CLI binary, or opens a publication route on its own.
 */
export function createNativePromotedNappletCliSource(input: Readonly<{
  snapshot: unknown;
  upload: Pick<ExactSealedUploadAdapter, "uploadExact" | "reconcileOriginalUpload">;
  relay: NativeRelaySourcePort;
}>): NativePromotedCliSource {
  const verified = probePromotedCliPreSignedRoute(input.snapshot);
  const available = () => probePromotedCliPreSignedRoute(input.snapshot).status === "available";

  const port: PromotedNappletCliSourcePort = Object.freeze({
    async uploadFilesToServers(value) {
      if (!available() || !value.servers.length) return Object.freeze({ operationId: value.operationId, state: "failed" });
      return input.upload.uploadExact({ operationId: value.operationId, files: value.files as readonly PreSignedNamedDeployFile[], authorizeExactHashes: value.authorizeExactHashes });
    },
    async publishEventWithSimplePool(value) {
      if (!available() || !value.relays.length) return Object.freeze({ operationId: value.operationId, state: "failed" });
      return input.relay.publishOriginalEvent({ operationId: value.operationId, event: value.event, relays: Object.freeze([...value.relays]) });
    },
  });
  return Object.freeze({ contract: verified, port });
}
