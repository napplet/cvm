import { expect, test } from "bun:test";
import { NonGoogleCoolifyDriver } from "../../src/production/non-google-coolify-driver";
import { NonGooglePostgresDriver } from "../../src/production/non-google-postgres";
import { NonGoogleSigNozDriver } from "../../src/production/non-google-signoz-driver";

const digest = "a".repeat(64);
const image = `sha256:${digest}`;
const ids = { serverUuid: "11111111-1111-4111-8111-111111111111", projectUuid: "22222222-2222-4222-8222-222222222222", environmentUuid: "33333333-3333-4333-8333-333333333333" };

test("native non-Google driver construction resolves no secret, opens no PG pool, and calls no endpoint", () => {
  let secrets = 0, pools = 0, requests = 0;
  new NonGooglePostgresDriver({ host: "postgres.private", port: 5432, database: "napplet", user: "core", passwordPath: "/run/secrets/core", ssl: true }, { async open() { pools++; throw new Error("UNREACHED"); } }, async () => { secrets++; return "secret"; });
  new NonGoogleCoolifyDriver({ baseOrigin: "https://coolify.private", ...ids, postgres17Image: image, restorerImage: image, namePrefix: "restore", tokenPath: "/run/secrets/coolify" }, async () => { requests++; throw new Error("UNREACHED"); }, async () => { secrets++; return "token"; });
  new NonGoogleSigNozDriver({ baseOrigin: "https://signoz.private", ingestionKeyPath: "/run/secrets/otlp", queryKeyPath: "/run/secrets/query", collectorConfigSha256: digest, serviceName: "napplet-core", queryTemplateVersion: "v1" }, async () => { requests++; throw new Error("UNREACHED"); }, async () => { secrets++; return "key"; });
  expect({ secrets, pools, requests }).toEqual({ secrets: 0, pools: 0, requests: 0 });
});

test("Coolify and SigNoz drivers use documented authenticated native paths only after operation", async () => {
  const calls: Array<{ url: string; method: string }> = [];
  const http = async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET" });
    if (String(url).includes("query_range")) return new Response(JSON.stringify({ data: { series: [{ version: "admission-lifecycle-v1", correlationDigest: `sha256:${digest}`, stage: "generation", monotonicMs: 1 }] } }), { status: 200 });
    return new Response(JSON.stringify({ uuid: "44444444-4444-4444-8444-444444444444", status: "running", image: "postgres:17" }), { status: 200 });
  };
  const coolify = new NonGoogleCoolifyDriver({ baseOrigin: "https://coolify.private", ...ids, postgres17Image: image, restorerImage: image, namePrefix: "restore", tokenPath: "/run/secrets/coolify" }, http, async () => "token");
  await expect(coolify.createPostgres("fresh-one")).resolves.toMatchObject({ uuid: "44444444-4444-4444-8444-444444444444" });
  const signoz = new NonGoogleSigNozDriver({ baseOrigin: "https://signoz.private", ingestionKeyPath: "/run/secrets/otlp", queryKeyPath: "/run/secrets/query", collectorConfigSha256: digest, serviceName: "napplet-core", queryTemplateVersion: "v1" }, http, async () => "key");
  await expect(signoz.queryRange({ start: 1, end: 2, candidateSha256: digest, topologySha256: "b".repeat(64) })).resolves.toMatchObject({ metricSeriesCount: 1 });
  expect(calls).toEqual([{ url: "https://coolify.private/api/v1/databases/postgresql", method: "POST" }, { url: "https://signoz.private/api/v5/query_range", method: "POST" }]);
});
