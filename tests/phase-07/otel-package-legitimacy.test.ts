import { expect, test } from "bun:test";
import { mkdtemp, cp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  COLLECTOR_BASE_IMAGE,
  OFFICIAL_OTEL_PACKAGES,
  OtelPackageApprovalSchema,
  verifyApprovedOtelPackageSet,
  verifyOfficialOtelPackageSet,
  writeOtelApprovalRenewalReview,
} from "../../scripts/verify-phase-07-otel-packages";

const repositoryRoot = new URL("../..", import.meta.url).pathname;
const packageJsonPath = `${repositoryRoot}/package.json`;
const bunLockPath = `${repositoryRoot}/bun.lock`;
const approvalPointerPath = `${repositoryRoot}/evidence/certification/phase-07-otel-package-approval.json`;
const scriptPath = `${repositoryRoot}/scripts/verify-phase-07-otel-packages.ts`;

async function approvalFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "napplet-cvm-otel-approval-"));
  await Promise.all([
    cp(packageJsonPath, join(root, "package.json")),
    cp(bunLockPath, join(root, "bun.lock")),
    cp(`${repositoryRoot}/infra/otel/collector.yaml`, join(root, "infra/otel/collector.yaml"), { recursive: true }),
    cp(`${repositoryRoot}/infra/production/collector.Dockerfile`, join(root, "infra/production/collector.Dockerfile"), { recursive: true }),
    cp(`${repositoryRoot}/evidence/certification`, join(root, "evidence/certification"), { recursive: true }),
  ]);
  return root;
}

