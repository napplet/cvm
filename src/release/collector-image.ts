import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const COLLECTOR_BASE_IMAGE = "otel/opentelemetry-collector@sha256:6ed874ea083d67a3085acfc75343f2ad11d9abe6006d7ea4a16e2dba9af14e49";
// Recorded timestamp of recipe/config commit 0aef4600b9b44292da7ea50f0fd6e9f3d566e8fb.
// Bind creation and copied-file times independently of checkout/cache state.
export const COLLECTOR_SOURCE_DATE_EPOCH = 1793138507;
const REGISTRY_TARGET = /^[a-z0-9.-]+(?:\/[a-z0-9._-]+)+$/iu;
const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const OBSERVED_REGISTRY_IMAGE = Symbol("observed-registry-image");

/** Local OCI facts. `plannedRegistryReference` is deliberately a target to
 * upload under a later receipt, not a claim that a registry contains it. */
export type PreparedCollectorImage = Readonly<{
  plannedRegistryReference: string;
  registryAvailability: "not_uploaded";
  localOciManifestDigest: string;
  localOciConfigDigest: string;
  platform: Readonly<{ os: "linux"; architecture: "amd64" }>;
  baseImage: string;
  dockerfileSha256: string;
  collectorConfigSha256: string;
  /** Immutable local OCI bytes retained until a separately authorized upload.
   * The path is content-addressed by the verified manifest and never rebuilt
   * between review and upload. */
  ociLayoutPath: string;
  ociLayoutSha256: string;
  localLoadTag?: string;
}>;
/** Compatibility view for local smoke only. Its `oci-layout` reference is
 * intentionally not accepted by deployment contracts. */
export type CollectorImageMeasurement = Readonly<{
  imageReference: string;
  imageDigest: string;
  buildTag: string;
  baseImage: string;
  dockerfileSha256: string;
  collectorConfigSha256: string;
  ociConfigDigest: string;
}>;
/** The only deployable representation: an authenticated upload/GET must
 * establish this from a prepared local manifest. */
export type ObservedCollectorRegistryImage = Omit<PreparedCollectorImage, "registryAvailability" | "localLoadTag"> & Readonly<{
  registryAvailability: "observed";
  imageReference: string;
  /** The authenticated registry read that established this exact manifest. */
  observedAtMs: number;
}> & Readonly<{ [OBSERVED_REGISTRY_IMAGE]: true }>;
export type CollectorImageCommand = (argv: readonly string[], cwd: string) => Promise<Readonly<{ code: number; stdout: string; stderr: string }>>;
export type CollectorRegistryObservationPort = Readonly<{
  /** This port is available only after an authorized upload. It must issue an
   * authenticated registry GET/HEAD; matching a caller-provided string is
   * not evidence that the registry contains the image. */
  observeUploadedManifest(input: Readonly<{ imageReference: string; manifestDigest: string; configDigest: string; platform: Readonly<{ os: "linux"; architecture: "amd64" }> }>): Promise<Readonly<{ imageReference: string; manifestDigest: string; configDigest: string; platform: Readonly<{ os: "linux"; architecture: "amd64" }>; observedAtMs: number }>>;
}>;
export type PreparedCollectorOciUpload = Readonly<{
  imageReference: string;
  manifestDigest: string;
  manifestMediaType: "application/vnd.oci.image.manifest.v1+json";
  manifest: Uint8Array;
  configDigest: string;
  platform: Readonly<{ os: "linux"; architecture: "amd64" }>;
  blobs: readonly Readonly<{ digest: string; mediaType: string; bytes: Uint8Array }>[];
}>;

