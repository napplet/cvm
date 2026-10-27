import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { measureProductionCollectorImage } from "../../src/release/collector-image";
import { deriveReleaseTopology } from "../../src/release/topology";

const root = new URL("../..", import.meta.url).pathname;
const sha256 = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

async function command(argv: readonly string[], cwd = root) {
  const child = Bun.spawn([...argv], { cwd, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

test("local collector build measures the derived immutable image and embeds the shipped config", async () => {
  const measured = await measureProductionCollectorImage({ repositoryRoot: root });
  expect(measured.imageReference).toMatch(/^local\/napplet-cvm-collector@sha256:[a-f0-9]{64}$/u);
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

test("release topology binds the locally measured derived collector rather than its upstream base", async () => {
  const topology = await deriveReleaseTopology("a".repeat(64));
  expect(topology.controlPlane.collectorImage).toMatch(/^local\/napplet-cvm-collector@sha256:[a-f0-9]{64}$/u);
  expect(topology.controlPlane.collectorBuild).toMatchObject({
    baseImage: "otel/opentelemetry-collector@sha256:6ed874ea083d67a3085acfc75343f2ad11d9abe6006d7ea4a16e2dba9af14e49",
    imageDigest: topology.controlPlane.collectorImage.slice("local/napplet-cvm-collector@sha256:".length),
  });
});