async function approvalCli(root: string, flag = "--require-approved"): Promise<{ code: number; stdout: string; stderr: string }> {
  const process = Bun.spawn(["bun", scriptPath, flag], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
  return { code, stdout, stderr };
}

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
  const digest = await crypto.subtle.digest("SHA-512", new Uint8Array(bytes));
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
    return tarball ? new Response(new Uint8Array(tarball.tarball), { status: 200 }) : new Response("not found", { status: 404 });
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

test("pins the Collector recipe base by immutable digest rather than a mutable tag", () => {
  expect(COLLECTOR_BASE_IMAGE).toMatch(/^otel\/opentelemetry-collector@sha256:[a-f0-9]{64}$/u);
  expect(COLLECTOR_BASE_IMAGE).not.toContain(":latest");
});

test("delegated approval is a separate immutable decision over the exact pending audit", async () => {
  const root = await approvalFixture();
  try {
    const pointer = JSON.parse(await readFile(join(root, "evidence/certification/phase-07-otel-package-audit.json"), "utf8"));
    expect(pointer.approvalStatus).toBe("pending_human");
    const approvalPointer = JSON.parse(await readFile(join(root, "evidence/certification/phase-07-otel-package-approval.json"), "utf8"));
    const record = JSON.parse(await readFile(join(root, "evidence/certification", approvalPointer.record), "utf8"));
    const { evidenceSha256, ...approvalPayload } = record;
    const approval = OtelPackageApprovalSchema.parse(approvalPayload);
    expect(evidenceSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(approval.approvalStatus).toBe("approved_operator");
    expect(approval.authority).toBe("delegated_operator");
    expect(approval.scope).toEqual(["disposable_bun_collector_smoke", "exact_root_package_pins"]);
    expect(approval.limitations).toContain("This decision is not direct-human review or signer provenance.");
    // This current immutable decision is valid only for the exact copied root
    // inputs; mutations are covered below.
    await expect(verifyApprovedOtelPackageSet({ repositoryRoot: root })).resolves.toMatchObject({ approvalDigest: approvalPointer.evidenceSha256 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("approval, pending, rejected, and drift records fail closed before approval-dependent effects", async () => {
  const mutations: ReadonlyArray<{ readonly name: string; readonly mutate: (root: string) => Promise<void>; readonly error: RegExp }> = [
    { name: "missing pointer", mutate: async (root) => { await rm(join(root, "evidence/certification/phase-07-otel-package-approval.json")); }, error: /APPROVAL_POINTER_REQUIRED/ },
    { name: "pending decision", mutate: async (root) => { const path = join(root, "evidence/certification/phase-07-otel-package-approval.json"); const value = JSON.parse(await readFile(path, "utf8")); value.approvalStatus = "pending_human"; await writeFile(path, JSON.stringify(value)); }, error: /APPROVAL_POINTER_INVALID/ },
    { name: "pointer substitution", mutate: async (root) => { const path = join(root, "evidence/certification/phase-07-otel-package-approval.json"); const value = JSON.parse(await readFile(path, "utf8")); value.auditEvidenceSha256 = "0".repeat(64); await writeFile(path, JSON.stringify(value)); }, error: /APPROVAL_POINTER_AUDIT_DRIFT/ },
    { name: "record mutation", mutate: async (root) => { const pointer = JSON.parse(await readFile(join(root, "evidence/certification/phase-07-otel-package-approval.json"), "utf8")); const path = join(root, "evidence/certification", pointer.record); const value = JSON.parse(await readFile(path, "utf8")); value.limitations.push("mutated"); await writeFile(path, JSON.stringify(value)); }, error: /APPROVAL_RECORD_DIGEST_MISMATCH/ },
    { name: "package drift", mutate: async (root) => { const pointer = JSON.parse(await readFile(join(root, "evidence/certification/phase-07-otel-package-approval.json"), "utf8")); const path = join(root, "evidence/certification", pointer.record); const value = JSON.parse(await readFile(path, "utf8")); value.packages[0].version = "9.9.9"; await writeFile(path, JSON.stringify(value)); }, error: /APPROVAL_RECORD_DIGEST_MISMATCH|APPROVAL_PACKAGE_SET_DRIFT/ },
    { name: "integrity drift", mutate: async (root) => { const pointer = JSON.parse(await readFile(join(root, "evidence/certification/phase-07-otel-package-approval.json"), "utf8")); const path = join(root, "evidence/certification", pointer.record); const value = JSON.parse(await readFile(path, "utf8")); value.packages[0].registryIntegrity = "sha512-drift"; await writeFile(path, JSON.stringify(value)); }, error: /APPROVAL_RECORD_DIGEST_MISMATCH|APPROVAL_PACKAGE_SET_DRIFT/ },
    { name: "input drift", mutate: async (root) => { await writeFile(join(root, "package.json"), `${await readFile(join(root, "package.json"), "utf8")}\n`); }, error: /APPROVAL_INPUT_DIGEST_DRIFT/ },
  ];
  for (const mutation of mutations) {
    const root = await approvalFixture();
    try {
      await mutation.mutate(root);
      await expect(verifyApprovedOtelPackageSet({ repositoryRoot: root })).rejects.toThrow(mutation.error);
      const approval = await approvalCli(root);
      const pins = await approvalCli(root, "--verify-root-pins");
      expect(approval.code, mutation.name).not.toBe(0);
      expect(pins.code, mutation.name).not.toBe(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("approval-dependent root pins pass only for the current delegated approval", async () => {
  const approved = await approvalCli(repositoryRoot);
  const pins = await approvalCli(repositoryRoot, "--verify-root-pins");
  expect(approved.code).toBe(0);
  expect(pins.code).toBe(0);
});

test("a current-root renewal review measures the derived image without rewriting historic approval authority", async () => {
  const root = await approvalFixture();
  try {
    const approvalBefore = await readFile(join(root, "evidence/certification/phase-07-otel-package-approval.json"), "utf8");
    await writeFile(join(root, "package.json"), `${await readFile(join(root, "package.json"), "utf8")}\n`);
    const result = await writeOtelApprovalRenewalReview({ repositoryRoot: root });
    expect(result.evidenceSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.review).toMatchObject({ status: "approval_required", kind: "otel_approval_renewal_preapproval" });
    expect(result.review.collector.imageReference).toMatch(/^oci-layout@sha256:[a-f0-9]{64}$/u);
    expect(result.review.limitations).toContain("A new delegated operator approval is required before any approval-dependent command may proceed.");
    expect(await readFile(join(root, "evidence/certification/phase-07-otel-package-approval.json"), "utf8")).toBe(approvalBefore);
    expect(JSON.parse(await readFile(result.recordPath, "utf8"))).toMatchObject({ evidenceSha256: result.evidenceSha256, status: "approval_required" });
    await expect(verifyApprovedOtelPackageSet({ repositoryRoot: root })).rejects.toThrow("APPROVAL_INPUT_DIGEST_DRIFT");
  } finally { await rm(root, { recursive: true, force: true }); }
});
