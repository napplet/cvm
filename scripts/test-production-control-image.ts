import { readFile } from "node:fs/promises";

const image = process.argv[2];
if (!image || !/^sha256:[a-f0-9]{64}$/u.test(image)) throw new Error("EXACT_CONTROL_IMAGE_DIGEST_REQUIRED");
const files = ["package.json", "bun.lock", "scripts/production.ts", "scripts/test-production-control-image.ts", "src/production/bootstrap.ts", "migrations/phase-07/014_production_durability_subjects.sql"];
const expected = Object.fromEntries(await Promise.all(files.map(async path => [path, new Bun.CryptoHasher("sha256").update(await readFile(new URL(`../${path}`, import.meta.url))).digest("hex")])));

async function command(args: string[]) {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 30_000);
  async function bounded(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        size += next.value.byteLength;
        if (size > 1_048_576) { child.kill(); throw new Error("CONTROL_IMAGE_OUTPUT_LIMIT"); }
        chunks.push(next.value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder().decode(bytes);
  }
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, bounded(child.stdout), bounded(child.stderr)]);
    if (timedOut) throw new Error("CONTROL_IMAGE_COMMAND_TIMEOUT");
    return { code, stdout, stderr };
  } finally { clearTimeout(timer); }
}

const probe = `
import { readFile, stat, writeFile, rm } from "node:fs/promises";
import { loadPinnedCliNetworkHelpers } from "./src/production/pinned-cli-network.ts";
import { loadPinnedDirectCliNetworkHelpers } from "./src/production/pinned-direct-cli-network.ts";
if (process.getuid?.() !== 65532) throw new Error("CONTROL_IMAGE_UID_INVALID");
for (const path of ["src", "scripts", "vendor", "node_modules"]) {
  const metadata = await stat(path);
  if (metadata.uid !== 0 || (metadata.mode & 0o022) !== 0) throw new Error("CONTROL_IMAGE_SOURCE_WRITABLE");
}
const legacy = await loadPinnedCliNetworkHelpers(), direct = await loadPinnedDirectCliNetworkHelpers();
if (typeof legacy.uploadFilesToServers !== "function" || typeof direct.createUploadAuthorization !== "function") throw new Error("CONTROL_IMAGE_HELPERS_UNAVAILABLE");
const paths = ${JSON.stringify(files)};
const hashes = Object.fromEntries(await Promise.all(paths.map(async path => [path, new Bun.CryptoHasher("sha256").update(await readFile(path)).digest("hex")])));
const temporary = process.env.TMPDIR + "/proof";
await writeFile(temporary, "disposable proof"); await rm(temporary);
console.log(JSON.stringify({ hashes, uid: process.getuid(), helpers: true }));
`;
const probeName = `cvm-control-probe-${crypto.randomUUID()}`, bootName = `cvm-control-boot-${crypto.randomUUID()}`;
const names = [probeName, bootName];
const restrictions = ["--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--tmpfs", "/tmp/napplet-cvm:rw,nosuid,nodev,size=64m,uid=65532,gid=65532,mode=700"];
try {
  const inspected = await command(["image", "inspect", "--format", "{{.Id}}", image]);
  if (inspected.code || inspected.stdout.trim() !== image) throw new Error("CONTROL_IMAGE_IDENTITY_MISMATCH");
  const result = await command(["run", "--name", probeName, ...restrictions, "--entrypoint", "bun", image, "--eval", probe]);
  if (result.code) throw new Error(`CONTROL_IMAGE_PROBE_FAILED:${result.stderr.slice(0, 500)}`);
  const observed: unknown = JSON.parse(result.stdout);
  if (!observed || typeof observed !== "object" || !("hashes" in observed) || JSON.stringify(observed.hashes) !== JSON.stringify(expected)) throw new Error("CONTROL_IMAGE_SOURCE_MISMATCH");
  const boot = await command(["run", "--name", bootName, ...restrictions, image]);
  if (boot.code !== 1 || !boot.stderr.includes("PRODUCTION_CONFIG_MOUNT_UNAVAILABLE")) throw new Error(`CONTROL_IMAGE_BOOT_NOT_FAIL_CLOSED:${boot.stderr.slice(0, 500)}`);
} finally {
  for (const name of names) {
    await command(["rm", "--force", name]);
    const absent = await command(["inspect", "--type", "container", "--format", "{{.Id}}", name]);
    if (absent.code !== 1 || !/No such (?:object|container)/iu.test(absent.stderr)) throw new Error("CONTROL_IMAGE_CLEANUP_UNCONFIRMED");
  }
}
console.log(JSON.stringify({ localControlImage: image, network: "none", uid: 65532, pinnedHelpersLoaded: true, sourceHashes: expected, missingConfiguration: "refused", cleanup: "confirmed-absent", releaseEvidence: false }));
