import { CLOUD_RUN_CERTIFICATION_CPU_SECONDS_NANOS, CLOUD_RUN_CERTIFICATION_MEMORY_GIB_SECONDS_NANOS } from "./deployment/cloud-run-resource-profile";
import { canonicalJson } from "../promotion/schema";
import { ReleaseTopologyObservationSchema, type ReleaseTopologyObservation } from "./contracts";
import type { ObservedCollectorRegistryImage, PreparedCollectorImage } from "./collector-image";

export const RELEASE_PROVIDER_IDS = [
  "cloud_run", "gcs", "collector", "cloud_sql_postgres", "modal", "fly",
  "contextvm", "cep8_lightning", "cashu", "model", "compatible_host", "signer",
  "promoted_cli", "upload", "owner_relay", "attestation_relay",
] as const;

export type ReleaseTopologyQuantity = Readonly<{
  provider: typeof RELEASE_PROVIDER_IDS[number];
  /** Stable, topology-owned allocation key. Catalogs cannot create one. */
  componentId: string;
  /** A deployment region or an explicit non-regional scope such as nam4/global. */
  region: string;
  unit: string;
  quantityNanos: bigint;
  headroomBasisPoints: number;
}>;
export type ReleaseTopologyQuantityObservation = Readonly<Omit<ReleaseTopologyQuantity, "quantityNanos"> & { quantityNanos: string }>;

const component = (provider: ReleaseTopologyQuantity["provider"], componentId: string, region: string, unit: string, quantityNanos: bigint, headroomBasisPoints: number): ReleaseTopologyQuantity =>
  Object.freeze({ provider, componentId, region, unit, quantityNanos, headroomBasisPoints });

/** Closed pre-authorization inventory: locked 1,000 admissions per worker
 * provider plus all eight mandatory suites per provider; never an average.
 * Until admission is proven to stop before inference, every accepted sample
 * carries the full model envelope. */
/** `modelInputTokensPerOperation` is the enforced 100k UTF-8 wire-byte upper
 * bound for the canonical Interaction request, including its duplicated
 * system instruction; it is not a character-count guess. */
export const PRODUCTION_CERTIFICATION_OPERATION_INVENTORY = Object.freeze({ acceptedAdmissionSamples: 1_000, workerProviders: 2, protectedSuites: 8, workerLifetimeSeconds: 20 * 60, modelOperations: 2 * (1_000 + 8), modelInputTokensPerOperation: 100_000, modelOutputAndThoughtTokensPerOperation: 8_192 });
const WORKER_100_SECOND_UNITS = BigInt((PRODUCTION_CERTIFICATION_OPERATION_INVENTORY.acceptedAdmissionSamples + PRODUCTION_CERTIFICATION_OPERATION_INVENTORY.protectedSuites) * (PRODUCTION_CERTIFICATION_OPERATION_INVENTORY.workerLifetimeSeconds / 100));

/** Every paid allocation is explicit. The 16 public authorization families are
 * derived only after checked aggregation of this ordered contract. */
