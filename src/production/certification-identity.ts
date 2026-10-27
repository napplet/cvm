import { getPublicKey } from "nostr-tools/pure";
import type { MountedProductionSecretMaterial } from "./secret-material";

/** The disposable certification client's identity is separate from the
 * external publication owner. Derive it from the same fixed signer mount;
 * neither a config pubkey nor a user request may substitute another account. */
export async function loadProductionCertificationPubkey(secrets: MountedProductionSecretMaterial): Promise<string> {
  const encoded = await secrets.text("certification.clientKeyReference", 128);
  if (!/^[a-f0-9]{64}$/iu.test(encoded)) throw new Error("PRODUCTION_CERTIFICATION_KEY_INVALID");
  const key = new Uint8Array(Buffer.from(encoded, "hex"));
  try { return getPublicKey(key); }
  catch { throw new Error("PRODUCTION_CERTIFICATION_KEY_INVALID"); }
  finally { key.fill(0); }
}
