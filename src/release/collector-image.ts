import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const BASE_IMAGE = "otel/opentelemetry-collector@sha256:6ed874ea083d67a3085acfc75343f2ad11d9abe6006d7ea4a16e2dba9af14e49";
const IMAGE_ID = /^sha256:([a-f0-9]{64})$/iu;

export type CollectorImageMeasurement = Readonly<{
  /** A local-only content reference. It is evidence, never a registry target. */
  imageReference: string;
  imageDigest: string;
  buildTag: string;
  baseImage: string;
  dockerfileSha256: string;
  collectorConfigSha256: string;
}>;

export type CollectorImageCommand = (argv: readonly string[], cwd: string) => Promise<Readonly<{ code: number; stdout: string; stderr: string }>>;

const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

async function defaultCommand(argv: readonly string[], cwd: string) {
  const child = Bun.spawn([...argv], { cwd, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

/**
 * Builds the project recipe locally and measures the resulting image ID.  The
 * derived image is intentionally represented as `local/...`: no code using
 * this fact may accidentally deploy, pull, or push a public bare upstream
 * collector image in place of the configured image.
 */
export async function measureProductionCollectorImage(input: Readonly<{
  repositoryRoot: string;
  command?: CollectorImageCommand;
}>): Promise<CollectorImageMeasurement> {
  const root = resolve(input.repositoryRoot);
  const [dockerfile, config] = await Promise.all([
    readFile(resolve(root, "infra/production/collector.Dockerfile")),
    readFile(resolve(root, "infra/otel/collector.yaml")),
  ]);
  const dockerfileSha256 = sha256(dockerfile);
  const collectorConfigSha256 = sha256(config);
  const expectedFrom = `FROM ${BASE_IMAGE}`;
  if (!dockerfile.toString("utf8").split(/\r?\n/u).some((line) => line.trim() === expectedFrom)
    || !dockerfile.toString("utf8").includes("COPY --chmod=0444 infra/otel/collector.yaml /etc/otelcol/config.yaml")) {
    throw new Error("COLLECTOR_RECIPE_BINDING_INVALID");
  }
  const buildTag = `napplet-cvm-collector:local-${dockerfileSha256.slice(0, 16)}-${collectorConfigSha256.slice(0, 16)}`;
  const command = input.command ?? defaultCommand;
  const build = await command(["docker", "build", "--pull=false", "--file", "infra/production/collector.Dockerfile", "--tag", buildTag, "."], root);
  if (build.code !== 0) throw new Error("COLLECTOR_LOCAL_BUILD_FAILED");
  const inspected = await command(["docker", "image", "inspect", "--format", "{{.Id}}", buildTag], root);
  const match = inspected.code === 0 ? IMAGE_ID.exec(inspected.stdout.trim()) : null;
  if (!match) throw new Error("COLLECTOR_IMAGE_ID_UNAVAILABLE");
  const imageDigest = match[1]!.toLowerCase();
  return Object.freeze({
    imageReference: `local/napplet-cvm-collector@sha256:${imageDigest}`,
    imageDigest,
    buildTag,
    baseImage: BASE_IMAGE,
    dockerfileSha256,
    collectorConfigSha256,
  });
}

export function isMeasuredCollectorImageReference(value: string): boolean {
  return /^local\/napplet-cvm-collector@sha256:[a-f0-9]{64}$/iu.test(value);
}
