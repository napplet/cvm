import { expect, test } from "bun:test";
import { deriveReleaseTopology } from "../../src/release/topology";

test("production topology has two three-warm Cloud Run regions and one regional-HA Cloud SQL authority", async () => {
  const topology = await deriveReleaseTopology("a".repeat(64));
  expect(topology.controlPlane).toMatchObject({ regions: ["europe-west1", "us-central1"], minimumInstancesPerRegion: 3 });
  expect(topology.database).toEqual({ authority: "cloud_sql_postgres", serializable: true, region: "europe-west1", availabilityType: "regional", authorityCount: 1 });
  const database = topology.quantityContract.filter((line) => line.provider === "cloud_sql_postgres");
  expect(database).toHaveLength(1);
  expect(database[0]).toMatchObject({ componentId: "cloud_sql_postgres.europe-west1.regional-ha", region: "europe-west1" });
});

test("GCS policy declares nam4 versioning, KMS requirement, and distinct lifecycle retention", async () => {
  const topology = await deriveReleaseTopology("b".repeat(64));
  expect(topology.objectStore).toEqual({ dualRegion: "nam4", versioning: true, retentionDays: 30, encryption: "customer-managed-key-required", lifecycle: "delete-after-30-days" });
});
