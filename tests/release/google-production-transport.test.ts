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


test("both regional control and Collector quantities include their actual three-instance CPU and memory profiles", async () => {
  const topology = await deriveReleaseTopology("c".repeat(64));
  for (const provider of ["cloud_run", "collector"]) {
    const components = topology.quantityContract.filter(line => line.provider === provider);
    expect(components).toHaveLength(4);
    for (const region of ["europe-west1", "us-central1"]) {
      expect(components.find(line => line.componentId === provider + "." + region + ".cpu")).toMatchObject({ region, unit: "worker-second", quantityNanos: "2700000000000" });
      expect(components.find(line => line.componentId === provider + "." + region + ".memory")).toMatchObject({ region, unit: "gibibyte-second", quantityNanos: "1350000000000" });
    }
  }
  expect(new Set(topology.quantityContract.map(line => line.provider)).size).toBe(16);
});
