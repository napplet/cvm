import { z } from "zod";
import { PrivateKeySigner } from "@contextvm/sdk/signer/private-key-signer";

import type { ContextVmCertificationSignerBroker } from "../release/deployment/contextvm-client";
import type { Nip46SessionKeyBroker } from "./nip46-signer";
import type { ProductionConfig } from "./config";
import type { MountedProductionSecretMaterial } from "./secret-material";

const Hex = z.string().regex(/^[a-f0-9]{64}$/iu).transform(value => value.toLowerCase());
const Bunker = z.string().min(16).max(2_048).refine(value => value.startsWith("bunker:"), "PRODUCTION_NIP46_BUNKER_REFERENCE_REQUIRED");

function privateKey(value: string, code: string): Uint8Array {
  const key = new Uint8Array(Buffer.from(Hex.parse(value), "hex"));
  if (key.byteLength !== 32) throw new Error(code);
  return key;
}
/** Mounted keys are transformed immediately into narrow signer brokers. The
 * aggregate gets protocol capabilities, never a secret path/value or a
 * user-selected resolver. */
export async function createMountedProductionEdgeMaterial(input: Readonly<{
  config: ProductionConfig;
  secrets: MountedProductionSecretMaterial;
}>): Promise<Readonly<{
  certificationSignerBroker: ContextVmCertificationSignerBroker;
  nip46SessionKeyBroker: Nip46SessionKeyBroker;
  bunkerUri: string;
  promotedCliSnapshot: unknown;
}>> {
  const [certificationKeyText, sessionKeyText, bunkerText, cliText] = await Promise.all([
    input.secrets.text("certification.clientKeyReference", 256),
    input.secrets.text("publication.signerSessionKeyReference", 256),
    input.secrets.text("publication.signerBrokerReference", 2_048),
    input.secrets.text("publication.cliSourceReference", 65_536),
  ]);
  const certificationKey = Hex.parse(certificationKeyText);
  const sessionKey = privateKey(sessionKeyText, "PRODUCTION_NIP46_SESSION_KEY_INVALID");
  const bunkerUri = Bunker.parse(bunkerText);
  let promotedCliSnapshot: unknown;
  try { promotedCliSnapshot = JSON.parse(cliText); } catch { throw new Error("PRODUCTION_PROMOTED_CLI_MOUNT_INVALID"); }
  return Object.freeze({
    certificationSignerBroker: Object.freeze({
      async resolveContextVmCertificationSigner(request: Parameters<ContextVmCertificationSignerBroker["resolveContextVmCertificationSigner"]>[0]) {
        if (request.reference !== input.config.certification.clientKeyReference || request.purpose !== "contextvm_certification_client") throw new Error("PRODUCTION_CERTIFICATION_SIGNER_REFERENCE_DENIED");
        return new PrivateKeySigner(certificationKey);
      },
    }),
    nip46SessionKeyBroker: Object.freeze({
      async resolve(request: Parameters<Nip46SessionKeyBroker["resolve"]>[0]) {
        if (request.reference !== input.config.publication.signerSessionKeyReference || request.purpose !== "nip46_disposable_client") throw new Error("PRODUCTION_NIP46_SESSION_KEY_REFERENCE_DENIED");
        return new Uint8Array(sessionKey);
      },
    }),
    bunkerUri,
    promotedCliSnapshot,
  });
}
