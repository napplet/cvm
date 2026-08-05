import { describe, expect, test } from "bun:test";

import {
  HostBrowserEvidenceSchema,
  HostIdentifierSchema,
  HostPresentationSchema,
  HostStateSchema,
  STATE_PRESENTATIONS,
  projectHostPublicationSurface,
} from "../../src/publication/host-surface";

const sha = "a".repeat(64);
const identity = {
  artifactId: "artifact:one",
  aggregateSha256: sha,
  normalizedDTag: "one",
  capabilityDigest: sha,
  admissionReference: "admission:one",
  intentId: "intent:one",
  operationId: "operation:one",
  ownerEventId: sha,
  attestationId: "attestation:one",
  deploymentId: "deployment:one",
  evidenceReference: "evidence:one",
};
const capability = {
  capability: "nip:required",
  requirement: "required" as const,
  purpose: "Needed to render the verified napplet",
  consent: "required" as const,
  available: true,
  evidenceLabel: "Verified manifest",
};

const expectedCopy = {
  admission_preparing: ["Starting isolated workspace…", undefined],
  capacity_unavailable: ["Capacity is temporarily unavailable.", "No session was started and no funds were reserved. Try again after a short while."],
  descriptor_loading: ["Checking verified artifact…", undefined],
  verified_artifact_no_preview: ["Preview not started", "Open the exact verified artifact before preparing publication."],
  preview_loading: ["Opening sealed preview…", undefined],
  preview_ready: ["Preview ready", undefined],
  preview_incompatible: ["This runtime cannot run the verified napplet.", "Choose a compatible runtime to preview and publish this artifact."],
  preview_expired: ["Preview access expired.", "Request a new preview for this same verified artifact. No publication was started."],
  preview_denied: ["Preview is unavailable for this artifact.", "Return to the verified artifact and review its status."],
  capability_loading: ["Checking runtime compatibility…", undefined],
  capability_empty: ["No manifest capabilities were returned.", "Publication cannot continue until the verified manifest is available."],
  required_capability_missing: ["Required — unavailable in this runtime.", undefined],
  optional_capability_missing: ["Optional — unavailable in this runtime.", undefined],
  intent_ready: ["Ready for publication approval.", undefined],
  intent_invalidated: ["Review changed — publication approval was cleared.", "Artifact, capability, compatibility, d-tag, or policy details changed. Review the exact current details before signing."],
  publish_approval: ["Publish this verified napplet?", "You are approving deployment of the sealed artifact shown here and publication of your signed manifest. You will sign next."],
  signer_active: ["Waiting for host signer…", undefined],
  signature_rejected: ["The manifest was not accepted.", "Review the manifest and sign the exact current publication intent again."],
  signature_stale: ["The signature is no longer valid for this publication.", "The publication intent expired or changed. Start a new review and signing step."],
  signature_accepted: ["Signature verified. Preparing the original publication operation…", undefined],
  deployment_observing: ["Deploying sealed bytes", "Closing this surface does not cancel reconciliation."],
  reconciliation_pending: ["Publication status is being reconciled.", "The service is checking the original publication operation. Do not sign or publish again."],
  exact_replay: ["This publication was already processed.", undefined],
  complete: ["Napplet published.", undefined],
  partial: ["Publication is not complete.", "Some results are confirmed; reconciliation will determine the remaining result."],
  conflict: ["This publication request conflicts with an existing intent.", "Review the current artifact and create a new publication only if you intend to publish a different verified artifact."],
  terminal_failure: ["Publication could not be completed.", "The exact operation was recorded. Review its status before taking another action."],
  launch_certification_blocked: ["Launch certification is blocked.", "Required live evidence is missing, stale, failed, skipped, or not observed. Production promotion is unavailable."],
} as const;

