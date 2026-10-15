import { hkdfSync } from "node:crypto";

export type DevelopmentServiceIdentity = Readonly<{
  signerPrivateKey: string;
  admissionSecret: Uint8Array;
  cursorSecret: Uint8Array;
}>;

/**
 * The payment stack already owns a private, restart-stable random seed. Derive
 * independent service purposes from it without another credential lifecycle.
 * This value is server-only; only the signer's public key belongs in bootstrap.
 */
export function developmentServiceIdentity(fundingKey: string): DevelopmentServiceIdentity {
  if (typeof fundingKey !== "string" || !/^[a-f0-9]{64}$/u.test(fundingKey)) throw new Error("DEV_SERVICE_IDENTITY_SEED_INVALID");
  const seed = Buffer.from(fundingKey, "hex");
  const derive = (purpose: string) => new Uint8Array(hkdfSync("sha256", seed, "napplet-cvm/development-service/v1", purpose, 32));
  try {
    const signerBytes = derive("nostr-signer");
    const signerPrivateKey = Buffer.from(signerBytes).toString("hex");
    signerBytes.fill(0);
    // Reject the negligible invalid-scalar case rather than silently changing
    // identity or weakening the Nostr signer's validation.
    const scalar = BigInt(`0x${signerPrivateKey}`);
    if (scalar === 0n || scalar >= 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n) throw new Error("DEV_SERVICE_IDENTITY_SCALAR_INVALID");
    return Object.freeze({ signerPrivateKey, admissionSecret: derive("admission-receipt"), cursorSecret: derive("session-status-cursor") });
  } finally { seed.fill(0); }
}
