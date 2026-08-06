import { z } from "zod";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu).transform((value) => value.toLowerCase());
const OperationSchema = z.string().regex(/^[a-z][a-z0-9_-]{2,127}$/u);
const ReferenceSchema = z.string().regex(/^nostr:[a-z][a-z0-9:._/-]{2,255}$/iu);

function roleClient(role: "owner" | "attestation", keyReference: string, relaySetReference: string, relaySetSha256: string) {
  return Object.freeze({
    discovery: () => Object.freeze({ role, keyReference, relaySetReference, relaySetSha256 }),
    async reconcileOriginal(input: Readonly<{ originalOperationId: unknown; observedOperationId: unknown; eventSha256: unknown }>) {
      const operationId = OperationSchema.parse(input.originalOperationId);
      try {
        if (OperationSchema.parse(input.observedOperationId) !== operationId) throw new Error("operation mismatch");
        DigestSchema.parse(input.eventSha256);
        return Object.freeze({ status: "reconciled" as const, operationId });
      } catch {
        return Object.freeze({ status: "blocked" as const, operationId });
      }
    },
  });
}

/** Owner events are externally pre-signed; attestation events use a separate
 * service reference. This descriptor forbids role crossover before any relay
 * port can be attached in protected execution. */
export function createRelayDeploymentClients(input: Readonly<{
  ownerKeyReference: unknown;
  attestationKeyReference: unknown;
  relaySetReference: unknown;
  relaySetSha256: unknown;
}>) {
  const ownerKeyReference = ReferenceSchema.parse(input.ownerKeyReference);
  const attestationKeyReference = ReferenceSchema.parse(input.attestationKeyReference);
  const relaySetReference = z.string().regex(/^relay-set:[a-z][a-z0-9:._/-]{2,255}$/iu).parse(input.relaySetReference);
  const relaySetSha256 = DigestSchema.parse(input.relaySetSha256);
  if (ownerKeyReference === attestationKeyReference || /(?:nsec|private|secret)/iu.test(ownerKeyReference) || /(?:nsec|private|secret)/iu.test(attestationKeyReference)) throw new Error("DEPLOYMENT_RELAY_KEY_ROLE_INVALID");
  return Object.freeze({
    owner: roleClient("owner", ownerKeyReference, relaySetReference, relaySetSha256),
    attestation: roleClient("attestation", attestationKeyReference, relaySetReference, relaySetSha256),
  });
}
