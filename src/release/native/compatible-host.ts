import { HostBrowserEvidenceSchema, type HostBrowserEvidence } from "../../publication/host-surface.js";

const VIEWPORTS = Object.freeze([
  { name: "desktop", width: 1280 },
  { name: "tablet", width: 768 },
  { name: "mobile", width: 375 },
] as const);
const INTERACTIONS = Object.freeze([
  "keyboard", "touch", "focus", "dialog", "live_region", "capability_mediation",
] as const);

export type CompatibleHostIdentity = Readonly<{ sealedArtifactSha256: string; aggregateSha256: string }>;

/** The package host receives the sealed identity only; it receives no account, key, or provider material. */
export interface CompatibleHostPackagePort {
  loadSealedNapplet(input: CompatibleHostIdentity): Promise<Readonly<{
    sealedArtifactSha256: string;
    aggregateSha256: string;
    hostVersion: string;
    packageVersion: string;
    runtimeVersion: string;
  }>>;
}

export interface CompatibleHostBrowserPort {
  readonly kind: string;
  observe(input: Readonly<{
    sealedArtifactSha256: string;
    aggregateSha256: string;
    viewports: typeof VIEWPORTS;
    interactions: typeof INTERACTIONS;
  }>): Promise<Readonly<{
    browserVersion: string;
    consoleErrors: readonly string[];
    observations: readonly Readonly<{
      viewportWidthPx: number;
      screenshotSha256: string;
      reportSha256: string;
      layout: "pass" | "blocked" | "not_observed";
      targets: "pass" | "blocked" | "not_observed";
      accessibility: "pass" | "blocked" | "not_observed";
      keyboardFocus: "pass" | "blocked" | "not_observed";
      dialog: "pass" | "blocked" | "not_observed";
      liveRegion: "pass" | "blocked" | "not_observed";
      contrast: "pass" | "blocked" | "not_observed";
      reducedMotion: "pass" | "blocked" | "not_observed";
      stateInventory: "pass" | "blocked" | "not_observed";
      identifierCoverage: "pass" | "blocked" | "not_observed";
      minimumMeasuredTargetPx: number;
      noClippedStepLabels: boolean;
      noNestedHorizontalScroll: boolean;
    }>[];
    hostPreview: "pass" | "blocked" | "not_observed";
    hostSigner: "pass" | "blocked" | "not_observed";
    externalSigner: "pass" | "blocked" | "not_observed";
    reconciliation: "pass" | "blocked" | "not_observed";
    launchCertificationBlockedState: "pass" | "blocked" | "not_observed";
  }>>;
}

/**
 * Candidate-bound adapter over the official package host. The caller supplies a
 * real browser implementation during protected execution; fixtures may only
 * produce non-pass evidence because browser identity is verified here.
 */
export class CompatibleHostBrowserObservationPort {
  constructor(private readonly dependencies: Readonly<{ packageHost: CompatibleHostPackagePort; browser: CompatibleHostBrowserPort }>) {}

  async runBrowser(identity: CompatibleHostIdentity): Promise<HostBrowserEvidence> {
    try {
      const loaded = await this.dependencies.packageHost.loadSealedNapplet(identity);
      if (loaded.sealedArtifactSha256 !== identity.sealedArtifactSha256 || loaded.aggregateSha256 !== identity.aggregateSha256) throw new Error("COMPATIBLE_HOST_IDENTITY_MISMATCH");
      const browser = await this.dependencies.browser.observe({ ...identity, viewports: VIEWPORTS, interactions: INTERACTIONS });
      if (this.dependencies.browser.kind !== "chromium" || browser.consoleErrors.length !== 0 || browser.observations.length !== VIEWPORTS.length) throw new Error("COMPATIBLE_HOST_BROWSER_EVIDENCE_INVALID");
      return HostBrowserEvidenceSchema.parse({
        hostVersion: `${loaded.hostVersion};${loaded.packageVersion}`,
        runtimeVersion: `${loaded.runtimeVersion};${browser.browserVersion}`,
        sealedArtifactSha256: identity.sealedArtifactSha256,
        presentationInputSha256: identity.aggregateSha256,
        execution: "real_compatible_host_browser",
        observations: browser.observations,
        hostPreview: browser.hostPreview,
        hostSigner: browser.hostSigner,
        externalSigner: browser.externalSigner,
        reconciliation: browser.reconciliation,
        launchCertificationBlockedState: browser.launchCertificationBlockedState,
      });
    } catch { throw new Error("COMPATIBLE_HOST_BROWSER_EVIDENCE_UNAVAILABLE"); }
  }
}
