import { z } from "zod";

/** The complete owner-safe action vocabulary; hosts must not invent recovery commands. */
export const HostActionSchema = z.enum(["preview", "review_capabilities", "sign_manifest", "publish", "reconcile_publication"]);
export type HostAction = z.infer<typeof HostActionSchema>;

const IdentifierSchema = z.string().min(1).max(512);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/iu);
const IdentitySchema = z.object({
  artifactId: IdentifierSchema,
  aggregateSha256: Sha256Schema,
  normalizedDTag: z.string().min(1).max(128),
  capabilityDigest: Sha256Schema.optional(),
  intentId: IdentifierSchema.optional(),
  ownerEventId: Sha256Schema.optional(),
  attestationId: IdentifierSchema.optional(),
}).strict();
const CapabilityInputSchema = z.object({
  capability: IdentifierSchema,
  requirement: z.enum(["required", "optional"]),
  purpose: z.string().min(1).max(512),
  consent: z.enum(["required", "optional"]),
  available: z.boolean(),
  evidenceLabel: z.string().min(1).max(128),
  gracefulDegradation: z.string().min(1).max(512).optional(),
}).strict();
const EffectInputSchema = z.object({
  label: z.string().min(1).max(128),
  state: z.enum(["confirmed", "not_yet_confirmed", "reconciliation_pending"]),
  identifier: IdentifierSchema.optional(),
}).strict();
const HostPublicationInputSchema = z.object({
  state: z.enum(["pre_preview", "loading", "preview_ready", "preview_incompatible", "absent_manifest", "review_ready", "intent_ready", "signing", "publication_reconciliation_pending", "partial", "complete", "error"]),
  identity: IdentitySchema,
  capabilities: z.array(CapabilityInputSchema).max(64),
  effects: z.array(EffectInputSchema).max(16).optional(),
  nextAction: HostActionSchema.optional(),
  safeError: z.enum(["preview_unavailable", "review_changed", "signature_invalid", "publication_unavailable"]).optional(),
  duplicateActionPending: z.boolean().optional(),
  changedFacts: z.boolean().optional(),
  exactReplay: z.boolean().optional(),
}).strict();

export const HostPublicationSurfaceSchema = z.object({
  flowStep: z.enum(["artifact", "preview", "review", "signing", "publication"]),
  state: HostPublicationInputSchema.shape.state,
  identity: IdentitySchema,
  primaryAction: HostActionSchema.optional(),
  secondaryActions: z.array(HostActionSchema),
  duplicateActionDisabled: z.boolean(),
  acknowledgementRequired: z.boolean(),
  progressLabel: z.string().min(1),
  safeError: z.string().min(1).optional(),
  capabilityRows: z.array(z.object({
    capability: IdentifierSchema,
    requirement: z.enum(["required", "optional"]),
    purpose: z.string().min(1).max(512),
    consent: z.enum(["required", "optional"]),
    availability: z.enum(["available", "required_unavailable", "optional_unavailable"]),
    evidenceLabel: z.string().min(1).max(128),
    gracefulDegradation: z.string().min(1).max(512).optional(),
  }).strict()),
  effectRows: z.array(EffectInputSchema),
  inspectorScrollOwner: z.literal("host"),
  mobileLayout: z.literal("stacked"),
  nestedHorizontalPanes: z.literal(false),
  identifierDisplay: z.literal("middle_ellipsis"),
  identifierCopyLabel: z.literal("Copy full identifier"),
  identifierAccessibleValue: IdentifierSchema,
  descriptionWrap: z.literal(true),
}).strict();
export type HostPublicationSurface = Readonly<z.infer<typeof HostPublicationSurfaceSchema>>;

const safeErrors = {
  preview_unavailable: "Preview unavailable. Verify the artifact and try preview again.",
  review_changed: "Review changed. Review the exact current details before signing.",
  signature_invalid: "The signature is no longer valid for this publication. Review and sign again.",
  publication_unavailable: "Publication is currently unavailable. Continue previewing the verified artifact.",
} as const;

const flowStepFor = (state: z.infer<typeof HostPublicationInputSchema>["state"]): HostPublicationSurface["flowStep"] => {
  if (state === "pre_preview" || state === "loading") return "artifact";
  if (state === "preview_ready" || state === "preview_incompatible") return "preview";
  if (state === "absent_manifest" || state === "review_ready") return "review";
  if (state === "intent_ready" || state === "signing") return "signing";
  return "publication";
};

