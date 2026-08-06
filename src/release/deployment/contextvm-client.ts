import { computeCanonicalInvocationIdentity } from "@contextvm/sdk/payments/canonical-identity";
import { z } from "zod";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu).transform((value) => value.toLowerCase());
const PubkeySchema = z.string().regex(/^[a-f0-9]{64}$/iu).transform((value) => value.toLowerCase());
const ReferenceSchema = z.string().regex(/^[a-z][a-z0-9:./_-]{2,255}$/iu);

function reference(value: unknown): string {
  const parsed = ReferenceSchema.parse(value);
  if (/(?:nsec|private|secret|password|ya29\.)/iu.test(parsed)) throw new Error("DEPLOYMENT_SECRET_REFERENCE_INVALID");
  return parsed;
}

/**
 * Deployment-owned ContextVM descriptor.  It calls the installed official
 * SDK's canonical identity primitive, but contains only a named service-key
 * reference; transport construction and relay I/O remain 07-26 work.
 */
export function createContextVmDeploymentClient(input: Readonly<{
  serviceKeyReference: unknown;
  relaySetReference: unknown;
  relaySetSha256: unknown;
}>) {
  const serviceKeyReference = reference(input.serviceKeyReference);
  const relaySetReference = reference(input.relaySetReference);
  const relaySetSha256 = DigestSchema.parse(input.relaySetSha256);
  return Object.freeze({
    discovery: () => Object.freeze({ sdkPackage: "@contextvm/sdk@0.13.10", serviceKeyReference, relaySetReference, relaySetSha256 }),
    correlate(value: Readonly<{ clientPubkey: unknown; method: unknown; params: unknown }>) {
      const clientPubkey = PubkeySchema.parse(value.clientPubkey);
      const method = z.string().min(1).max(256).parse(value.method);
      const identity = computeCanonicalInvocationIdentity(clientPubkey, method, value.params);
      return Object.freeze({
        serviceKeyReference,
        relaySetReference,
        relaySetSha256,
        clientPubkey,
        invocationSha256: DigestSchema.parse(identity.invocationHash),
      });
    },
  });
}
