import { z } from "zod";

import { HostPresentationSourceFactsSchema, HostPresentationSourceStateSchema } from "./contracts";

/** Machine actions remain finite; visible host copy is supplied separately. */
export const HostActionSchema = z.enum([
  "admit", "preview", "review_capabilities", "sign_manifest", "publish", "reconcile_publication",
  "select_compatible_runtime", "return_to_artifact", "review_manifest", "view_publication_details",
  "copy_publication_details", "view_publication_status", "view_release_evidence", "cancel_signing", "return_to_review",
]);
export type HostAction = z.infer<typeof HostActionSchema>;

export const HostPresentationVersionSchema = z.literal("1");
export const HostStateSchema = HostPresentationSourceStateSchema;
export type HostState = z.infer<typeof HostStateSchema>;

const IdentifierValueSchema = z.string().min(1).max(512);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/iu);
const LegacyStateSchema = z.enum([
  "pre_preview", "loading", "preview_ready", "preview_incompatible", "absent_manifest", "review_ready",
  "intent_ready", "signing", "publication_reconciliation_pending", "partial", "complete", "error",
]);

const HostIdentitySchema = z.object({
  artifactId: IdentifierValueSchema,
  aggregateSha256: Sha256Schema,
  normalizedDTag: z.string().min(1).max(128),
  capabilityDigest: Sha256Schema.optional(),
  admissionReference: IdentifierValueSchema.optional(),
  intentId: IdentifierValueSchema.optional(),
  operationId: IdentifierValueSchema.optional(),
  ownerEventId: Sha256Schema.optional(),
  attestationId: IdentifierValueSchema.optional(),
  deploymentId: IdentifierValueSchema.optional(),
  evidenceReference: IdentifierValueSchema.optional(),
}).strict();

const CapabilityInputSchema = z.object({
  capability: IdentifierValueSchema,
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
  identifier: IdentifierValueSchema.optional(),
}).strict();

/**
 * Strict owner-safe input. Legacy states are accepted only to preserve Phase 6
 * durable workflow compatibility; their projection is always a v1 finite state.
 */
export const HostPublicationInputSchema = z.object({
  state: z.union([HostStateSchema, LegacyStateSchema]),
  identity: HostIdentitySchema,
  capabilities: z.array(CapabilityInputSchema).max(64),
  effects: z.array(EffectInputSchema).max(16).optional(),
  nextAction: HostActionSchema.optional(),
  safeError: z.enum(["preview_unavailable", "review_changed", "signature_invalid", "publication_unavailable"]).optional(),
  duplicateActionPending: z.boolean().optional(),
  changedFacts: z.boolean().optional(),
  exactReplay: z.boolean().optional(),
  retryHint: z.enum(["a short while", "the displayed retry window"]).optional(),
  signerKind: z.enum(["host", "external"]).optional(),
}).strict();
export type HostPublicationInput = Readonly<z.infer<typeof HostPublicationInputSchema>>;

export const HostIdentifierKindSchema = z.enum([
  "aggregate_hash", "normalized_d_tag", "capability_digest", "admission_reference", "publication_intent",
  "publication_operation", "owner_manifest_event", "cvm_attestation", "deployment", "evidence_reference",
]);
export const HostIdentifierSchema = z.object({
  kind: HostIdentifierKindSchema,
  visibleLabel: z.string().min(1).max(128),
  displayValue: IdentifierValueSchema,
  fullValue: IdentifierValueSchema,
  accessibleName: z.string().min(1).max(640),
  copyLabel: z.string().min(1).max(128),
  minimumTargetPx: z.literal(44),
}).strict();
export type HostIdentifier = Readonly<z.infer<typeof HostIdentifierSchema>>;

