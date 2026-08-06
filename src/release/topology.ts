import { canonicalJson } from "../promotion/schema";
import { ReleaseTopologyObservationSchema, type ReleaseTopologyObservation } from "./contracts";

export const RELEASE_PROVIDER_IDS = [
  "cloud_run", "gcs", "collector", "cloud_sql_postgres", "modal", "fly",
  "contextvm", "cep8_lightning", "cashu", "model", "compatible_host", "signer",
  "promoted_cli", "upload", "owner_relay", "attestation_relay",
] as const;

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
  };
  return ReleaseTopologyObservationSchema.parse({ ...base, topologySha256: await digest(base) });
}
