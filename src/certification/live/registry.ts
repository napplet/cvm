import type { ProtectedCertificationAdapterRegistry } from "../adapters";
import type { CertificationInputSchema, ReleaseObservationBindingSchema, WorkerCandidateSchema } from "../contracts";
import { PROTECTED_SUITES } from "../runner";
import { runLiveAdmissionCertification, type LiveAdmissionObservationPort } from "./admission";
import { runLiveTelemetryCertification, type LiveTelemetryObservationPort } from "./telemetry";
import { runLiveChaosCertification, type LiveChaosFaultPort } from "./chaos";
import { runLiveRestoreCertification, type LiveRestorePort } from "./restore";
import { runLiveSecurityHostCertification, type LiveSecurityHostObservationPort } from "./security-host";
import { runLiveSupplyChainCertification, type LiveSupplyChainObservationPort } from "./supply-chain";
import { runLiveContextVmPaymentModelCertification, type LiveContextVmPaymentModelObservationPort } from "./contextvm-payment-model";
import { runLivePublicationCertification, type LivePublicationObservationPort } from "./publication";
import type { ReleaseCertificationTrustRoot } from "../trust";

type Candidate = import("zod").infer<typeof WorkerCandidateSchema>;
type CertificationInput = import("zod").infer<typeof CertificationInputSchema>;
type ReleaseBinding = import("zod").infer<typeof ReleaseObservationBindingSchema>;

export type LiveProtectedCertificationPorts = Readonly<{
  admission?: LiveAdmissionObservationPort;
  telemetry?: LiveTelemetryObservationPort;
  chaos?: LiveChaosFaultPort;
  restore?: LiveRestorePort;
  "security-host"?: LiveSecurityHostObservationPort;
  "supply-chain"?: LiveSupplyChainObservationPort;
  "contextvm-payment-model"?: LiveContextVmPaymentModelObservationPort;
  publication?: LivePublicationObservationPort;
}>;

export type LiveProtectedRegistryInput = Readonly<{
  candidate: Candidate;
  input: CertificationInput;
  topology: unknown;
  collector: Readonly<{ collectorDigest: string; configSha256: string }>;
  releaseBinding?: ReleaseBinding;
  trustRoot?: ReleaseCertificationTrustRoot;
  ports?: LiveProtectedCertificationPorts;
}>;

/** Exact set verification is a runtime boundary: an unrecognized alias or a
 * missing suite is a failed controller configuration, never a skipped suite. */
export function assertExactLiveProtectedRegistry(registry: ProtectedCertificationAdapterRegistry): ProtectedCertificationAdapterRegistry {
  if (registry.evidenceClass !== "protected_live") throw new Error("LIVE_PROTECTED_REGISTRY_CLASS_INVALID");
  const keys = Object.keys(registry.adapters).sort();
  const expected = [...PROTECTED_SUITES].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index]) || keys.some((key) => typeof registry.adapters[key as keyof typeof registry.adapters] !== "function")) {
    throw new Error("LIVE_PROTECTED_REGISTRY_EXACT_SET_REQUIRED");
  }
  return registry;
}

/** Composes all concrete project-owned protected adapters. Ports are injected
 * beneath these adapters; neither callers nor tests may substitute a registry. */
export function createLiveProtectedCertificationRegistry(value: LiveProtectedRegistryInput): ProtectedCertificationAdapterRegistry {
  const ports = value.ports ?? {};
  const registry: ProtectedCertificationAdapterRegistry = {
    evidenceClass: "protected_live",
    adapters: {
      admission: async () => runLiveAdmissionCertification({ candidate: value.candidate, observationPort: ports.admission }),
      telemetry: async () => runLiveTelemetryCertification({ candidate: value.candidate, input: value.input, collector: value.collector, observationPort: ports.telemetry }),
      chaos: async () => runLiveChaosCertification({ candidate: value.candidate, topology: value.topology, faultPort: ports.chaos }),
      restore: async () => runLiveRestoreCertification({ candidate: value.candidate, topology: value.topology, restorePort: ports.restore }),
      "security-host": async () => runLiveSecurityHostCertification({ candidate: value.candidate, observationPort: ports["security-host"] }),
      "supply-chain": async () => runLiveSupplyChainCertification({ candidate: value.candidate, releaseBinding: value.releaseBinding, expectedArtifactSha256: value.candidate.image.slice(value.candidate.image.lastIndexOf(":") + 1), trustRoot: value.trustRoot, observationPort: ports["supply-chain"] }),
      "contextvm-payment-model": async () => runLiveContextVmPaymentModelCertification({ candidate: value.candidate, observationPort: ports["contextvm-payment-model"] }),
      publication: async () => runLivePublicationCertification({ candidate: value.candidate, observationPort: ports.publication }),
    },
  };
  return assertExactLiveProtectedRegistry(registry);
}

/** Digest-pinned generated bundles export this project-owned registry shape.
 * Without controller-injected ports every adapter blocks before any effect. */
export const protectedCertificationAdapters: ProtectedCertificationAdapterRegistry = createLiveProtectedCertificationRegistry({
  candidate: { id: "0".repeat(64), provider: "modal", image: `napplet-cvm/worker@sha256:${"0".repeat(64)}`, sourceSha256: "0".repeat(64) },
  input: { datasetSha256: "0".repeat(64), profileSha256: "0".repeat(64), topologySha256: "0".repeat(64), command: ["blocked"] },
  topology: {},
  collector: { collectorDigest: `sha256:${"0".repeat(64)}`, configSha256: "0".repeat(64) },
});