const ActionPresentationSchema = z.object({
  machineAction: HostActionSchema,
  visibleLabel: z.string().min(1).max(128),
  accessibleName: z.string().min(1).max(160),
  enabled: z.boolean(),
  disabledReason: z.string().min(1).max(256).optional(),
  duplicateGuard: z.enum(["none", "no_second_admission", "next_stage_fenced", "local_handoff_only", "original_operation_only", "no_duplicate_effect"]),
  isNextAction: z.boolean(),
  queryOnly: z.boolean(),
  minimumTargetPx: z.literal(44),
}).strict();
const LayoutSchema = z.object({
  spacingPx: z.object({ xs: z.literal(4), sm: z.literal(8), md: z.literal(16), lg: z.literal(24), xl: z.literal(32), "2xl": z.literal(48), "3xl": z.literal(64) }).strict(),
  typography: z.object({ body: z.literal("16px/400/1.5"), label: z.literal("14px/600/1.5"), heading: z.literal("20px/600/1.2"), display: z.literal("28px/600/1.2"), tabularNumerals: z.literal(true) }).strict(),
  semanticTokens: z.object({ dominant: z.literal("var(--host-surface)"), secondary: z.literal("var(--host-surface-raised)"), accent: z.literal("var(--host-accent)"), destructive: z.literal("var(--host-danger)"), allocation: z.literal("60/30/10"), contrast: z.literal("wcag_2_2_aa") }).strict(),
  desktopGrid: z.literal("60-66/34-40"),
  desktopGapPx: z.literal(32),
  previewAspectRatio: z.literal("16:10"),
  tabletInspector: z.literal("expanded_sections"),
  mobileInspector: z.literal("single_current_section"),
  mobileNextAction: z.literal("full_width"),
  minimumTargetPx: z.literal(44),
  outerScrollOwner: z.literal("host"),
  iframeScrollOwner: z.literal("iframe"),
  nestedHorizontalPanes: z.literal(false),
  descriptionWrap: z.literal(true),
  identifierDisplay: z.literal("middle_ellipsis"),
}).strict();
const SemanticStatusSchema = z.object({
  kind: z.enum(["verified", "busy", "warning", "blocked", "error", "partial", "complete", "neutral"]),
  token: z.enum(["dominant", "secondary", "accent", "destructive"]),
  textPlusShape: z.literal(true),
  colorIndependent: z.literal(true),
}).strict();
const DialogSchema = z.object({
  kind: z.enum(["none", "publish_approval", "cancel_review", "incompatibility_detail", "expiry_detail", "reconciliation_detail"]),
  role: z.literal("dialog"),
  heading: z.string().min(1).max(512).optional(),
  body: z.string().min(1).max(1024).optional(),
  primaryActionLabel: z.string().min(1).max(128).optional(),
  secondaryActionLabel: z.string().min(1).max(128).optional(),
  closeRule: z.enum(["not_applicable", "close_has_no_effect", "cannot_cancel_persisted_operation"]),
  cannotCancelPersistedOperation: z.boolean(),
  initialFocus: z.enum(["least_destructive", "not_applicable"]),
  focusTrap: z.boolean(),
  focusRestore: z.boolean(),
}).strict();
const LiveAnnouncementSchema = z.object({ mode: z.enum(["none", "polite_once", "alert"]), copy: z.string().min(1).max(1024), debounced: z.literal(true) }).strict();
const AccessibilitySchema = z.object({
  mainLandmark: z.literal("labelled"), progressNav: z.literal("labelled"), iframeTitle: z.literal("Sealed preview of verified napplet"),
  currentStepAria: z.literal("aria-current=step"), disabledStepReason: z.literal("required"), focusRingPx: z.literal(2), focusRingContrast: z.literal("3:1"),
  focusOrder: z.tuple([z.literal("header"), z.literal("progress"), z.literal("preview_controls"), z.literal("inspector_facts"), z.literal("current_action")]),
  dialogFocusTrap: z.literal(true), dialogFocusRestore: z.literal(true), busyLabels: z.literal(true), colorIndependentStatus: z.literal(true), iconOnlyControls: z.literal("prohibited"),
}).strict();
const UiConsiderationsSchema = z.object({
  empty: z.literal("exact_copy_blocks_publication"), loading: z.literal("distinct_redacted_copy_no_duplicate_progression"), error: z.literal("safe_copy_explicit_or_query_only_action"),
  populated: z.literal("verified_allowlisted_facts_only"), partial: z.literal("original_operation_reconciliation_only"), overflow: z.literal("host_outer_iframe_inner_no_horizontal_panes"),
  zero_one_many: z.literal("zero_blocks_one_full_many_required_first"), long_text: z.literal("wrap_or_middle_ellipsis_with_labelled_copy"),
}).strict();
export const HostPresentationSchema = z.object({
  presentationVersion: HostPresentationVersionSchema,
  state: HostStateSchema,
  flowStep: z.enum(["artifact", "preview", "review", "publish", "sign", "status", "publication"]),
  heading: z.string().min(1).max(512),
  body: z.string().min(1).max(1024).optional(),
  actions: z.array(ActionPresentationSchema).max(3),
  layout: LayoutSchema,
  semanticStatus: SemanticStatusSchema,
  dialog: DialogSchema,
  liveAnnouncement: LiveAnnouncementSchema,
  identifiers: z.array(HostIdentifierSchema).max(10),
  motion: z.object({ reduced: z.literal("instant_or_100ms_fade"), standard: z.literal("150ms_opacity_transform"), externalEffectProgressAnimation: z.literal(false) }).strict(),
  accessibility: AccessibilitySchema,
  uiConsiderations: UiConsiderationsSchema,
  identity: HostIdentitySchema,
  capabilityRows: z.array(z.object({ capability: IdentifierValueSchema, requirement: z.enum(["required", "optional"]), purpose: z.string().min(1).max(512), consent: z.enum(["required", "optional"]), availability: z.enum(["available", "required_unavailable", "optional_unavailable"]), evidenceLabel: z.string().min(1).max(128), gracefulDegradation: z.string().min(1).max(512).optional() }).strict()),
  effectRows: z.array(EffectInputSchema),
  // Phase 6 compatibility aliases; v1 hosts must render the structured fields above.
  primaryAction: HostActionSchema.optional(), secondaryActions: z.array(HostActionSchema), duplicateActionDisabled: z.boolean(), acknowledgementRequired: z.boolean(), progressLabel: z.string().min(1), safeError: z.string().min(1).optional(), inspectorScrollOwner: z.literal("host"), mobileLayout: z.literal("stacked"), nestedHorizontalPanes: z.literal(false), identifierDisplay: z.literal("middle_ellipsis"), identifierCopyLabel: z.literal("Copy full identifier"), identifierAccessibleValue: IdentifierValueSchema, descriptionWrap: z.literal(true),
}).strict().superRefine((value, context) => {
  const enabledNext = value.actions.filter((action) => action.enabled && action.isNextAction);
  if (enabledNext.length > 1) context.addIssue({ code: "custom", message: "ONE_NEXT_ACTION_REQUIRED", path: ["actions"] });
  if (value.actions.some((action) => action.isNextAction && !action.enabled)) context.addIssue({ code: "custom", message: "NEXT_ACTION_MUST_BE_ENABLED", path: ["actions"] });
});
export type HostPublicationSurface = Readonly<z.infer<typeof HostPresentationSchema>>;
export const HostPublicationSurfaceSchema = HostPresentationSchema;