async function defaultCommand(argv: readonly string[], cwd: string) {
  const child = Bun.spawn([...argv], { cwd, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}
async function tarEntry(archive: string, entry: string, cwd: string): Promise<Uint8Array> {
  return tarEntryBytes(archive, entry, cwd);
}
async function tarEntryBytes(archive: string, entry: string, cwd: string): Promise<Uint8Array> {
  const child = Bun.spawn(["tar", "-xOf", archive, entry], { cwd, stdout: "pipe", stderr: "pipe" });
  const [code, bytes] = await Promise.all([child.exited, new Response(child.stdout).arrayBuffer()]);
  if (code !== 0) throw new Error("COLLECTOR_OCI_ENTRY_UNAVAILABLE");
  return new Uint8Array(bytes);
}
async function tarEntryText(archive: string, entry: string, cwd: string): Promise<Uint8Array> {
  const result = await defaultCommand(["tar", "-xOf", archive, entry], cwd);
  if (result.code !== 0) throw new Error("COLLECTOR_OCI_ENTRY_UNAVAILABLE");
  return new TextEncoder().encode(result.stdout);
}
function descriptor(value: unknown, mediaType: string) {
  if (!value || typeof value !== "object") throw new Error("COLLECTOR_OCI_LAYOUT_INVALID");
  const item = value as { digest?: unknown; mediaType?: unknown; platform?: { os?: unknown; architecture?: unknown } };
  if (item.mediaType !== mediaType || typeof item.digest !== "string" || !/^sha256:[a-f0-9]{64}$/iu.test(item.digest)) throw new Error("COLLECTOR_OCI_LAYOUT_INVALID");
  return Object.freeze({ digest: item.digest.toLowerCase(), platform: item.platform && typeof item.platform.os === "string" && typeof item.platform.architecture === "string" ? Object.freeze({ os: item.platform.os, architecture: item.platform.architecture }) : undefined });
}

async function retainOciLayout(archive: string, directory: string, manifestDigest: string): Promise<Readonly<{ path: string; sha256: string }>> {
  const root = resolve(directory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, `${manifestDigest.slice(7)}.oci.tar`);
  const digest = sha256(await readFile(archive));
  try {
    await link(archive, path);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    if (sha256(await readFile(path)) !== digest) throw new Error("COLLECTOR_OCI_ARTIFACT_CONFLICT");
  }
  if (sha256(await readFile(path)) !== digest) throw new Error("COLLECTOR_OCI_ARTIFACT_MUTATED");
  return Object.freeze({ path, sha256: digest });
}

/** Build a single linux/amd64 OCI layout and retain the exact verified bytes
 * under a caller-owned, content-addressed local directory. No registry
 * mutation occurs here. */
export async function prepareProductionCollectorImage(input: Readonly<{ repositoryRoot: string; registryTarget: string; artifactDirectory: string; command?: CollectorImageCommand; loadLocal?: boolean }>): Promise<PreparedCollectorImage> {
  const root = resolve(input.repositoryRoot);
  if (!REGISTRY_TARGET.test(input.registryTarget) || input.registryTarget.startsWith("local/")) throw new Error("COLLECTOR_REGISTRY_TARGET_INVALID");
  const [dockerfile, config] = await Promise.all([readFile(resolve(root, "infra/production/collector.Dockerfile")), readFile(resolve(root, "infra/otel/collector.yaml"))]);
  const dockerfileSha256 = sha256(dockerfile), collectorConfigSha256 = sha256(config);
  if (!dockerfile.toString("utf8").split(/\r?\n/u).some(line => line.trim() === `FROM ${COLLECTOR_BASE_IMAGE}`) || !dockerfile.toString("utf8").includes("COPY --chmod=0444 infra/otel/collector.yaml /etc/otelcol/config.yaml")) throw new Error("COLLECTOR_RECIPE_BINDING_INVALID");
  const directory = await mkdtemp(join(tmpdir(), "napplet-cvm-collector-oci-"));
  const archive = join(directory, "collector.oci.tar");
  const localLoadTag = `napplet-cvm-collector:oci-${dockerfileSha256.slice(0, 16)}-${collectorConfigSha256.slice(0, 16)}`;
  const command = input.command ?? defaultCommand;
  try {
    // BuildKit's epoch clamps newer timestamps; it does not raise older ones.
    // Supply only the measured inputs, with exact file times, and bypass COPY
    // cache entries whose keys intentionally ignore source mtimes.
    const contextRoot = join(directory, "context");
    for (const [path, bytes] of [["infra/production/collector.Dockerfile", dockerfile], ["infra/otel/collector.yaml", config]] as const) {
      const target = join(contextRoot, path);
      await mkdir(resolve(target, ".."), { recursive: true });
      await writeFile(target, bytes, { mode: 0o644 });
      await utimes(target, COLLECTOR_SOURCE_DATE_EPOCH, COLLECTOR_SOURCE_DATE_EPOCH);
    }
    const built = await command(["docker", "buildx", "build", "--no-cache", "--platform", "linux/amd64", "--pull=false", "--build-arg", `SOURCE_DATE_EPOCH=${COLLECTOR_SOURCE_DATE_EPOCH}`, "--file", "infra/production/collector.Dockerfile", "--output", `type=oci,dest=${archive},name=${localLoadTag},rewrite-timestamp=true`, "."], contextRoot);
    if (built.code !== 0) throw new Error("COLLECTOR_LOCAL_OCI_BUILD_FAILED");
    const index = JSON.parse(new TextDecoder().decode(await tarEntryText(archive, "index.json", root))) as { manifests?: unknown[] };
    if (!Array.isArray(index.manifests) || index.manifests.length !== 1) throw new Error("COLLECTOR_OCI_LAYOUT_INVALID");
    const manifest = descriptor(index.manifests[0], "application/vnd.oci.image.manifest.v1+json");
    if (manifest.platform?.os !== "linux" || manifest.platform.architecture !== "amd64") throw new Error("COLLECTOR_OCI_PLATFORM_INVALID");
    const manifestBytes = await tarEntry(archive, `blobs/sha256/${manifest.digest.slice(7)}`, root);
    if (`sha256:${sha256(manifestBytes)}` !== manifest.digest) throw new Error("COLLECTOR_OCI_MANIFEST_DIGEST_INVALID");
    const configDescriptor = descriptor((JSON.parse(new TextDecoder().decode(manifestBytes)) as { config?: unknown }).config, "application/vnd.oci.image.config.v1+json");
    const configBytes = await tarEntry(archive, `blobs/sha256/${configDescriptor.digest.slice(7)}`, root);
    if (`sha256:${sha256(configBytes)}` !== configDescriptor.digest) throw new Error("COLLECTOR_OCI_CONFIG_DIGEST_INVALID");
    const retained = await retainOciLayout(archive, input.artifactDirectory, manifest.digest);
    if (input.loadLocal) { const loaded = await command(["docker", "load", "--input", retained.path], root); if (loaded.code !== 0) throw new Error("COLLECTOR_LOCAL_OCI_LOAD_FAILED"); }
    return Object.freeze({ plannedRegistryReference: `${input.registryTarget}@${manifest.digest}`, registryAvailability: "not_uploaded" as const, localOciManifestDigest: manifest.digest, localOciConfigDigest: configDescriptor.digest, platform: Object.freeze({ os: "linux" as const, architecture: "amd64" as const }), baseImage: COLLECTOR_BASE_IMAGE, dockerfileSha256, collectorConfigSha256, ociLayoutPath: retained.path, ociLayoutSha256: retained.sha256, ...(input.loadLocal ? { localLoadTag } : {}) });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** Reads and revalidates the exact retained OCI layout selected at preapproval
 * time. This does not contact a registry and is used only by the authorized
 * upload boundary; callers cannot replace its bytes with a rebuilt image. */
export async function readPreparedCollectorOci(input: PreparedCollectorImage): Promise<PreparedCollectorOciUpload> {
  if (input.registryAvailability !== "not_uploaded" || sha256(await readFile(input.ociLayoutPath)) !== input.ociLayoutSha256) throw new Error("COLLECTOR_OCI_ARTIFACT_MUTATED");
  const root = resolve(input.ociLayoutPath, "..");
  const index = JSON.parse(new TextDecoder().decode(await tarEntryText(input.ociLayoutPath, "index.json", root))) as { manifests?: unknown[] };
  if (!Array.isArray(index.manifests) || index.manifests.length !== 1) throw new Error("COLLECTOR_OCI_LAYOUT_INVALID");
  const manifestDescriptor = descriptor(index.manifests[0], "application/vnd.oci.image.manifest.v1+json");
  if (manifestDescriptor.digest !== input.localOciManifestDigest || manifestDescriptor.platform?.os !== "linux" || manifestDescriptor.platform.architecture !== "amd64") throw new Error("COLLECTOR_OCI_MANIFEST_DIGEST_INVALID");
  const manifest = await tarEntryBytes(input.ociLayoutPath, `blobs/sha256/${manifestDescriptor.digest.slice(7)}`, root);
  if (`sha256:${sha256(manifest)}` !== input.localOciManifestDigest) throw new Error("COLLECTOR_OCI_MANIFEST_DIGEST_INVALID");
  const parsed = zManifest(JSON.parse(new TextDecoder().decode(manifest)));
  if (parsed.config.digest !== input.localOciConfigDigest) throw new Error("COLLECTOR_OCI_CONFIG_DIGEST_INVALID");
  const descriptors = [parsed.config, ...parsed.layers];
  const blobs = await Promise.all(descriptors.map(async item => {
    const bytes = await tarEntryBytes(input.ociLayoutPath, `blobs/sha256/${item.digest.slice(7)}`, root);
    if (`sha256:${sha256(bytes)}` !== item.digest) throw new Error("COLLECTOR_OCI_BLOB_DIGEST_INVALID");
    return Object.freeze({ digest: item.digest, mediaType: item.mediaType, bytes });
  }));
  const config = JSON.parse(new TextDecoder().decode(blobs[0]!.bytes)) as { os?: unknown; architecture?: unknown };
  if (config.os !== "linux" || config.architecture !== "amd64") throw new Error("COLLECTOR_OCI_PLATFORM_INVALID");
  return Object.freeze({ imageReference: input.plannedRegistryReference, manifestDigest: input.localOciManifestDigest, manifestMediaType: "application/vnd.oci.image.manifest.v1+json", manifest, configDigest: input.localOciConfigDigest, platform: Object.freeze({ os: "linux", architecture: "amd64" }), blobs: Object.freeze(blobs) });
}

function zManifest(value: unknown): Readonly<{ config: Readonly<{ digest: string; mediaType: string }>; layers: readonly Readonly<{ digest: string; mediaType: string }>[] }> {
  if (!value || typeof value !== "object") throw new Error("COLLECTOR_OCI_LAYOUT_INVALID");
  const manifest = value as { config?: unknown; layers?: unknown };
  const item = (value: unknown) => {
    if (!value || typeof value !== "object") throw new Error("COLLECTOR_OCI_LAYOUT_INVALID");
    const descriptor = value as { digest?: unknown; mediaType?: unknown };
    if (typeof descriptor.digest !== "string" || !/^sha256:[a-f0-9]{64}$/iu.test(descriptor.digest) || typeof descriptor.mediaType !== "string" || !descriptor.mediaType.startsWith("application/vnd.oci.")) throw new Error("COLLECTOR_OCI_LAYOUT_INVALID");
    return Object.freeze({ digest: descriptor.digest.toLowerCase(), mediaType: descriptor.mediaType });
  };
  if (!Array.isArray(manifest.layers)) throw new Error("COLLECTOR_OCI_LAYOUT_INVALID");
  return Object.freeze({ config: item(manifest.config), layers: Object.freeze(manifest.layers.map(item)) });
}

export async function observeUploadedCollectorRegistryImage(input: PreparedCollectorImage, registry: CollectorRegistryObservationPort): Promise<ObservedCollectorRegistryImage> {
  if (input.registryAvailability !== "not_uploaded") throw new Error("COLLECTOR_REGISTRY_OBSERVATION_MISMATCH");
  const observed = await registry.observeUploadedManifest({ imageReference: input.plannedRegistryReference, manifestDigest: input.localOciManifestDigest, configDigest: input.localOciConfigDigest, platform: input.platform });
  if (observed.imageReference !== input.plannedRegistryReference || observed.manifestDigest !== input.localOciManifestDigest || observed.configDigest !== input.localOciConfigDigest || observed.platform.os !== "linux" || observed.platform.architecture !== "amd64" || !Number.isSafeInteger(observed.observedAtMs) || observed.observedAtMs <= 0) throw new Error("COLLECTOR_REGISTRY_OBSERVATION_MISMATCH");
  return Object.freeze({ ...input, registryAvailability: "observed" as const, imageReference: observed.imageReference, observedAtMs: observed.observedAtMs, [OBSERVED_REGISTRY_IMAGE]: true as const });
}
export function isObservedCollectorRegistryImage(value: unknown): value is ObservedCollectorRegistryImage {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ObservedCollectorRegistryImage>;
  const observedAtMs = item.observedAtMs;
  return item.registryAvailability === "observed" && typeof item.imageReference === "string" && item.imageReference === item.plannedRegistryReference && typeof item.localOciManifestDigest === "string" && item.imageReference.endsWith(`@${item.localOciManifestDigest}`) && typeof observedAtMs === "number" && Number.isSafeInteger(observedAtMs) && observedAtMs > 0 && (value as Record<PropertyKey, unknown>)[OBSERVED_REGISTRY_IMAGE] === true;
}

/** Local smoke adapter retained for package verification. It creates a local
 * Docker load tag but still returns a non-deployable OCI-layout reference. */
export async function measureProductionCollectorImage(input: Readonly<{ repositoryRoot: string; command?: CollectorImageCommand }>): Promise<CollectorImageMeasurement> {
  const directory = await mkdtemp(join(tmpdir(), "napplet-cvm-collector-measurement-"));
  try {
    const prepared = await prepareProductionCollectorImage({ repositoryRoot: input.repositoryRoot, registryTarget: "registry.invalid/napplet-cvm/collector", artifactDirectory: directory, command: input.command, loadLocal: true });
    if (!prepared.localLoadTag) throw new Error("COLLECTOR_LOCAL_OCI_LOAD_FAILED");
    return Object.freeze({ imageReference: `oci-layout@${prepared.localOciManifestDigest}`, imageDigest: prepared.localOciManifestDigest.slice(7), buildTag: prepared.localLoadTag, baseImage: prepared.baseImage, dockerfileSha256: prepared.dockerfileSha256, collectorConfigSha256: prepared.collectorConfigSha256, ociConfigDigest: prepared.localOciConfigDigest });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