function progressLabel(input: z.infer<typeof HostPublicationInputSchema>, missingRequired: boolean, emptyCapabilities: boolean): string {
  if (input.changedFacts) return "Review changed — publication approval was cleared.";
  if (input.state === "loading") return "Checking verified artifact…";
  if (input.state === "pre_preview") return "Preview the verified artifact before publication.";
  if (input.state === "absent_manifest" || emptyCapabilities) return "No manifest capabilities were returned.";
  if (missingRequired || input.state === "preview_incompatible") return "A required capability is unavailable in this runtime.";
  if (input.state === "preview_ready") return "Preview ready.";
  if (input.state === "review_ready") return "Review the exact capability set before publication.";
  if (input.state === "intent_ready") return "Sign the exact publication manifest.";
  if (input.state === "signing") return "Waiting for the owner-signed manifest.";
  if (input.state === "publication_reconciliation_pending") return "Publication effects are being reconciled.";
  if (input.state === "partial") return "Publication is partially observed. Reconcile the original operation.";
  if (input.state === "complete") return "Napplet published.";
  return "A safe recovery action is available.";
}

function primaryAction(input: z.infer<typeof HostPublicationInputSchema>, missingRequired: boolean, emptyCapabilities: boolean): HostAction | undefined {
  if (input.changedFacts || missingRequired || (emptyCapabilities && input.state !== "pre_preview" && input.state !== "loading") || input.state === "absent_manifest" || input.state === "preview_incompatible") return input.state === "preview_incompatible" ? "preview" : "review_capabilities";
  if (input.state === "pre_preview" || input.state === "loading" || input.state === "error") return input.nextAction ?? "preview";
  if (input.state === "preview_ready") return "review_capabilities";
  if (input.state === "review_ready") return "publish";
  if (input.state === "intent_ready") return "sign_manifest";
  if (input.state === "signing") return "publish";
  if (input.state === "publication_reconciliation_pending" || input.state === "partial") return "reconcile_publication";
  return undefined;
}

/**
 * A pure presentation projection. It deliberately has no DOM, route, signer,
 * transport, storage, or runtime-message authority; compatible hosts render
 * these strict facts around the already verified artifact only.
 */
export function projectHostPublicationSurface(input: unknown): HostPublicationSurface {
  const parsed = HostPublicationInputSchema.parse(input);
  const capabilityRows = [...parsed.capabilities]
    .sort((left, right) => Number(left.requirement === "optional") - Number(right.requirement === "optional") || left.capability.localeCompare(right.capability))
    .map((capability) => ({
      capability: capability.capability,
      requirement: capability.requirement,
      purpose: capability.purpose,
      consent: capability.consent,
      availability: capability.available ? "available" as const : capability.requirement === "required" ? "required_unavailable" as const : "optional_unavailable" as const,
      evidenceLabel: capability.evidenceLabel,
      ...(capability.requirement === "optional" && !capability.available && capability.gracefulDegradation ? { gracefulDegradation: capability.gracefulDegradation } : {}),
    }));
  const missingRequired = capabilityRows.some((row) => row.availability === "required_unavailable");
  const emptyCapabilities = capabilityRows.length === 0;
  const action = primaryAction(parsed, missingRequired, emptyCapabilities);
  const secondaryActions = action === "preview" ? ["review_capabilities"] as HostAction[] : action === "review_capabilities" ? ["preview"] as HostAction[] : action === "sign_manifest" ? ["review_capabilities"] as HostAction[] : action === "publish" ? ["review_capabilities", "sign_manifest"] as HostAction[] : action === "reconcile_publication" ? ["preview"] as HostAction[] : [];
  return Object.freeze(HostPublicationSurfaceSchema.parse({
    flowStep: flowStepFor(parsed.state),
    state: parsed.state,
    identity: parsed.identity,
    ...(action ? { primaryAction: action } : {}),
    secondaryActions,
    duplicateActionDisabled: Boolean(parsed.duplicateActionPending || parsed.state === "loading" || parsed.state === "signing"),
    acknowledgementRequired: Boolean(parsed.changedFacts),
    progressLabel: progressLabel(parsed, missingRequired, emptyCapabilities),
    ...(parsed.safeError ? { safeError: safeErrors[parsed.safeError] } : {}),
    capabilityRows,
    effectRows: parsed.effects ?? [],
    inspectorScrollOwner: "host",
    mobileLayout: "stacked",
    nestedHorizontalPanes: false,
    identifierDisplay: "middle_ellipsis",
    identifierCopyLabel: "Copy full identifier",
    identifierAccessibleValue: parsed.identity.aggregateSha256,
    descriptionWrap: true,
  }));
}
