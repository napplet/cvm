import { expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import {
  OFFICIAL_OTEL_PACKAGES,
  verifyOfficialOtelPackageSet,
} from "../../scripts/verify-phase-07-otel-packages";

const repositoryRoot = new URL("../..", import.meta.url).pathname;
const packageJsonPath = `${repositoryRoot}/package.json`;
const bunLockPath = `${repositoryRoot}/bun.lock`;

function tarHeader(name: string, size: number): Uint8Array {
  const header = new Uint8Array(512);
  new TextEncoder().encodeInto(name, header);
  new TextEncoder().encodeInto(size.toString(8).padStart(11, "0"), header.subarray(124));
  header[124 + 11] = 0;
  header[156] = "0".charCodeAt(0);
  new TextEncoder().encodeInto("ustar", header.subarray(257));
  return header;
}

function packageTarball(body: Record<string, unknown>): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(body));
  const blocks = Math.ceil(payload.length / 512);
  const tar = new Uint8Array(512 + blocks * 512 + 1024);
  tar.set(tarHeader("package/package.json", payload.length));
  tar.set(payload, 512);
  return gzipSync(tar);
}

async function sha512SRI(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-512", bytes);
  return `sha512-${Buffer.from(digest).toString("base64")}`;
}

async function fixtureFetch(mutator?: (metadata: Record<string, unknown>, index: number) => void) {
  const tarballs = await Promise.all(OFFICIAL_OTEL_PACKAGES.map(async (item, index) => {
    const tarball = packageTarball({
      name: item.name,
      version: item.version,
      license: "Apache-2.0",
      repository: { type: "git", url: "git+https://github.com/open-telemetry/opentelemetry-js.git" },
      scripts: { test: "node test.js" },
      dependencies: item.requiredDependencies,
    });
    return { item, index, tarball, integrity: await sha512SRI(tarball) };
  }));
  const fetcher = (async (input: string | URL) => {
    const url = String(input);
    const entry = tarballs.find(({ item }) => url.endsWith(`/${encodeURIComponent(item.name)}/${item.version}`));
    if (entry) {
      const metadata: Record<string, unknown> = {
        name: entry.item.name,
        version: entry.item.version,
        dist: { integrity: entry.integrity, tarball: `https://registry.npmjs.org/${encodeURIComponent(entry.item.name)}/-/${entry.item.name.split("/").at(-1)}-${entry.item.version}.tgz` },
        repository: { type: "git", url: "git+https://github.com/open-telemetry/opentelemetry-js.git" },
        license: "Apache-2.0",
        gitHead: "a".repeat(40),
        _npmUser: { name: "GitHub Actions", email: "npm-oidc-no-reply@github.com" },
        scripts: { test: "node test.js" },
        dependencies: entry.item.requiredDependencies,
      };
      mutator?.(metadata, entry.index);
      return new Response(JSON.stringify(metadata), { status: 200 });
    }
    const published = tarballs.find(({ item }) => url.endsWith(`/${encodeURIComponent(item.name)}`));
    if (published) return new Response(JSON.stringify({ time: { [published.item.version]: `${published.item.publishedOn}T00:00:00.000Z` } }), { status: 200 });
    const tarball = tarballs.find(({ item }) => url.endsWith(`/${item.name.split("/").at(-1)}-${item.version}.tgz`));
    return tarball ? new Response(tarball.tarball, { status: 200 }) : new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetcher, expectedPackages: tarballs.map(({ item, integrity }) => ({ ...item, integrity })) };
}

test("requires all six exact official OpenTelemetry package identities and preserves SUS", async () => {
  const fixture = await fixtureFetch();
  const result = await verifyOfficialOtelPackageSet({ fetch: fixture.fetcher, expectedPackages: fixture.expectedPackages });
  expect(result.status).toBe("passed");
  expect(result.packages).toHaveLength(6);
  expect(result.packages.filter((entry) => entry.disposition === "SUS")).toHaveLength(5);
  expect(result.approvalStatus).toBe("pending_human");
  expect(result.limitations).toContain("Bun and Collector runtime compatibility is pending execution.");
});

test("fails closed for identity, repository, integrity, license, lifecycle, range, and unexpected package mutation", async () => {
  for (const mutate of [
    (metadata: Record<string, unknown>) => { metadata.version = "2.10.1"; },
    (metadata: Record<string, unknown>) => { metadata.repository = { url: "https://example.invalid/not-official" }; },
    (metadata: Record<string, unknown>) => { metadata.dist = { ...(metadata.dist as Record<string, unknown>), integrity: "sha512-bad" }; },
    (metadata: Record<string, unknown>) => { metadata.license = "MIT"; },
    (metadata: Record<string, unknown>) => { metadata.scripts = { postinstall: "unsafe" }; },
    (metadata: Record<string, unknown>) => { metadata.dependencies = { "@opentelemetry/resources": "latest" }; },
  ]) {
    const fixture = await fixtureFetch(mutate);
    const result = await verifyOfficialOtelPackageSet({ fetch: fixture.fetcher, expectedPackages: fixture.expectedPackages });
    expect(result.status).toBe("failed");
  }
  const unexpected = [...OFFICIAL_OTEL_PACKAGES, { ...OFFICIAL_OTEL_PACKAGES[0]!, name: "@opentelemetry/unexpected" }];
  const fixture = await fixtureFetch();
  const result = await verifyOfficialOtelPackageSet({ fetch: fixture.fetcher, expectedPackages: unexpected });
  expect(result.status).toBe("failed");
});

test("is no-install: repository dependency manifests and node_modules are unchanged", async () => {
  const before = await Promise.all([Bun.file(packageJsonPath).text(), Bun.file(bunLockPath).text()]);
  const fixture = await fixtureFetch();
  const result = await verifyOfficialOtelPackageSet({ fetch: fixture.fetcher, expectedPackages: fixture.expectedPackages });
  const after = await Promise.all([Bun.file(packageJsonPath).text(), Bun.file(bunLockPath).text()]);
  expect(result.status).toBe("passed");
  expect(after).toEqual(before);
});
