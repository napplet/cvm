import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

type Expected = Readonly<{ name: string; version: string; repository: string; licenses: readonly string[] }>;
const expected: readonly Expected[] = [
  { name: "@contextvm/sdk", version: "0.13.10", repository: "https://github.com/ContextVM/sdk", licenses: ["LGPL-3.0-1"] },
  { name: "@cashu/cashu-ts", version: "4.7.2", repository: "https://github.com/cashubtc/cashu-ts", licenses: ["MIT"] },
  { name: "kysely", version: "0.29.4", repository: "https://github.com/kysely-org/kysely", licenses: ["MIT"] },
  { name: "pg", version: "8.22.0", repository: "https://github.com/brianc/node-postgres", licenses: ["MIT"] },
];
const forbiddenLifecycle = new Set(["preinstall", "install", "postinstall"]);
const registry = "https://registry.npmjs.org";

function normalizeRepository(value: unknown): string | undefined {
  const url = typeof value === "string" ? value : value && typeof value === "object" && "url" in value ? (value as { url?: unknown }).url : undefined;
  if (typeof url !== "string") return undefined;
  return url.replace(/^git\+/, "").replace(/^git:\/\//, "https://").replace(/\.git$/, "").replace(/\/$/, "");
}
function sha256(bytes: ArrayBuffer): string { return createHash("sha256").update(new Uint8Array(bytes)).digest("hex"); }
function sri(bytes: ArrayBuffer, integrity: string): boolean {
  return integrity.split(/\s+/u).some((entry) => {
    const [algorithm, encoded] = entry.split("-", 2);
    return algorithm === "sha512" && encoded === createHash("sha512").update(new Uint8Array(bytes)).digest("base64");
  });
}
async function json(url: string): Promise<any> {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`REGISTRY_REQUEST_FAILED:${response.status}:${url}`);
  return response.json();
}
async function assertLock(): Promise<void> {
  const lock = await readFile("bun.lock", "utf8").catch(() => "");
  const manifest = JSON.parse(await readFile("package.json", "utf8")) as { dependencies?: Record<string, string> };
  if (!lock) return;
  for (const item of expected) {
    if (!manifest.dependencies?.[item.name]) continue;
    if (manifest.dependencies[item.name] !== item.version) throw new Error(`MANIFEST_VERSION_MISMATCH:${item.name}`);
    if (!lock.includes(`\"${item.name}\": \"${item.version}\"`) && !lock.includes(`\"${item.name}\": \"${item.version}^`)) throw new Error(`LOCK_RESOLUTION_MISSING:${item.name}@${item.version}`);
  }
}

const rows = [] as Array<Record<string, unknown>>;
for (const item of expected) {
  const metadata = await json(`${registry}/${encodeURIComponent(item.name)}/${item.version}`);
  const dist = metadata.dist as { integrity?: unknown; tarball?: unknown } | undefined;
  const integrity = dist?.integrity;
  const tarball = dist?.tarball;
  const repository = normalizeRepository(metadata.repository);
  const lifecycle = Object.keys((metadata.scripts ?? {}) as Record<string, unknown>).filter((name) => forbiddenLifecycle.has(name)).sort();
  if (metadata.name !== item.name || metadata.version !== item.version) throw new Error(`IDENTITY_MISMATCH:${item.name}`);
  if (metadata.deprecated) throw new Error(`DEPRECATED_PACKAGE:${item.name}`);
  if (!item.licenses.includes(metadata.license)) throw new Error(`LICENSE_MISMATCH:${item.name}`);
  if (repository !== item.repository) throw new Error(`SOURCE_MISMATCH:${item.name}`);
  if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) throw new Error(`REGISTRY_INTEGRITY_MISSING:${item.name}`);
  if (typeof tarball !== "string" || !tarball.startsWith(`${registry}/`)) throw new Error(`TARBALL_AMBIGUITY:${item.name}`);
  if (lifecycle.length) throw new Error(`UNSAFE_LIFECYCLE:${item.name}:${lifecycle.join(",")}`);
  const response = await fetch(tarball);
  if (!response.ok) throw new Error(`TARBALL_FETCH_FAILED:${item.name}:${response.status}`);
  const bytes = await response.arrayBuffer();
  if (!sri(bytes, integrity)) throw new Error(`TARBALL_INTEGRITY_MISMATCH:${item.name}`);
  rows.push({ name: item.name, version: item.version, registryIntegrity: integrity, tarballSha256: sha256(bytes), tarball, repository, gitHead: metadata.gitHead ?? null, license: metadata.license, lifecycleScripts: lifecycle, deprecated: false, disposition: "design-stage" });
}
await assertLock();
const evidence = {
  schemaVersion: 1,
  checkedAt: new Date().toISOString(),
  disposition: "design-stage",
  packages: rows,
  limitations: ["This is not exhaustive provenance.", "This is not production promotion.", "This is not compatibility certification; Phase 7 owns those gates."],
};
const output = "evidence/phase-03/package-intake.json";
await mkdir(dirname(output), { recursive: true });
const temporary = join(dirname(output), ".package-intake.tmp");
await writeFile(temporary, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
await rename(temporary, output);
console.log(JSON.stringify({ verdict: "pass", packageCount: rows.length, evidence: output }));