const stateAlias: Record<z.infer<typeof LegacyStateSchema>, HostState> = {
  pre_preview: "verified_artifact_no_preview", loading: "descriptor_loading", preview_ready: "preview_ready", preview_incompatible: "preview_incompatible",
  absent_manifest: "capability_empty", review_ready: "intent_ready", intent_ready: "intent_ready", signing: "signer_active",
  publication_reconciliation_pending: "reconciliation_pending", partial: "partial", complete: "complete", error: "preview_denied",
};
const middleEllipsis = (value: string): string => value.length <= 10 ? value : `${value.slice(0, 4)}…${value.slice(-4)}`;
const noDialog = (cannotCancelPersistedOperation = false): z.infer<typeof DialogSchema> => ({ kind: "none", role: "dialog", closeRule: cannotCancelPersistedOperation ? "cannot_cancel_persisted_operation" : "not_applicable", cannotCancelPersistedOperation, initialFocus: "not_applicable", focusTrap: true, focusRestore: true });
const action = (machineAction: HostAction, visibleLabel: string, options: Partial<z.infer<typeof ActionPresentationSchema>> = {}): z.infer<typeof ActionPresentationSchema> => ({ machineAction, visibleLabel, accessibleName: visibleLabel, enabled: true, duplicateGuard: "none", isNextAction: true, queryOnly: false, minimumTargetPx: 44, ...options });