export const RELEASE_TOPOLOGY_QUANTITY_CONTRACT: readonly ReleaseTopologyQuantity[] = Object.freeze([
  component("cloud_run", "cloud_run.europe-west1.cpu", "europe-west1", "worker-second", CLOUD_RUN_CERTIFICATION_CPU_SECONDS_NANOS, 1_000),
  component("cloud_run", "cloud_run.europe-west1.memory", "europe-west1", "gibibyte-second", CLOUD_RUN_CERTIFICATION_MEMORY_GIB_SECONDS_NANOS, 1_000),
  component("cloud_run", "cloud_run.us-central1.cpu", "us-central1", "worker-second", CLOUD_RUN_CERTIFICATION_CPU_SECONDS_NANOS, 1_000),
  component("cloud_run", "cloud_run.us-central1.memory", "us-central1", "gibibyte-second", CLOUD_RUN_CERTIFICATION_MEMORY_GIB_SECONDS_NANOS, 1_000),
  component("gcs", "gcs.nam4.storage", "nam4", "gibibyte-day", 900_000_000_000n, 1_000),
  component("gcs", "gcs.nam4.operations", "nam4", "operation", 60_000_000_000n, 1_000),
  component("collector", "collector.europe-west1.cpu", "europe-west1", "worker-second", CLOUD_RUN_CERTIFICATION_CPU_SECONDS_NANOS, 1_000),
  component("collector", "collector.europe-west1.memory", "europe-west1", "gibibyte-second", CLOUD_RUN_CERTIFICATION_MEMORY_GIB_SECONDS_NANOS, 1_000),
  component("collector", "collector.us-central1.cpu", "us-central1", "worker-second", CLOUD_RUN_CERTIFICATION_CPU_SECONDS_NANOS, 1_000),
  component("collector", "collector.us-central1.memory", "us-central1", "gibibyte-second", CLOUD_RUN_CERTIFICATION_MEMORY_GIB_SECONDS_NANOS, 1_000),
  // Cloud SQL REGIONAL provides its own zonal HA. It is a single authority,
  // not one database per Cloud Run control-plane region.
  component("cloud_sql_postgres", "cloud_sql_postgres.europe-west1.regional-ha", "europe-west1", "database-second", 450_000_000_000n, 1_000),
  // Each candidate is budgeted for every admission and suite at its full
  // 10-minute active + 10-minute grace cap. Modal is hard 2 CPU/2 GiB; Fly 1/1.
  component("modal", "modal.global", "global", "worker-100-seconds", WORKER_100_SECOND_UNITS * 1_000_000_000n, 1_000),
  component("fly", "fly.global", "global", "worker-100-seconds", WORKER_100_SECOND_UNITS * 1_000_000_000n, 1_000),
  component("contextvm", "contextvm.global", "global", "operation", 1_000_000_000n, 0),
  component("cep8_lightning", "cep8_lightning.global", "global", "operation", 2_000_000_000n, 1_000),
  component("cashu", "cashu.global", "global", "operation", 2_000_000_000n, 1_000),
  // The source-priced model envelope is token based, not a made-up flat
  // per-operation rate. Input and combined output/thought remain separate so
  // the gross Vertex quote can be recomputed and actual receipts reconciled.
  /* Quantities are in ten-million-token units so their serialized nanos stay
   * below the authorization schema's safe-integer boundary while preserving
   * exact integer USD arithmetic. */
  component("model", "model.global.input", "global", "ten-million-tokens", BigInt(PRODUCTION_CERTIFICATION_OPERATION_INVENTORY.modelOperations * PRODUCTION_CERTIFICATION_OPERATION_INVENTORY.modelInputTokensPerOperation) * 100n, 1_000),
  component("model", "model.global.output-thought", "global", "ten-million-tokens", BigInt(PRODUCTION_CERTIFICATION_OPERATION_INVENTORY.modelOperations * PRODUCTION_CERTIFICATION_OPERATION_INVENTORY.modelOutputAndThoughtTokensPerOperation) * 100n, 1_000),
  component("compatible_host", "compatible_host.global", "global", "operation", 2_000_000_000n, 0),
  component("signer", "signer.global", "global", "operation", 1_000_000_000n, 0),
  component("promoted_cli", "promoted_cli.global", "global", "operation", 2_000_000_000n, 0),
  /** One bounded Artifact Registry upload/manifest observation is authorized
   * separately from the two napplet publication uploads. */
  component("upload", "upload.global", "global", "operation", 3_000_000_000n, 0),
  component("owner_relay", "owner_relay.global", "global", "operation", 2_000_000_000n, 0),
  component("attestation_relay", "attestation_relay.global", "global", "operation", 2_000_000_000n, 0),
]);

async function digest(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Desired topology is owned by the project. Candidate bytes bind it, but never select it. */
/** A prepared OCI layout supplies the immutable desired image before consent;
 * only the controller's provision gate accepts an observed registry image. */
export async function deriveReleaseTopology(candidateSha256: string, collector?: PreparedCollectorImage | ObservedCollectorRegistryImage): Promise<ReleaseTopologyObservation & Readonly<{ quantityContract: readonly ReleaseTopologyQuantityObservation[] }>> {
  const quantityContract = RELEASE_TOPOLOGY_QUANTITY_CONTRACT.map((line) => ({ ...line, quantityNanos: line.quantityNanos.toString() }));
  const base = {
    version: 1 as const,
    candidateSha256,
    controlPlane: {
      regions: ["europe-west1", "us-central1"] as [string, string],
      minimumInstancesPerRegion: 3 as const,
      collectorImage: collector?.plannedRegistryReference ?? "registry-measurement-required",
      collectorBuild: {
        ...(collector ? { manifestDigest: collector.localOciManifestDigest.slice(7), configDigest: collector.localOciConfigDigest.slice(7), baseImage: collector.baseImage, dockerfileSha256: collector.dockerfileSha256, collectorConfigSha256: collector.collectorConfigSha256 } : { baseImage: "otel/opentelemetry-collector@sha256:6ed874ea083d67a3085acfc75343f2ad11d9abe6006d7ea4a16e2dba9af14e49", dockerfileSha256: "0".repeat(64), collectorConfigSha256: "0".repeat(64) }),
      },
    },
    objectStore: { dualRegion: "nam4", versioning: true as const, retentionDays: 30 as const, encryption: "customer-managed-key-required" as const, lifecycle: "delete-after-30-days" as const },
    database: { authority: "cloud_sql_postgres" as const, serializable: true as const, region: "europe-west1", availabilityType: "regional" as const, authorityCount: 1 as const },
    workerCandidates: ["modal", "fly"] as ["modal", "fly"],
    integrations: ["contextvm", "cep8_lightning", "cashu", "model", "compatible_host", "signer", "promoted_cli", "upload", "owner_relay", "attestation_relay"] as const,
    quantityContract,
  };
  const topologySha256 = await digest(base);
  const { quantityContract: _quantityContract, ...schemaInput } = base;
  const parsed = ReleaseTopologyObservationSchema.parse({ ...schemaInput, topologySha256 });
  Object.defineProperty(parsed, "quantityContract", { value: Object.freeze(quantityContract.map(Object.freeze)), enumerable: false, configurable: false, writable: false });
  return Object.freeze(parsed) as ReleaseTopologyObservation & Readonly<{ quantityContract: readonly ReleaseTopologyQuantityObservation[] }>;
}
