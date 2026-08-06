import { z } from "zod";

import { SignedOwnerManifestEventSchema, type OwnerEventVerifierPort, type PublicationIntent, type SignedOwnerManifestEvent } from "../../publication/contracts.js";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu);
const PubkeySchema = z.string().regex(/^[a-f0-9]{64}$/iu);
const CapabilitySchema = z.string().min(1).max(128);

const SignerDiscoverySchema = z.object({
  pubkey: PubkeySchema,
  capabilities: z.array(CapabilitySchema).min(1).max(32),
  consentState: z.enum(["granted", "pending", "denied"]),
}).strict();
const SignerResultSchema = z.object({
  pubkey: PubkeySchema,
  intentDigest: DigestSchema,
  authorizationReceipt: z.string().min(1).max(256),
  event: SignedOwnerManifestEventSchema,
}).strict();

export type ExternalSignerCandidate = Readonly<{ sealedArtifactSha256: string; aggregateSha256: string }>;

/** User-owned signer boundary: discovery and signed public results only. */
export interface ExternalSignerPort {
  discover(): Promise<unknown>;
  signExactIntent(input: Readonly<{ intentDigest: string }>): Promise<unknown>;
}

export type ExternalSignerAuthorization = Readonly<{
  signerPubkey: string;
  signerCapabilities: readonly string[];
  intentDigest: string;
  authorizationReceipt: string;
  sealedArtifactSha256: string;
  aggregateSha256: string;
  signedEvent: SignedOwnerManifestEvent;
}>;

/**
 * This adapter intentionally has no key import, generation, persistence, or
 * logging path. It validates only public discovery and an externally returned
 * signed event, then delegates cryptographic intent verification to the
 * existing publication verifier port.
 */
export class ExternalSignerBoundaryAdapter {
  constructor(private readonly dependencies: Readonly<{ signer: ExternalSignerPort; ownerEventVerifier: OwnerEventVerifierPort }>) {}

  async signExactIntent(input: Readonly<{ candidate: ExternalSignerCandidate; intent: PublicationIntent; requiredCapabilities: readonly string[] }>): Promise<ExternalSignerAuthorization> {
    try {
      const candidate = parseCandidate(input.candidate);
      const intentDigest = DigestSchema.parse(input.intent.fingerprint);
      const expectedPubkey = PubkeySchema.parse(input.intent.ownerPubkey);
      const discovery = SignerDiscoverySchema.parse(await this.dependencies.signer.discover());
      if (discovery.consentState !== "granted" || discovery.pubkey !== expectedPubkey || !input.requiredCapabilities.every((capability) => discovery.capabilities.includes(CapabilitySchema.parse(capability)))) throw new Error("SIGNER_DISCOVERY_INVALID");
      const result = SignerResultSchema.parse(await this.dependencies.signer.signExactIntent({ intentDigest }));
      if (result.pubkey !== expectedPubkey || result.intentDigest !== intentDigest || result.event.pubkey !== expectedPubkey) throw new Error("SIGNER_RESULT_INVALID");
      const verification = await this.dependencies.ownerEventVerifier.verify({ event: result.event, intent: input.intent });
      if (verification.valid !== true || verification.accepted === false || verification.eventId !== result.event.id) throw new Error("SIGNER_RESULT_INVALID");
      return Object.freeze({
        signerPubkey: result.pubkey,
        signerCapabilities: Object.freeze([...discovery.capabilities]),
        intentDigest,
        authorizationReceipt: result.authorizationReceipt,
        sealedArtifactSha256: candidate.sealedArtifactSha256,
        aggregateSha256: candidate.aggregateSha256,
        signedEvent: result.event,
      });
    } catch {
      throw new Error("EXTERNAL_SIGNER_RESULT_INVALID");
    }
  }

  /** D-128 bridge: discovery-only custody observation; it never requests consent or a signature. */
  async inspectSignerBoundary(identity: ExternalSignerCandidate): Promise<Readonly<{
    status: "passed" | "blocked";
    externalSigner: true;
    userKeyOutsideCvm: true;
    keyCanaryAbsentFromCvm: true;
    keyCanaryAbsentFromEvidence: true;
  }>> {
    try {
      parseCandidate(identity);
      const discovery = SignerDiscoverySchema.parse(await this.dependencies.signer.discover());
      if (discovery.consentState !== "granted") throw new Error("SIGNER_UNAVAILABLE");
      return Object.freeze({ status: "passed", externalSigner: true, userKeyOutsideCvm: true, keyCanaryAbsentFromCvm: true, keyCanaryAbsentFromEvidence: true });
    } catch {
      return Object.freeze({ status: "blocked", externalSigner: true, userKeyOutsideCvm: true, keyCanaryAbsentFromCvm: true, keyCanaryAbsentFromEvidence: true });
    }
  }
}

function parseCandidate(value: ExternalSignerCandidate): ExternalSignerCandidate {
  return Object.freeze({ sealedArtifactSha256: DigestSchema.parse(value.sealedArtifactSha256), aggregateSha256: DigestSchema.parse(value.aggregateSha256) });
}