type StatePresentation = Readonly<{ flowStep: z.infer<typeof HostPresentationSchema>["flowStep"]; heading: string; body?: string; action?: z.infer<typeof ActionPresentationSchema>; dialog?: z.infer<typeof DialogSchema>; semantic: z.infer<typeof SemanticStatusSchema>["kind"]; announcement: z.infer<typeof LiveAnnouncementSchema>["mode"]; cannotCancelPersistedOperation?: boolean }>;
export const STATE_PRESENTATIONS: Readonly<Record<HostState, StatePresentation>> = Object.freeze({
  admission_preparing: { flowStep: "artifact", heading: "Starting isolated workspace…", semantic: "busy", announcement: "none" },
  capacity_unavailable: { flowStep: "artifact", heading: "Capacity is temporarily unavailable.", body: "No session was started and no funds were reserved. Try again after {retryHint}.", action: action("admit", "Try admission again", { duplicateGuard: "no_second_admission", isNextAction: true }), semantic: "warning", announcement: "alert" },
  descriptor_loading: { flowStep: "artifact", heading: "Checking verified artifact…", semantic: "busy", announcement: "none" },
  verified_artifact_no_preview: { flowStep: "preview", heading: "Preview not started", body: "Open the exact verified artifact before preparing publication.", action: action("preview", "Preview verified napplet", { duplicateGuard: "next_stage_fenced" }), semantic: "verified", announcement: "none" },
  preview_loading: { flowStep: "preview", heading: "Opening sealed preview…", semantic: "busy", announcement: "none" },
  preview_ready: { flowStep: "review", heading: "Preview ready", action: action("review_capabilities", "Review capabilities", { duplicateGuard: "next_stage_fenced" }), semantic: "verified", announcement: "polite_once" },
  preview_incompatible: { flowStep: "preview", heading: "This runtime cannot run the verified napplet.", body: "Choose a compatible runtime to preview and publish this artifact.", action: action("select_compatible_runtime", "Choose a compatible runtime", { duplicateGuard: "next_stage_fenced" }), dialog: { kind: "incompatibility_detail", role: "dialog", heading: "This runtime cannot run the verified napplet.", body: "Choose a compatible runtime to preview and publish this artifact.", closeRule: "close_has_no_effect", cannotCancelPersistedOperation: false, initialFocus: "least_destructive", focusTrap: true, focusRestore: true }, semantic: "blocked", announcement: "alert" },
  preview_expired: { flowStep: "preview", heading: "Preview access expired.", body: "Request a new preview for this same verified artifact. No publication was started.", action: action("preview", "Preview verified napplet", { duplicateGuard: "next_stage_fenced" }), dialog: { kind: "expiry_detail", role: "dialog", heading: "Preview access expired.", body: "Request a new preview for this same verified artifact. No publication was started.", closeRule: "close_has_no_effect", cannotCancelPersistedOperation: false, initialFocus: "least_destructive", focusTrap: true, focusRestore: true }, semantic: "warning", announcement: "none" },
  preview_denied: { flowStep: "preview", heading: "Preview is unavailable for this artifact.", body: "Return to the verified artifact and review its status.", action: action("return_to_artifact", "View artifact status", { queryOnly: true, duplicateGuard: "next_stage_fenced" }), semantic: "error", announcement: "alert" },
  capability_loading: { flowStep: "review", heading: "Checking runtime compatibility…", semantic: "busy", announcement: "none" },
  capability_empty: { flowStep: "review", heading: "No manifest capabilities were returned.", body: "Publication cannot continue until the verified manifest is available.", action: action("return_to_artifact", "View artifact status", { queryOnly: true, duplicateGuard: "next_stage_fenced" }), semantic: "blocked", announcement: "alert" },
  required_capability_missing: { flowStep: "review", heading: "Required — unavailable in this runtime.", semantic: "blocked", announcement: "alert" },
  optional_capability_missing: { flowStep: "review", heading: "Optional — unavailable in this runtime.", semantic: "warning", announcement: "none" },
  intent_ready: { flowStep: "publish", heading: "Ready for publication approval.", action: action("publish", "Publish napplet", { duplicateGuard: "next_stage_fenced" }), semantic: "neutral", announcement: "none" },
  intent_invalidated: { flowStep: "review", heading: "Review changed — publication approval was cleared.", body: "Artifact, capability, compatibility, d-tag, or policy details changed. Review the exact current details before signing.", action: action("review_capabilities", "Review capabilities", { duplicateGuard: "next_stage_fenced" }), semantic: "warning", announcement: "polite_once" },
  publish_approval: { flowStep: "publish", heading: "Publish this verified napplet?", body: "You are approving deployment of the sealed artifact shown here and publication of your signed manifest. You will sign next.", action: action("sign_manifest", "Approve and continue to signing", { duplicateGuard: "no_duplicate_effect" }), dialog: { kind: "publish_approval", role: "dialog", heading: "Publish this verified napplet?", body: "You are approving deployment of the sealed artifact shown here and publication of your signed manifest. You will sign next.", primaryActionLabel: "Approve and continue to signing", secondaryActionLabel: "Return to review", closeRule: "close_has_no_effect", cannotCancelPersistedOperation: false, initialFocus: "least_destructive", focusTrap: true, focusRestore: true }, semantic: "neutral", announcement: "none" },
  signer_active: { flowStep: "sign", heading: "Waiting for {signerKind} signer…", action: action("cancel_signing", "Cancel signing", { duplicateGuard: "local_handoff_only", isNextAction: false }), semantic: "busy", announcement: "polite_once" },
  signature_rejected: { flowStep: "sign", heading: "The manifest was not accepted.", body: "Review the manifest and sign the exact current publication intent again.", action: action("review_manifest", "Review manifest", { duplicateGuard: "next_stage_fenced" }), semantic: "error", announcement: "alert" },
  signature_stale: { flowStep: "review", heading: "The signature is no longer valid for this publication.", body: "The publication intent expired or changed. Start a new review and signing step.", action: action("review_capabilities", "Review capabilities", { duplicateGuard: "next_stage_fenced" }), semantic: "warning", announcement: "alert" },
  signature_accepted: { flowStep: "status", heading: "Signature verified. Preparing the original publication operation…", semantic: "neutral", announcement: "polite_once", cannotCancelPersistedOperation: true },
  deployment_observing: { flowStep: "status", heading: "Deploying sealed bytes", body: "Closing this surface does not cancel reconciliation.", semantic: "busy", announcement: "none", cannotCancelPersistedOperation: true },
  reconciliation_pending: { flowStep: "status", heading: "Publication status is being reconciled.", body: "The service is checking the original publication operation. Do not sign or publish again.", action: action("reconcile_publication", "Reconcile publication", { queryOnly: true, duplicateGuard: "original_operation_only" }), dialog: { kind: "reconciliation_detail", role: "dialog", heading: "Publication status is being reconciled.", body: "The service is checking the original publication operation. Do not sign or publish again.", closeRule: "cannot_cancel_persisted_operation", cannotCancelPersistedOperation: true, initialFocus: "least_destructive", focusTrap: true, focusRestore: true }, semantic: "neutral", announcement: "polite_once", cannotCancelPersistedOperation: true },
  exact_replay: { flowStep: "status", heading: "This publication was already processed.", action: action("view_publication_details", "View publication details", { queryOnly: true, isNextAction: false }), semantic: "neutral", announcement: "none", cannotCancelPersistedOperation: true },
  complete: { flowStep: "status", heading: "Napplet published.", action: action("copy_publication_details", "Copy publication details", { queryOnly: true, isNextAction: false }), semantic: "complete", announcement: "none", cannotCancelPersistedOperation: true },
  partial: { flowStep: "status", heading: "Publication is not complete.", body: "Some results are confirmed; reconciliation will determine the remaining result.", action: action("reconcile_publication", "Reconcile publication", { queryOnly: true, duplicateGuard: "original_operation_only" }), semantic: "partial", announcement: "polite_once", cannotCancelPersistedOperation: true },
  conflict: { flowStep: "status", heading: "This publication request conflicts with an existing intent.", body: "Review the current artifact and create a new publication only if you intend to publish a different verified artifact.", action: action("return_to_artifact", "View artifact status", { queryOnly: true, duplicateGuard: "no_duplicate_effect" }), semantic: "error", announcement: "alert", cannotCancelPersistedOperation: true },
  terminal_failure: { flowStep: "status", heading: "Publication could not be completed.", body: "The exact operation was recorded. Review its status before taking another action.", action: action("view_publication_status", "View publication status", { queryOnly: true, duplicateGuard: "original_operation_only" }), semantic: "error", announcement: "alert", cannotCancelPersistedOperation: true },
  launch_certification_blocked: { flowStep: "status", heading: "Launch certification is blocked.", body: "Required live evidence is missing, stale, failed, skipped, or not observed. Production promotion is unavailable.", action: action("view_release_evidence", "View release evidence", { queryOnly: true, duplicateGuard: "no_duplicate_effect" }), semantic: "blocked", announcement: "alert", cannotCancelPersistedOperation: true },
});