describe("Phase 7 compatible-host presentation contract", () => {
  test("projects all 28 approved State Matrix rows with exact redacted copy and one next action", () => {
    expect(HostStateSchema.options).toHaveLength(28);
    expect(Object.keys(STATE_PRESENTATIONS).sort()).toEqual(Object.keys(expectedCopy).sort());

    for (const [state, [heading, body]] of Object.entries(expectedCopy)) {
      const surface = projectHostPublicationSurface({ state, identity, capabilities: [capability], retryHint: "a short while" });
      expect(surface).toMatchObject({ presentationVersion: "1", state, heading });
      expect(surface.body).toBe(body);
      expect(surface.actions.filter((action) => action.enabled && action.isNextAction)).toHaveLength(surface.actions.some((action) => action.isNextAction) ? 1 : 0);
      expect(surface.liveAnnouncement.copy).not.toMatch(/provider|credential|secret|runtime message|raw/i);
    }
  });

  test("keeps dialogs, duplicate guards, persisted-operation cancellation, and query-only reconciliation explicit", () => {
    const approval = projectHostPublicationSurface({ state: "publish_approval", identity, capabilities: [capability] });
    const reconciliation = projectHostPublicationSurface({ state: "reconciliation_pending", identity, capabilities: [capability] });
    const terminal = projectHostPublicationSurface({ state: "terminal_failure", identity, capabilities: [capability] });

    expect(approval.dialog).toMatchObject({ kind: "publish_approval", role: "dialog", closeRule: "close_has_no_effect", initialFocus: "least_destructive" });
    expect(reconciliation.actions).toContainEqual(expect.objectContaining({ machineAction: "reconcile_publication", queryOnly: true, duplicateGuard: "original_operation_only" }));
    expect(terminal.dialog.cannotCancelPersistedOperation).toBe(true);
  });

  test("uses exact identifier-specific visible, accessible, and copy labels without accepting sensitive kinds", () => {
    const labels = {
      aggregate_hash: ["Aggregate hash", `Full aggregate hash: ${sha}`, "Copy full aggregate hash"],
      normalized_d_tag: ["d-tag", "Full normalized d-tag: one", "Copy full normalized d-tag"],
      capability_digest: ["Capability digest", `Full capability digest: ${sha}`, "Copy full capability digest"],
      admission_reference: ["Admission reference", "Full admission reference: admission:one", "Copy full admission reference"],
      publication_intent: ["Publication intent", "Full publication intent: intent:one", "Copy full publication intent"],
      publication_operation: ["Publication operation", "Full publication operation: operation:one", "Copy full publication operation"],
      owner_manifest_event: ["Your manifest event", `Full owning manifest event identifier: ${sha}`, "Copy full manifest event identifier"],
      cvm_attestation: ["CVM build attestation", "Full CVM build attestation identifier: attestation:one", "Copy full CVM build attestation identifier"],
      deployment: ["Deployment", "Full deployment identifier: deployment:one", "Copy full deployment identifier"],
      evidence_reference: ["Evidence reference", "Full evidence reference: evidence:one", "Copy full evidence reference"],
    } as const;
    const surface = projectHostPublicationSurface({ state: "complete", identity, capabilities: [capability] });
    expect(surface.identifiers).toHaveLength(10);
    for (const [kind, [label, accessibleName, copyLabel]] of Object.entries(labels)) {
      expect(surface.identifiers).toContainEqual(expect.objectContaining({ kind, visibleLabel: label, accessibleName, copyLabel, minimumTargetPx: 44 }));
    }
    expect(() => HostIdentifierSchema.parse({ kind: "private_key", displayValue: "x", fullValue: "x", visibleLabel: "x", accessibleName: "x", copyLabel: "x" })).toThrow();
  });

  test("rejects generic presentation states, unsupported versions, multiple next actions, and iframe-controlled display facts", () => {
    expect(() => HostStateSchema.parse("loading")).toThrow();
    const surface = projectHostPublicationSurface({ state: "preview_ready", identity, capabilities: [capability] });
    expect(() => HostPresentationSchema.parse({ ...surface, presentationVersion: "2" })).toThrow();
    expect(() => HostPresentationSchema.parse({ ...surface, actions: [...surface.actions, { ...surface.actions[0], isNextAction: true, enabled: true }] })).toThrow();
    expect(() => projectHostPublicationSurface({ state: "preview_ready", identity, capabilities: [capability], iframe: { heading: "Spoofed", css: "*", action: "publish", status: "complete", accessibleName: "x" } })).toThrow();
  });

  test("locks responsive, semantic, accessibility, motion, and eight UI-consideration facts", () => {
    const surface = projectHostPublicationSurface({ state: "preview_ready", identity, capabilities: [capability] });
    expect(surface.layout).toMatchObject({ desktopGrid: "60-66/34-40", desktopGapPx: 32, previewAspectRatio: "16:10", tabletInspector: "expanded_sections", mobileInspector: "single_current_section", mobileNextAction: "full_width", minimumTargetPx: 44, outerScrollOwner: "host", iframeScrollOwner: "iframe", nestedHorizontalPanes: false });
    expect(surface.accessibility).toMatchObject({ mainLandmark: "labelled", progressNav: "labelled", iframeTitle: "Sealed preview of verified napplet", focusRingPx: 2, focusOrder: ["header", "progress", "preview_controls", "inspector_facts", "current_action"], dialogFocusTrap: true, dialogFocusRestore: true, colorIndependentStatus: true });
    expect(surface.motion).toEqual({ reduced: "instant_or_100ms_fade", standard: "150ms_opacity_transform", externalEffectProgressAnimation: false });
    expect(Object.keys(surface.uiConsiderations).sort()).toEqual(["empty", "error", "loading", "long_text", "overflow", "partial", "populated", "zero_one_many"]);
  });

  test("requires candidate-bound real-host browser evidence and keeps blocked/not_observed non-pass", () => {
    const base = {
      hostVersion: "host@1.0.0",
      runtimeVersion: "nip-5d@4.0.0",
      sealedArtifactSha256: sha,
      presentationInputSha256: sha,
      execution: "unit_projection" as const,
      observations: [
        { viewportWidthPx: 1280, screenshotSha256: sha, reportSha256: sha, layout: "pass", targets: "pass", accessibility: "pass", keyboardFocus: "pass", dialog: "pass", liveRegion: "pass", contrast: "pass", reducedMotion: "pass", stateInventory: "pass", identifierCoverage: "pass", minimumMeasuredTargetPx: 44, noClippedStepLabels: true, noNestedHorizontalScroll: true },
        { viewportWidthPx: 768, screenshotSha256: sha, reportSha256: sha, layout: "pass", targets: "pass", accessibility: "pass", keyboardFocus: "pass", dialog: "pass", liveRegion: "pass", contrast: "pass", reducedMotion: "pass", stateInventory: "pass", identifierCoverage: "pass", minimumMeasuredTargetPx: 44, noClippedStepLabels: true, noNestedHorizontalScroll: true },
        { viewportWidthPx: 375, screenshotSha256: sha, reportSha256: sha, layout: "pass", targets: "pass", accessibility: "pass", keyboardFocus: "pass", dialog: "pass", liveRegion: "pass", contrast: "pass", reducedMotion: "pass", stateInventory: "pass", identifierCoverage: "pass", minimumMeasuredTargetPx: 44, noClippedStepLabels: true, noNestedHorizontalScroll: true },
      ],
      hostPreview: "blocked",
      hostSigner: "not_observed",
      externalSigner: "not_observed",
      reconciliation: "blocked",
      launchCertificationBlockedState: "pass",
    };
    const evidence = HostBrowserEvidenceSchema.parse(base);
    expect(evidence.hostPreview).toBe("blocked");
    expect(evidence.certificationStatus).toBe("non_pass");
    expect(() => HostBrowserEvidenceSchema.parse({ ...base, observations: base.observations.slice(0, 2) })).toThrow();
    expect(() => HostBrowserEvidenceSchema.parse({ ...base, observations: base.observations.map((observation) => ({ ...observation, minimumMeasuredTargetPx: 43 })) })).toThrow();
    expect(HostBrowserEvidenceSchema.parse({ ...base, hostPreview: "pass", hostSigner: "pass", externalSigner: "pass", reconciliation: "pass", launchCertificationBlockedState: "pass" }).certificationStatus).toBe("non_pass");
  });
});
