import { expect, test } from "bun:test";
import { DeterministicObjectStore } from "../../src/continuity/object-store";
import { createMemoryGoogleOperationJournal } from "../../src/release/deployment/google-clients";
import { PostgresOperationJournal } from "../../src/release/deployment/postgres-operation-journal";
import { createMountedBigQueryUsageReporter, MountedBigQueryUsageReportConfigurationSchema } from "../../src/production/mounted-authoritative-billing";

const digest = (letter: string) => letter.repeat(64);
const configuration = {
  version: 1 as const,
  detailedExportTable: "project-12345.billing_export.gcp_billing_export_resource_v1_ABC",
  location: "US",
  maximumBytesBilled: "1000000",
  reportQueryMaximumCostMicros: 10,
  reportQueryPriceSourceSha256: digest("a"),
  reportQueryMicrosPerByteNumerator: "1",
  reportQueryMicrosPerByteDenominator: "1000000",
  collectorSha256: digest("b"),
  maximumIntervalMs: 60_000,
};

test("mounted billing configuration rejects arbitrary report transport facts", () => {
  expect(MountedBigQueryUsageReportConfigurationSchema.parse(configuration)).toEqual(configuration);
  expect(() => MountedBigQueryUsageReportConfigurationSchema.parse({ ...configuration, endpoint: "https://attacker.example/report" })).toThrow();
  expect(() => MountedBigQueryUsageReportConfigurationSchema.parse({ ...configuration, detailedExportTable: "other-project.billing_export.table" })).not.toThrow();
});

test("mounted reporter holds before any provider query when no original completed native resource exists", async () => {
  let connected = 0;
  const objects = new DeterministicObjectStore();
  const unrelated = await objects.createImmutable({ key: "checkpoints/another-session", bytes: new TextEncoder().encode("private checkpoint") });
  const reporter = createMountedBigQueryUsageReporter({
    configuration, projectId: "project-12345", quotaProjectId: "project-12345", principal: "release@example.com", accountScopeSha256: digest("c"),
    tokenSource: { async getAccessToken() { throw new Error("must not request ADC before original journal proof"); } },
    googleJournal: createMemoryGoogleOperationJournal(),
    billingJournal: new PostgresOperationJournal({ async connect() { connected++; throw new Error("must not write report journal"); } }, { namespace: "mounted-billing-test", scopeSha256: digest("d") }),
    pool: { async connect() { connected++; throw new Error("must not write capture table"); } },
    objects, bucket: "napplet-cvm-test-bucket", now: () => 10_000,
  });
  expect(await reporter.readArtifact({ uri: `gs://napplet-cvm-test-bucket/${unrelated.key}`, generation: String(unrelated.generation), sha256: unrelated.checksum })).toBeUndefined();
  await expect(reporter.capture({ operation: { provider: "cloud_run", operationId: "op-cloud-run-1" }, operationRecordSha256: digest("e"), resourceIdentitySha256: digest("f"), candidateSha256: digest("1"), authorizationRequestSha256: digest("2"), authorizationReceiptSha256: digest("3"), accountScopeSha256: digest("4"), projectScopeSha256: digest("5") })).resolves.toEqual({ status: "held" });
  expect(connected).toBe(0);
});