const layout = { spacingPx: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32, "2xl": 48, "3xl": 64 }, typography: { body: "16px/400/1.5", label: "14px/600/1.5", heading: "20px/600/1.2", display: "28px/600/1.2", tabularNumerals: true }, semanticTokens: { dominant: "var(--host-surface)", secondary: "var(--host-surface-raised)", accent: "var(--host-accent)", destructive: "var(--host-danger)", allocation: "60/30/10", contrast: "wcag_2_2_aa" }, desktopGrid: "60-66/34-40", desktopGapPx: 32, previewAspectRatio: "16:10", tabletInspector: "expanded_sections", mobileInspector: "single_current_section", mobileNextAction: "full_width", minimumTargetPx: 44, outerScrollOwner: "host", iframeScrollOwner: "iframe", nestedHorizontalPanes: false, descriptionWrap: true, identifierDisplay: "middle_ellipsis" } as const;
const accessibility = { mainLandmark: "labelled", progressNav: "labelled", iframeTitle: "Sealed preview of verified napplet", currentStepAria: "aria-current=step", disabledStepReason: "required", focusRingPx: 2, focusRingContrast: "3:1", focusOrder: ["header", "progress", "preview_controls", "inspector_facts", "current_action"], dialogFocusTrap: true, dialogFocusRestore: true, busyLabels: true, colorIndependentStatus: true, iconOnlyControls: "prohibited" } as const;
const uiConsiderations = { empty: "exact_copy_blocks_publication", loading: "distinct_redacted_copy_no_duplicate_progression", error: "safe_copy_explicit_or_query_only_action", populated: "verified_allowlisted_facts_only", partial: "original_operation_reconciliation_only", overflow: "host_outer_iframe_inner_no_horizontal_panes", zero_one_many: "zero_blocks_one_full_many_required_first", long_text: "wrap_or_middle_ellipsis_with_labelled_copy" } as const;
const identifierRules: Readonly<Record<z.infer<typeof HostIdentifierKindSchema>, Readonly<{ label: string; accessiblePrefix: string; copyLabel: string }>>> = {
  aggregate_hash: { label: "Aggregate hash", accessiblePrefix: "Full aggregate hash", copyLabel: "Copy full aggregate hash" }, normalized_d_tag: { label: "d-tag", accessiblePrefix: "Full normalized d-tag", copyLabel: "Copy full normalized d-tag" }, capability_digest: { label: "Capability digest", accessiblePrefix: "Full capability digest", copyLabel: "Copy full capability digest" }, admission_reference: { label: "Admission reference", accessiblePrefix: "Full admission reference", copyLabel: "Copy full admission reference" }, publication_intent: { label: "Publication intent", accessiblePrefix: "Full publication intent", copyLabel: "Copy full publication intent" }, publication_operation: { label: "Publication operation", accessiblePrefix: "Full publication operation", copyLabel: "Copy full publication operation" }, owner_manifest_event: { label: "Your manifest event", accessiblePrefix: "Full owning manifest event identifier", copyLabel: "Copy full manifest event identifier" }, cvm_attestation: { label: "CVM build attestation", accessiblePrefix: "Full CVM build attestation identifier", copyLabel: "Copy full CVM build attestation identifier" }, deployment: { label: "Deployment", accessiblePrefix: "Full deployment identifier", copyLabel: "Copy full deployment identifier" }, evidence_reference: { label: "Evidence reference", accessiblePrefix: "Full evidence reference", copyLabel: "Copy full evidence reference" },
};
const requiredIdentifierValue = (value: string | undefined, fallback: string): string => value ?? fallback;
function identifiersFor(identity: z.infer<typeof HostIdentitySchema>): HostIdentifier[] {
  const values: Record<z.infer<typeof HostIdentifierKindSchema>, string> = {
    aggregate_hash: identity.aggregateSha256, normalized_d_tag: identity.normalizedDTag, capability_digest: requiredIdentifierValue(identity.capabilityDigest, identity.aggregateSha256), admission_reference: requiredIdentifierValue(identity.admissionReference, identity.artifactId), publication_intent: requiredIdentifierValue(identity.intentId, identity.artifactId), publication_operation: requiredIdentifierValue(identity.operationId, identity.artifactId), owner_manifest_event: requiredIdentifierValue(identity.ownerEventId, identity.aggregateSha256), cvm_attestation: requiredIdentifierValue(identity.attestationId, identity.artifactId), deployment: requiredIdentifierValue(identity.deploymentId, identity.artifactId), evidence_reference: requiredIdentifierValue(identity.evidenceReference, identity.artifactId),
  };
  return (Object.keys(identifierRules) as Array<z.infer<typeof HostIdentifierKindSchema>>).map((kind) => ({ kind, visibleLabel: identifierRules[kind].label, displayValue: middleEllipsis(values[kind]), fullValue: values[kind], accessibleName: `${identifierRules[kind].accessiblePrefix}: ${values[kind]}`, copyLabel: identifierRules[kind].copyLabel, minimumTargetPx: 44 }));
}

