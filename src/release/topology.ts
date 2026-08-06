import { canonicalJson } from "../promotion/schema";
import { ReleaseTopologyObservationSchema, type ReleaseTopologyObservation } from "./contracts";

export const RELEASE_PROVIDER_IDS = [
  "cloud_run", "gcs", "collector", "cloud_sql_postgres", "modal", "fly",
  "contextvm", "cep8_lightning", "cashu", "model", "compatible_host", "signer",
  "promoted_cli", "upload", "owner_relay", "attestation_relay",
] as const;

export type ReleaseTopologyQuantity = Readonly<{ provider: typeof RELEASE_PROVIDER_IDS[number]; unit: string; quantityNanos: bigint; headroomBasisPoints: number }>;

/** All quantities are mechanical bounds, never a price-derived or uniform map.
 * Worker prices are per 100 seconds so decimal official rates remain exact USD micros. */
export const RELEASE_TOPOLOGY_QUANTITY_CONTRACT: readonly ReleaseTopologyQuantity[] = Object.freeze([
  { provider: "cloud_run", unit: "worker-second", quantityNanos: 5_400_000_000_000n, headroomBasisPoints: 1_000 },
  { provider: "gcs", unit: "gibibyte-day", quantityNanos: 900_000_000_000n, headroomBasisPoints: 1_000 },
  { provider: "collector", unit: "worker-second", quantityNanos: 1_800_000_000_000n, headroomBasisPoints: 1_000 },
  { provider: "cloud_sql_postgres", unit: "database-second", quantityNanos: 900_000_000_000n, headroomBasisPoints: 1_000 },
  { provider: "modal", unit: "worker-100-seconds", quantityNanos: 18_000_000_000n, headroomBasisPoints: 1_000 },
  { provider: "fly", unit: "worker-100-seconds", quantityNanos: 18_000_000_000n, headroomBasisPoints: 1_000 },
  { provider: "contextvm", unit: "operation", quantityNanos: 1_000_000_000n, headroomBasisPoints: 0 },
  { provider: "cep8_lightning", unit: "operation", quantityNanos: 2_000_000_000n, headroomBasisPoints: 1_000 },
  { provider: "cashu", unit: "operation", quantityNanos: 2_000_000_000n, headroomBasisPoints: 1_000 },
  { provider: "model", unit: "operation", quantityNanos: 4_000_000_000n, headroomBasisPoints: 1_000 },
  { provider: "compatible_host", unit: "operation", quantityNanos: 2_000_000_000n, headroomBasisPoints: 0 },
  { provider: "signer", unit: "operation", quantityNanos: 1_000_000_000n, headroomBasisPoints: 0 },
  { provider: "promoted_cli", unit: "operation", quantityNanos: 2_000_000_000n, headroomBasisPoints: 0 },
  { provider: "upload", unit: "operation", quantityNanos: 2_000_000_000n, headroomBasisPoints: 0 },
  { provider: "owner_relay", unit: "operation", quantityNanos: 2_000_000_000n, headroomBasisPoints: 0 },
  { provider: "attestation_relay", unit: "operation", quantityNanos: 2_000_000_000n, headroomBasisPoints: 0 },
]);

const COLLECTOR_IMAGE = "otel/opentelemetry-collector@sha256:6ed874ea083d67a3085acfc75343f2ad11d9abe6006d7ea4a16e2dba9af14e49";

async function digest(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Desired topology is owned by the project. Candidate bytes bind it, but never select it. */
export async function deriveReleaseTopology(candidateSha256: string): Promise<ReleaseTopologyObservation> {
  const base = {
    version: 1 as const,
    candidateSha256,
    controlPlane: {
      regions: ["europe-west1", "us-central1"] as [string, string],
      minimumInstancesPerRegion: 3 as const,
      collectorImage: COLLECTOR_IMAGE,
    },
    objectStore: { dualRegion: "nam4", versioning: true as const, retentionDays: 30 as const },
    database: { authority: "cloud_sql_postgres" as const, serializable: true as const },
    workerCandidates: ["modal", "fly"] as ["modal", "fly"],
    integrations: ["contextvm", "cep8_lightning", "cashu", "model", "compatible_host", "signer", "promoted_cli", "upload", "owner_relay", "attestation_relay"] as const,
    quantityContract: RELEASE_TOPOLOGY_QUANTITY_CONTRACT.map((line) => ({ ...line, quantityNanos: line.quantityNanos.toString() })),
  };
  const topologySha256 = await digest(base);
  const { quantityContract: _quantityContract, ...schemaInput } = base;
  const parsed = ReleaseTopologyObservationSchema.parse({ ...schemaInput, topologySha256 });
  return Object.freeze({ ...parsed, quantityContract: RELEASE_TOPOLOGY_QUANTITY_CONTRACT }) as ReleaseTopologyObservation & Readonly<{ quantityContract: readonly ReleaseTopologyQuantity[] }>;
}
