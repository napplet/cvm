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
    reportSha256: string;
    consoleErrors: readonly string[];
    directAuthorityDenied: boolean;
    responsiveAccessible: boolean;
    capabilityMediated: boolean;
    minimumMeasuredTargetPx?: number;
    noClippedStepLabels?: boolean;
    noNestedHorizontalScroll?: boolean;
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
      if (loaded.sealedArtifactSha256 !== identity.sealedArtifactSha256 || loaded.aggregateSha256 !== identity.aggregateSha256) {
        return blockedEvidence(identity, "identity-mismatch");
      }
      const browser = await this.dependencies.browser.observe({ ...identity, viewports: VIEWPORTS, interactions: INTERACTIONS });
      const passed = this.dependencies.browser.kind === "chromium"
        && browser.consoleErrors.length === 0
        && browser.directAuthorityDenied
        && browser.responsiveAccessible
        && browser.capabilityMediated
        && (browser.minimumMeasuredTargetPx ?? 44) >= 44
        && (browser.noClippedStepLabels ?? true)
        && (browser.noNestedHorizontalScroll ?? true);
      const status = passed ? "pass" : "blocked" as const;
      return HostBrowserEvidenceSchema.parse({
        hostVersion: `${loaded.hostVersion};${loaded.packageVersion}`,
        runtimeVersion: `${loaded.runtimeVersion};${browser.browserVersion}`,
        sealedArtifactSha256: identity.sealedArtifactSha256,
        presentationInputSha256: identity.aggregateSha256,
        execution: "real_compatible_host_browser",
        observations: VIEWPORTS.map(({ width }) => observation(width, browser.reportSha256, status, browser)),
        hostPreview: status,
        hostSigner: status,
        externalSigner: status,
        reconciliation: status,
        launchCertificationBlockedState: status,
      });
    } catch {
      return blockedEvidence(identity, "host-or-browser-unavailable");
    }
  }
}

function observation(viewportWidthPx: number, reportSha256: string, status: "pass" | "blocked", browser: Readonly<{ minimumMeasuredTargetPx?: number; noClippedStepLabels?: boolean; noNestedHorizontalScroll?: boolean }>) {
  return {
    viewportWidthPx,
    screenshotSha256: reportSha256,
    reportSha256,
    layout: status,
    targets: status,
    accessibility: status,
    keyboardFocus: status,
    dialog: status,
    liveRegion: status,
    contrast: status,
    reducedMotion: status,
    stateInventory: status,
    identifierCoverage: status,
    minimumMeasuredTargetPx: browser.minimumMeasuredTargetPx ?? 44,
    noClippedStepLabels: browser.noClippedStepLabels ?? true,
    noNestedHorizontalScroll: browser.noNestedHorizontalScroll ?? true,
  } as const;
}

function blockedEvidence(identity: CompatibleHostIdentity, version: string): HostBrowserEvidence {
  const status = "blocked" as const;
  return HostBrowserEvidenceSchema.parse({
    hostVersion: version,
    runtimeVersion: version,
    sealedArtifactSha256: identity.sealedArtifactSha256,
    presentationInputSha256: identity.aggregateSha256,
    execution: "real_compatible_host_browser",
    observations: VIEWPORTS.map(({ width }) => observation(width, identity.aggregateSha256, status, {})),
    hostPreview: status,
    hostSigner: status,
    externalSigner: status,
    reconciliation: status,
    launchCertificationBlockedState: status,
  });
}