export const HostBrowserEvidenceStatusSchema = z.enum(["pass", "failed", "blocked", "not_observed", "skipped"]);
const BrowserObservationSchema = z.object({
  viewportWidthPx: z.number().int().positive(), screenshotSha256: Sha256Schema, reportSha256: Sha256Schema,
  layout: HostBrowserEvidenceStatusSchema, targets: HostBrowserEvidenceStatusSchema, accessibility: HostBrowserEvidenceStatusSchema,
  keyboardFocus: HostBrowserEvidenceStatusSchema, dialog: HostBrowserEvidenceStatusSchema, liveRegion: HostBrowserEvidenceStatusSchema,
  contrast: HostBrowserEvidenceStatusSchema, reducedMotion: HostBrowserEvidenceStatusSchema, stateInventory: HostBrowserEvidenceStatusSchema,
  identifierCoverage: HostBrowserEvidenceStatusSchema, minimumMeasuredTargetPx: z.number().int().min(44),
  noClippedStepLabels: z.literal(true), noNestedHorizontalScroll: z.literal(true),
}).strict();
export const HostBrowserEvidenceSchema = z.object({
  hostVersion: z.string().min(1).max(256), runtimeVersion: z.string().min(1).max(256), sealedArtifactSha256: Sha256Schema, presentationInputSha256: Sha256Schema,
  execution: z.enum(["unit_projection", "real_compatible_host_browser"]),
  observations: z.array(BrowserObservationSchema).min(3).max(3), hostPreview: HostBrowserEvidenceStatusSchema, hostSigner: HostBrowserEvidenceStatusSchema, externalSigner: HostBrowserEvidenceStatusSchema, reconciliation: HostBrowserEvidenceStatusSchema, launchCertificationBlockedState: HostBrowserEvidenceStatusSchema,
}).strict().superRefine((value, context) => {
  for (const width of [1280, 768, 375]) if (!value.observations.some((observation) => observation.viewportWidthPx >= width && observation.viewportWidthPx < (width === 1280 ? Number.POSITIVE_INFINITY : width === 768 ? 1280 : 768))) context.addIssue({ code: "custom", message: `VIEWPORT_${width}_REQUIRED`, path: ["observations"] });
}).transform((value) => {
  const statuses = [value.hostPreview, value.hostSigner, value.externalSigner, value.reconciliation, value.launchCertificationBlockedState, ...value.observations.flatMap((observation) => [observation.layout, observation.targets, observation.accessibility, observation.keyboardFocus, observation.dialog, observation.liveRegion, observation.contrast, observation.reducedMotion, observation.stateInventory, observation.identifierCoverage])];
  return { ...value, certificationStatus: value.execution === "real_compatible_host_browser" && statuses.every((status) => status === "pass") ? "pass" as const : "non_pass" as const };
});
export type HostBrowserEvidence = Readonly<z.infer<typeof HostBrowserEvidenceSchema>>;

