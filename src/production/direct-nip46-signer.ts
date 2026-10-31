import { z } from "zod";
import { directPublicationDigest } from "../publication/direct-publication";
import { ProductionDirectPublicationIntents } from "./direct-publication-intents";
import { openProductionNip46Signer } from "./nip46-signer";

const Owner = z.object({ principal: z.object({ pubkey: z.string().regex(/^[a-f0-9]{64}$/u) }).strict(), idempotencyKey: z.string().min(1).max(256) }).strict();

/** Receipt-gated certification composition over real owned direct records.
 * Ordinary user signing must use its own approved actor, not a release receipt.
 * No caller event/template/key or alternative context resolver is accepted. */
export async function openProductionDirectCertificationNip46Signer(input: Readonly<{
  intents: ProductionDirectPublicationIntents; owner: z.input<typeof Owner>;
  bunkerUri: string; sessionKeyReference: string;
  sessionKeyBroker: Parameters<typeof openProductionNip46Signer>[0]["sessionKeyBroker"];
  journal: Parameters<typeof openProductionNip46Signer>[0]["journal"];
  authorization: Parameters<typeof openProductionNip46Signer>[0]["authorization"];
  timeoutMs?: number; now?: () => number;
}>) {
  if (!(input.intents instanceof ProductionDirectPublicationIntents)) throw new Error("DIRECT_PUBLICATION_INTENT_SERVICE_REQUIRED");
  const owner = Owner.parse(input.owner);
  const original = async () => {
    const intent = await input.intents.readOriginal(owner);
    if (!intent) throw new Error("DIRECT_PUBLICATION_INTENT_NOT_FOUND_OR_DENIED");
    return intent;
  };
  const ownerContext = async () => {
    const intent = await original();
    return { operationId: `direct-owner:${await directPublicationDigest(intent.intentId)}`, intentDigest: await directPublicationDigest(intent), ownerPubkey: intent.review.ownerPubkey,
      capabilities: ["sign_event"], template: intent.review.ownerManifestTemplate, expiresAtMs: intent.expiresAtMs };
  };
  const uploadContext = async () => {
    const authorization = await input.intents.readUploadAuthorization(owner);
    if (!authorization) throw new Error("DIRECT_UPLOAD_AUTHORIZATION_NOT_FOUND_OR_DENIED");
    return { operationId: authorization.operationId, intentDigest: authorization.authorizationSha256, ownerPubkey: authorization.ownerPubkey,
      capabilities: ["sign_event"], template: authorization.template, expiresAtMs: authorization.expiresAtMs };
  };
  const signer = await openProductionNip46Signer({ bunkerUri: input.bunkerUri, sessionKeyReference: input.sessionKeyReference,
    sessionKeyBroker: input.sessionKeyBroker, journal: input.journal, authorization: input.authorization, timeoutMs: input.timeoutMs, now: input.now,
    context: { async resolve({ intentDigest }) { const context = await ownerContext(); if (context.intentDigest !== intentDigest) throw new Error("DIRECT_NIP46_ORIGINAL_CONTEXT_REQUIRED"); return context; } },
    originalOperationContext: { async resolveOriginal({ operationId, purpose }) { const context = await uploadContext(); if (purpose !== "upload_authorization" || context.operationId !== operationId) throw new Error("DIRECT_NIP46_ORIGINAL_CONTEXT_REQUIRED"); return context; } },
    async authorizeFreshSigning({ operationId, intentDigest }) {
      const context = await ownerContext();
      if (context.operationId === operationId && context.intentDigest === intentDigest) { await input.intents.loadCurrentForSigning(owner); return; }
      const upload = await uploadContext();
      if (upload.operationId !== operationId || upload.intentDigest !== intentDigest) throw new Error("DIRECT_NIP46_ORIGINAL_CONTEXT_REQUIRED");
      await input.intents.loadUploadAuthorizationForSigning(owner);
    },
  });
  return Object.freeze({ close: signer.close, discover: signer.discover,
    async signOwnerManifest() { return signer.signExactIntent({ intentDigest: (await ownerContext()).intentDigest }); },
    async signUploadAuthorization() { return signer.signExactOperation({ operationId: (await uploadContext()).operationId, purpose: "upload_authorization" }); },
    async observeOwnerSignature() { return signer.observeExactIntent({ intentDigest: (await ownerContext()).intentDigest }); },
    async observeUploadSignature() { return signer.observeExactOperation({ operationId: (await uploadContext()).operationId, purpose: "upload_authorization" }); },
  });
}
