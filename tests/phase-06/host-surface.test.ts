import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import { HostPublicationSurfaceSchema, projectHostPublicationSurface } from "../../src/publication/host-surface";

const sha = "a".repeat(64);
const identity = { artifactId: "artifact:one", aggregateSha256: sha, normalizedDTag: "one", capabilityDigest: sha, intentId: "intent:one" };
const required = { capability: "nip:required", requirement: "required" as const, purpose: "Needed to render the verified napplet", consent: "required" as const, available: true, evidenceLabel: "Verified manifest" };
const optional = { capability: "nip:optional", requirement: "optional" as const, purpose: "Enhances the presentation", consent: "optional" as const, available: false, evidenceLabel: "Verified manifest", gracefulDegradation: "Uses the verified reduced display" };

describe("Phase 6 compact host publication surface", () => {
  test("empty pre-preview and absent-manifest states explicitly block linear progression", () => {
    const prePreview = projectHostPublicationSurface({ state: "pre_preview", identity, capabilities: [] });
    const absentManifest = projectHostPublicationSurface({ state: "absent_manifest", identity, capabilities: [] });
    expect(prePreview).toMatchObject({ flowStep: "artifact", primaryAction: "preview", progressLabel: "Preview the verified artifact before publication." });
    expect(absentManifest).toMatchObject({ flowStep: "review", primaryAction: "review_capabilities", progressLabel: "No manifest capabilities were returned.", acknowledgementRequired: false });
  });

  test("loading preserves identity and disables unsafe duplicate progression", () => {
    const surface = projectHostPublicationSurface({ state: "loading", identity, capabilities: [required], duplicateActionPending: true });
    expect(surface).toMatchObject({ identity, duplicateActionDisabled: true, progressLabel: "Checking verified artifact…", primaryAction: "preview" });
  });

  test("safe errors retain only a recovery action and no raw internals", () => {
    const surface = projectHostPublicationSurface({ state: "error", identity, capabilities: [required], safeError: "preview_unavailable", nextAction: "preview" });
    expect(surface).toMatchObject({ primaryAction: "preview", safeError: "Preview unavailable. Verify the artifact and try preview again." });
    expect(JSON.stringify(surface)).not.toMatch(/provider|stack|secret|raw/i);
  });

  test("populated and partial flows expose linear owner-safe artifact, manifest, capability, event, and attestation facts", () => {
    const review = projectHostPublicationSurface({ state: "review_ready", identity, capabilities: [optional, required] });
    const partial = projectHostPublicationSurface({ state: "partial", identity, capabilities: [required, optional], effects: [{ label: "Deployment", state: "confirmed", identifier: "deployment:one" }, { label: "Owner manifest", state: "not_yet_confirmed" }], nextAction: "reconcile_publication" });
    expect(review).toMatchObject({ flowStep: "review", primaryAction: "publish", capabilityRows: [expect.objectContaining({ capability: "nip:required" }), expect.objectContaining({ capability: "nip:optional" })] });
    expect(partial).toMatchObject({ flowStep: "publication", primaryAction: "reconcile_publication", effectRows: [expect.objectContaining({ state: "confirmed" }), expect.objectContaining({ state: "not_yet_confirmed" })] });
  });

  test("required capability absence blocks while optional absence remains explicit graceful degradation", () => {
    const blocked = projectHostPublicationSurface({ state: "review_ready", identity, capabilities: [{ ...required, available: false }, optional] });
    const degraded = projectHostPublicationSurface({ state: "review_ready", identity, capabilities: [required, optional] });
    expect(blocked).toMatchObject({ primaryAction: "review_capabilities", progressLabel: "A required capability is unavailable in this runtime." });
    expect(degraded.capabilityRows.at(-1)).toMatchObject({ availability: "optional_unavailable", gracefulDegradation: optional.gracefulDegradation });
  });

  test("zero, one, and many capability rows retain blocking/full/required-first labelled evidence", () => {
    const zero = projectHostPublicationSurface({ state: "review_ready", identity, capabilities: [] });
    const one = projectHostPublicationSurface({ state: "review_ready", identity, capabilities: [required] });
    const many = projectHostPublicationSurface({ state: "review_ready", identity, capabilities: [optional, required] });
    expect(zero).toMatchObject({ primaryAction: "review_capabilities", progressLabel: "No manifest capabilities were returned." });
    expect(one.capabilityRows).toHaveLength(1);
    expect(many.capabilityRows.map((row) => row.requirement)).toEqual(["required", "optional"]);
    expect(many.capabilityRows.every((row) => row.evidenceLabel === "Verified manifest")).toBe(true);
  });

  test("overflow, mobile, and long text are fixed host rendering tokens", () => {
    const surface = projectHostPublicationSurface({ state: "preview_ready", identity, capabilities: [required] });
    expect(surface).toMatchObject({ inspectorScrollOwner: "host", mobileLayout: "stacked", nestedHorizontalPanes: false, identifierDisplay: "middle_ellipsis", identifierCopyLabel: "Copy full identifier", identifierAccessibleValue: identity.aggregateSha256, descriptionWrap: true });
    expect(() => HostPublicationSurfaceSchema.parse({ ...surface, nestedHorizontalPanes: true })).toThrow();
  });

  test("conflicts require acknowledgement while exact replay stays quiet", () => {
    const conflict = projectHostPublicationSurface({ state: "intent_ready", identity, capabilities: [required], changedFacts: true });
    const replay = projectHostPublicationSurface({ state: "partial", identity, capabilities: [required], exactReplay: true, nextAction: "reconcile_publication" });
    expect(conflict).toMatchObject({ acknowledgementRequired: true, primaryAction: "review_capabilities" });
    expect(replay).toMatchObject({ acknowledgementRequired: false, duplicateActionDisabled: false, primaryAction: "reconcile_publication" });
  });

  test("records that the UI specification has zero backstop and zero unresolved rows", async () => {
    const uiSpec = await readFile(new URL("../../.planning/phases/06-sealed-preview-user-owned-publication/06-UI-SPEC.md", import.meta.url), "utf8");
    expect(uiSpec).toContain("20 covered, 0 backstop, 0 unresolved");
    expect(uiSpec).not.toMatch(/\|\s*(?:backstop|unresolved)\s*\|/iu);
  });
});