function canonicalState(input: HostPublicationInput): HostState {
  if (input.changedFacts) return "intent_invalidated";
  if (input.exactReplay) return "exact_replay";
  if (HostStateSchema.safeParse(input.state).success) return input.state as HostState;
  return stateAlias[input.state as z.infer<typeof LegacyStateSchema>];
}

function legacyCompatibility(input: HostPublicationInput, missingRequired: boolean, emptyCapabilities: boolean): Readonly<{ flowStep?: "artifact" | "preview" | "review" | "publish" | "sign" | "status" | "publication"; primaryAction?: HostAction; progressLabel?: string }> {
  if (!LegacyStateSchema.safeParse(input.state).success) return {};
  if (input.changedFacts || missingRequired || (emptyCapabilities && input.state !== "pre_preview" && input.state !== "loading") || input.state === "absent_manifest" || input.state === "preview_incompatible") {
    return { primaryAction: input.state === "preview_incompatible" ? "preview" : "review_capabilities", progressLabel: input.changedFacts ? "Review changed — publication approval was cleared." : missingRequired ? "A required capability is unavailable in this runtime." : "No manifest capabilities were returned." };
  }
  switch (input.state) {
    case "pre_preview": return { flowStep: "artifact", primaryAction: "preview", progressLabel: "Preview the verified artifact before publication." };
    case "loading": return { flowStep: "artifact", primaryAction: "preview", progressLabel: "Checking verified artifact…" };
    case "preview_ready": return { flowStep: "preview", primaryAction: "review_capabilities", progressLabel: "Preview ready." };
    case "review_ready": return { flowStep: "review", primaryAction: "publish", progressLabel: "Review the exact capability set before publication." };
    case "intent_ready": return { flowStep: "sign", primaryAction: "sign_manifest", progressLabel: "Sign the exact publication manifest." };
    case "signing": return { flowStep: "sign", primaryAction: "publish", progressLabel: "Waiting for the owner-signed manifest." };
    case "publication_reconciliation_pending": return { flowStep: "publication", primaryAction: "reconcile_publication", progressLabel: "Publication effects are being reconciled." };
    case "partial": return { flowStep: "publication", primaryAction: "reconcile_publication", progressLabel: "Publication is partially observed. Reconcile the original operation." };
    case "complete": return { flowStep: "publication", progressLabel: "Napplet published." };
    case "error": return { flowStep: "publication", primaryAction: input.nextAction ?? "preview", progressLabel: "A safe recovery action is available." };
    default: return {};
  }
}

