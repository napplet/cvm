import { getEventHash, serializeEvent, verifyEvent } from "nostr-tools/pure";

import { SignedOwnerManifestEventSchema, type OwnerEventVerifierPort, type PublicationIntent, type SignedOwnerManifestEvent } from "./contracts.js";
import { canonicalOwnerManifestTemplate, isPublicationIntentExpired } from "./publication-intent.js";

export type OwnerManifestVerification = Readonly<{
  valid: boolean;
  eventId?: string;
  safeReasonCode?: "INVALID_OWNER_MANIFEST";
}>;

const invalid = (): OwnerManifestVerification => Object.freeze({ valid: false, safeReasonCode: "INVALID_OWNER_MANIFEST" });

/**
 * Verifies a completed public event against one persisted approval. All invalid inputs intentionally
 * collapse to a single public result, avoiding both parsing and ownership/signature oracles.
 */
export async function verifyOwnerManifestEvent(input: Readonly<{ event: unknown; intent: PublicationIntent; nowMs: number }>): Promise<OwnerManifestVerification> {
  try {
    const event = SignedOwnerManifestEventSchema.parse(input.event);
    const expected = canonicalOwnerManifestTemplate(input.intent);
    if (isPublicationIntentExpired(input.intent, input.nowMs)) return invalid();
    // Keep serialization explicit: NIP-01 bytes are authoritative, never project canonical JSON bytes.
    serializeEvent(event);
    if (getEventHash(event) !== event.id || !verifyEvent(event)) return invalid();
    if (event.pubkey !== expected.pubkey || event.kind !== expected.kind || event.created_at !== expected.created_at || event.content !== expected.content || !sameTags(event.tags, expected.tags)) return invalid();
    return Object.freeze({ valid: true, eventId: event.id });
  } catch {
    return invalid();
  }
}

function sameTags(left: readonly (readonly string[])[], right: readonly (readonly string[])[]): boolean {
  return left.length === right.length && left.every((tag, index) => tag.length === right[index]?.length && tag.every((value, tagIndex) => value === right[index]?.[tagIndex]));
}

/** Narrow adapter with verification-only imports; it accepts completed public events, never signing material. */
export class NostrToolsOwnerEventVerifier implements OwnerEventVerifierPort {
  constructor(private readonly dependencies: Readonly<{ nowMs: () => number }>) {}

  async verify(input: Readonly<{ event: SignedOwnerManifestEvent; intent: PublicationIntent }>): Promise<OwnerManifestVerification> {
    return verifyOwnerManifestEvent({ ...input, nowMs: this.dependencies.nowMs() });
  }
}
