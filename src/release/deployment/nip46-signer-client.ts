import { z } from "zod";

import {
  ExternalSignerBoundaryAdapter,
  type ExternalSignerPort,
} from "../native/external-signer";
import type { OwnerEventVerifierPort } from "../../publication/contracts";

const ReferenceSchema = z.string().regex(/^[a-z][a-z0-9:._/-]{2,255}$/iu);

/** NIP-46 composition retains a disposable *reference* only. The underlying
 * adapter remains the sole exact-intent verification boundary and never takes
 * a user secret key. */
export function createNip46DeploymentClient(input: Readonly<{
  disposableClientKeyReference: unknown;
  signer: ExternalSignerPort;
  ownerEventVerifier: OwnerEventVerifierPort;
}>) {
  const disposableClientKeyReference = ReferenceSchema.parse(input.disposableClientKeyReference);
  if (!disposableClientKeyReference.startsWith("nostr:") || /(?:nsec|private|secret|password)/iu.test(disposableClientKeyReference)) throw new Error("DEPLOYMENT_SECRET_REFERENCE_INVALID");
  if (!input.signer || !input.ownerEventVerifier) throw new Error("NIP46_DEPLOYMENT_PORT_REQUIRED");
  const adapter = new ExternalSignerBoundaryAdapter({ signer: input.signer, ownerEventVerifier: input.ownerEventVerifier });
  return Object.freeze({
    discovery: () => Object.freeze({ protocol: "nip-46" as const, disposableClientKeyReference, ownerKeyCustody: "external" as const }),
    inspect: adapter.inspectSignerBoundary.bind(adapter),
    signExactIntent: adapter.signExactIntent.bind(adapter),
  });
}