/** Pure trusted projection: no DOM, transport, signer, store, provider, or iframe authority. */
export function projectHostPublicationSurface(input: unknown): HostPublicationSurface {
  const parsed = HostPublicationInputSchema.parse(input);
  const state = canonicalState(parsed);
  const selected = STATE_PRESENTATIONS[state];
  const capabilityRows = [...parsed.capabilities].sort((left, right) => Number(left.requirement === "optional") - Number(right.requirement === "optional") || left.capability.localeCompare(right.capability)).map((capability) => ({ capability: capability.capability, requirement: capability.requirement, purpose: capability.purpose, consent: capability.consent, availability: capability.available ? "available" as const : capability.requirement === "required" ? "required_unavailable" as const : "optional_unavailable" as const, evidenceLabel: capability.evidenceLabel, ...(capability.requirement === "optional" && !capability.available && capability.gracefulDegradation ? { gracefulDegradation: capability.gracefulDegradation } : {}) }));
  const derivedState = capabilityRows.some((row) => row.availability === "required_unavailable") && state === "intent_ready" ? "required_capability_missing" : capabilityRows.length === 0 && state === "intent_ready" ? "capability_empty" : state;
  const presentation = STATE_PRESENTATIONS[derivedState];
  const legacy = legacyCompatibility(parsed, capabilityRows.some((row) => row.availability === "required_unavailable"), capabilityRows.length === 0);
  const heading = presentation.heading.replace("{signerKind}", parsed.signerKind ?? "host");
  const body = presentation.body?.replace("{retryHint}", parsed.retryHint ?? "the displayed retry window");
  const actions = presentation.action ? [presentation.action] : [];
  const dialog = presentation.dialog ?? noDialog(Boolean(presentation.cannotCancelPersistedOperation));
  const semanticStatus = { kind: presentation.semantic, token: presentation.semantic === "error" || presentation.semantic === "blocked" ? "destructive" : presentation.semantic === "complete" || presentation.semantic === "verified" ? "accent" : "secondary", textPlusShape: true, colorIndependent: true } as const;
  const output = {
    presentationVersion: "1", state: derivedState, flowStep: legacy.flowStep ?? presentation.flowStep, heading, ...(body ? { body } : {}), actions, layout, semanticStatus, dialog,
    liveAnnouncement: { mode: presentation.announcement, copy: body ?? heading, debounced: true }, identifiers: identifiersFor(parsed.identity), motion: { reduced: "instant_or_100ms_fade", standard: "150ms_opacity_transform", externalEffectProgressAnimation: false }, accessibility, uiConsiderations,
    identity: parsed.identity, capabilityRows, effectRows: parsed.effects ?? [], ...(legacy.primaryAction ? { primaryAction: legacy.primaryAction } : actions.find((entry) => entry.isNextAction) ? { primaryAction: actions.find((entry) => entry.isNextAction)!.machineAction } : {}), secondaryActions: [], duplicateActionDisabled: Boolean(parsed.duplicateActionPending || derivedState === "descriptor_loading" || derivedState === "signer_active"), acknowledgementRequired: Boolean(parsed.changedFacts || derivedState === "intent_invalidated"), progressLabel: legacy.progressLabel ?? heading, ...(parsed.safeError ? { safeError: parsed.safeError === "preview_unavailable" ? "Preview unavailable. Verify the artifact and try preview again." : parsed.safeError === "review_changed" ? "Review changed. Review the exact current details before signing." : parsed.safeError === "signature_invalid" ? "The signature is no longer valid for this publication. Review and sign again." : "Publication is currently unavailable. Continue previewing the verified artifact." } : {}), inspectorScrollOwner: "host", mobileLayout: "stacked", nestedHorizontalPanes: false, identifierDisplay: "middle_ellipsis", identifierCopyLabel: "Copy full identifier", identifierAccessibleValue: parsed.identity.aggregateSha256, descriptionWrap: true,
  } as const;
  return Object.freeze(HostPresentationSchema.parse(output));
}

// Compile-time boundary use: host presentation sources remain finite operational facts.
void HostPresentationSourceFactsSchema;
