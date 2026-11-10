import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { measureProductionCollectorImage, observeUploadedCollectorRegistryImage, prepareProductionCollectorImage } from "../../src/release/collector-image";
import { deriveReleaseTopology } from "../../src/release/topology";

const root = new URL("../..", import.meta.url).pathname;
const sha256 = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

test("clean collector builds preserve exact OCI bytes across checkout timestamps", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "napplet-cvm-collector-repro-"));
  try {
    const copies = [join(temporary, "older"), join(temporary, "newer")];
    for (const [index, directory] of copies.entries()) for (const path of ["infra/production/collector.Dockerfile", "infra/otel/collector.yaml"]) {
      await mkdir(dirname(join(directory, path)), { recursive: true });
      await cp(join(root, path), join(directory, path));
      const timestamp = index === 0 ? 1_600_000_000 : 1_900_000_000;
      await utimes(join(directory, path), timestamp, timestamp);
    }
    const results = [];
    for (const [index, directory] of copies.entries()) results.push(await prepareProductionCollectorImage({ repositoryRoot: directory, registryTarget: "registry.example/napplet-cvm/collector", artifactDirectory: join(temporary, `oci-${index}`) }));
    expect(results[0]!.localOciManifestDigest).toBe(results[1]!.localOciManifestDigest);
    expect(results[0]!.localOciConfigDigest).toBe(results[1]!.localOciConfigDigest);
    expect(results[0]!.ociLayoutSha256).toBe(results[1]!.ociLayoutSha256);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

async function command(argv: readonly string[], cwd = root) {
  const child = Bun.spawn([...argv], { cwd, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

test("local collector build measures the derived immutable image and embeds the shipped config", async () => {
  const measured = await measureProductionCollectorImage({ repositoryRoot: root });
  expect(measured.imageReference).toMatch(/^oci-layout@sha256:[a-f0-9]{64}$/u);
  expect(measured.imageReference).not.toMatch(/^otel\/opentelemetry-collector@/u);
  expect(measured.baseImage).toMatch(/^otel\/opentelemetry-collector@sha256:[a-f0-9]{64}$/u);
  expect(measured.collectorConfigSha256).toBe(sha256(await readFile(join(root, "infra/otel/collector.yaml"))));

  const created = await command(["docker", "container", "create", measured.buildTag]);
  expect(created.code, created.stderr).toBe(0);
  const container = created.stdout.trim();
  const destination = await mkdtemp(join(tmpdir(), "napplet-cvm-collector-image-"));
  try {
    const copied = await command(["docker", "cp", `${container}:/etc/otelcol/config.yaml`, join(destination, "collector.yaml")]);
    expect(copied.code, copied.stderr).toBe(0);
    expect(sha256(await readFile(join(destination, "collector.yaml")))).toBe(measured.collectorConfigSha256);
  } finally {
    await command(["docker", "rm", "-f", container]);
    await rm(destination, { recursive: true, force: true });
  }
});

test("retains exact OCI bytes before authorization and requires an authenticated observation after upload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "napplet-cvm-collector-oci-fact-"));
  try {
    const prepared = await prepareProductionCollectorImage({ repositoryRoot: root, registryTarget: "registry.example/napplet-cvm/collector", artifactDirectory: directory });
    expect(prepared.registryAvailability).toBe("not_uploaded");
    expect(sha256(await readFile(prepared.ociLayoutPath))).toBe(prepared.ociLayoutSha256);
    const collector = await observeUploadedCollectorRegistryImage(prepared, {
      async observeUploadedManifest(input) {
        return { ...input, observedAtMs: 1 };
      },
    });
    const topology = await deriveReleaseTopology("a".repeat(64), collector);
    expect(topology.controlPlane.collectorImage).toBe(collector.imageReference);
    expect(topology.controlPlane.collectorBuild).toMatchObject({
      baseImage: "otel/opentelemetry-collector@sha256:6ed874ea083d67a3085acfc75343f2ad11d9abe6006d7ea4a16e2dba9af14e49",
      manifestDigest: collector.localOciManifestDigest.slice(7),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
