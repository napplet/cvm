import { readFile } from "node:fs/promises";

const image = process.argv[2];
const modalBilling = process.argv[3] === "--modal-billing";
if (process.argv.length > (modalBilling ? 4 : 3)) throw new Error("CONTROL_IMAGE_PROBE_ARGUMENT_INVALID");
if (!image || !/^sha256:[a-f0-9]{64}$/u.test(image)) throw new Error("EXACT_CONTROL_IMAGE_DIGEST_REQUIRED");
const files = [
  "package.json", "bun.lock", "scripts/production.ts", "scripts/test-production-control-image.ts", "src/production/bootstrap.ts", "src/service/server.ts",
  "migrations/phase-07/014_production_durability_subjects.sql", "tests/dev-ui/package.json", "tests/dev-ui/bun.lock",
  "infra/dev-ui/source-capabilities.ts", "infra/dev-ui/authoring-skills.ts", "infra/dev-ui/authoring-skills/source.json", "infra/dev-ui/host-source.json", "infra/dev-ui/run-proposal.ts",
  "infra/vendor/napplet-cli/bundle/entry.js", "infra/vendor/napplet-publication/bundle/entry.js",
];
const modalLockPath = "infra/production/modal-billing/requirements-linux-amd64.lock";
const modalLock = modalBilling ? await readFile(new URL(`../${modalLockPath}`, import.meta.url), "utf8") : undefined;
const modalLockSha256 = modalLock === undefined ? undefined : new Bun.CryptoHasher("sha256").update(modalLock).digest("hex");
const expected = Object.fromEntries(await Promise.all(files.map(async path => [path, new Bun.CryptoHasher("sha256").update(await readFile(new URL(`../${path}`, import.meta.url))).digest("hex")])));

async function command(args: string[], timeoutMs = 30_000) {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
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

const modalProbe = modalBilling ? String.raw`
const modalRoot = "/opt/napplet-cvm-modal", executable = modalRoot + "/venv/bin/modal";
const lock = await readFile(modalRoot + "/requirements.lock", "utf8");
if (new Bun.CryptoHasher("sha256").update(lock).digest("hex") !== ${JSON.stringify(modalLockSha256)}) throw new Error("MODAL_IMAGE_LOCK_MISMATCH");
async function immutableTree(path) {
  const metadata = await lstat(path);
  if (metadata.uid !== 0 || (!metadata.isSymbolicLink() && (metadata.mode & 0o022) !== 0)) throw new Error("MODAL_IMAGE_RUNTIME_WRITABLE");
  if (metadata.isSymbolicLink()) {
    const target = await realpath(path);
    if (!target.startsWith(modalRoot + "/") && !target.startsWith("/usr/local/")) throw new Error("MODAL_IMAGE_RUNTIME_SYMLINK_INVALID");
    const resolved = await stat(target);
    if (resolved.uid !== 0 || (resolved.mode & 0o022) !== 0) throw new Error("MODAL_IMAGE_RUNTIME_WRITABLE");
  } else if (metadata.isDirectory()) for (const name of await readdir(path)) await immutableTree(path + "/" + name);
}
await immutableTree(modalRoot);
await immutableTree("/usr/local");
const home = await mkdtemp(process.env.TMPDIR + "/modal-offline-");
let modalEvidence;
try {
  const childEnv = { PATH: home, HOME: home, MODAL_CONFIG_PATH: home + "/modal.toml", MODAL_LOGLEVEL: "WARNING" };
  async function runOffline(argv) {
    const child = Bun.spawn(argv, { cwd: home, env: childEnv, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 10000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      if (code !== 0 || stdout.length > 65536 || stderr.length > 65536) throw new Error("MODAL_IMAGE_OFFLINE_CHILD_FAILED");
      return stdout.trim();
    } finally { clearTimeout(timeout); }
  }
  const original = await readFile(executable), executableSha256 = new Bun.CryptoHasher("sha256").update(original).digest("hex");
  // Match the report runner's private-copy and closed-env execution mechanics.
  const copied = home + "/modal-verified";
  await writeFile(copied, original, { mode: 0o700 });
  const launch = await pinnedModalBillingLaunch({ verifiedBytes: new Uint8Array(original), privateExecutable: copied });
  if (!launch.interpreterSha256 || launch.argvPrefix[0] !== MODAL_BILLING_PYTHON) throw new Error("MODAL_IMAGE_INTERPRETER_LAUNCH_MISSING");
  const version = await runOffline([...launch.argvPrefix, "--version"]);
  if (version !== "modal client version: 1.6.3") throw new Error("MODAL_IMAGE_VERSION_INVALID");
  // Exercise the actual bounded report runner on the same noexec mount with a
  // local Python fixture. It only emits argv/env facts; it has no network code.
  const fixtureSource = "#!" + MODAL_BILLING_PYTHON + "\nimport json,os,sys\nprint(json.dumps(dict(argv=sys.argv[1:],isolated=bool(sys.flags.isolated),credential=bool(os.environ.get('MODAL_TOKEN_ID')) and bool(os.environ.get('MODAL_TOKEN_SECRET')),closed=not any(k in os.environ for k in ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','GOOGLE_APPLICATION_CREDENTIALS','PYTHONPATH']))))\n";
  const fixture = home + "/runner-fixture";
  await writeFile(fixture, fixtureSource, { mode: 0o700 });
  const runner = await runPinnedModalBillingReport({ executable: fixture, executableSha256: new Bun.CryptoHasher("sha256").update(fixtureSource).digest("hex"), environmentName: "offline-fixture", intervalStartMs: Date.parse("2026-10-30T10:00:00Z"), intervalEndMs: Date.parse("2026-10-30T11:00:00Z"), tagNames: ["cvm_operation"], maximumStdoutBytes: 8192, maximumStderrBytes: 2048, timeoutMs: 1000, credential: { tokenId: "offline-fixture-id", tokenSecret: "offline-fixture-secret" } });
  if (runner.disposition !== "passed" || runner.interpreterSha256 !== launch.interpreterSha256) throw new Error("MODAL_IMAGE_REAL_RUNNER_FAILED");
  const runnerFacts = JSON.parse(new TextDecoder().decode(runner.stdout));
  if (!runnerFacts.isolated || !runnerFacts.credential || !runnerFacts.closed || JSON.stringify(runnerFacts.argv) !== JSON.stringify(runner.argv.slice(1))) throw new Error("MODAL_IMAGE_REAL_RUNNER_BOUNDARY_INVALID");
  await rm(fixture);
  const python = modalRoot + "/venv/bin/python";
  const packages = JSON.parse(await runOffline([python, "-I", "-c", "import importlib.metadata as m,json,platform; print(json.dumps(dict(version=platform.python_version(),machine=platform.machine(),packages={d.metadata['Name'].lower().replace('_','-'):d.version for d in m.distributions()})))"]));
  if (packages.version !== "3.14.8" || packages.machine !== "x86_64") throw new Error("MODAL_IMAGE_PYTHON_INVALID");
  const expectedPackages = Object.fromEntries(lock.trim().split("\n").map(line => { const [name, version] = line.split(" --hash=")[0].split("=="); return [name.toLowerCase().replaceAll("_", "-"), version]; }));
  const actualPackages = { ...packages.packages }; delete actualPackages.pip;
  if (Object.keys(actualPackages).length !== Object.keys(expectedPackages).length || Object.entries(expectedPackages).some(([name, version]) => actualPackages[name] !== version)) throw new Error("MODAL_IMAGE_PACKAGE_CLOSURE_MISMATCH");
  if (await runOffline([python, "-I", "-m", "pip", "check"]) !== "No broken requirements found.") throw new Error("MODAL_IMAGE_PACKAGE_REQUIREMENTS_INVALID");
  if ((await readdir(home)).some(name => name !== "modal-verified")) throw new Error("MODAL_IMAGE_UNEXPECTED_PROFILE_WRITE");
  modalEvidence = { executableSha256, interpreterSha256: launch.interpreterSha256, actualRunner: "passed-local-fixture", version, python: packages.version, architecture: packages.machine, packageCount: Object.keys(actualPackages).length, lockSha256: ${JSON.stringify(modalLockSha256)}, network: "none", providerCredentials: "absent", fixtureMarkers: true };
} finally { await rm(home, { recursive: true, force: true }); }
` : "";

const probe = `
import { readFile, stat, lstat, realpath, readdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { verifyDevelopmentHostFiles } from "./src/dev/development-runtime-readiness.ts";
import { runBoundedDevelopmentCommand } from "./src/dev/local-napplet-worker.ts";
import { loadAuthoringSkills } from "./infra/dev-ui/authoring-skills.ts";
import { buildStaticWorkspace } from "./src/dev-ui/static-assets.ts";
import { loadPinnedCliNetworkHelpers } from "./src/production/pinned-cli-network.ts";
import { loadPinnedDirectCliNetworkHelpers } from "./src/production/pinned-direct-cli-network.ts";
import { MODAL_BILLING_PYTHON, pinnedModalBillingLaunch, runPinnedModalBillingReport } from "./src/release/deployment/modal-billing-report.ts";
if (process.getuid?.() !== 65532) throw new Error("CONTROL_IMAGE_UID_INVALID");
for (const path of ["src", "scripts", "vendor", "node_modules", "infra", "tests/dev-ui", "/opt/napplet-cvm-browsers", "/usr/local/bin/docker"]) {
  const metadata = await stat(path);
  if (metadata.uid !== 0 || (metadata.mode & 0o022) !== 0) throw new Error("CONTROL_IMAGE_SOURCE_WRITABLE");
}
const legacy = await loadPinnedCliNetworkHelpers(), direct = await loadPinnedDirectCliNetworkHelpers();
if (typeof legacy.uploadFilesToServers !== "function" || typeof direct.createUploadAuthorization !== "function") throw new Error("CONTROL_IMAGE_HELPERS_UNAVAILABLE");
const paths = ${JSON.stringify(files)};
const hashes = Object.fromEntries(await Promise.all(paths.map(async path => [path, new Bun.CryptoHasher("sha256").update(await readFile(path)).digest("hex")])));
const temporary = process.env.TMPDIR + "/proof";
await writeFile(temporary, "disposable proof"); await rm(temporary);
// Exercise the actual service's imports and post-configuration assets offline.
// Missing configuration alone cannot prove these runtime dependencies exist.
await import("./scripts/production.ts");
const hostSha256 = await verifyDevelopmentHostFiles();
const skills = await loadAuthoringSkills();
const paja = await import("./tests/dev-ui/node_modules/@kehto/paja");
if (typeof paja.startPajaServer !== "function" || !Array.isArray(paja.PAJA_SIMULATION_DOMAINS)) throw new Error("CONTROL_IMAGE_PREVIEW_RUNTIME_UNAVAILABLE");
const workspace = await buildStaticWorkspace({ relayUrl: "wss://relay.invalid", servicePubkey: "0".repeat(64) });
if (!workspace.get("index.html") || !workspace.get("app.js")) throw new Error("CONTROL_IMAGE_WORKSPACE_UNAVAILABLE");
const docker = await runBoundedDevelopmentCommand(["docker", "--version"], { deadlineMs: 10000, maxBytes: 8192 });
if (docker.exitCode !== 0 || !docker.stdout.startsWith("Docker version 29.9.2,")) throw new Error("CONTROL_IMAGE_DOCKER_CLI_UNAVAILABLE");
// Match readiness's bounded child process, preserving the probe's no-network,
// read-only filesystem and dropped-capability restrictions. Only about:blank
// and fixed inline markup are loaded; no generated code or provider is used.
const browser = await runBoundedDevelopmentCommand([process.execPath, "--eval", ${JSON.stringify(`
  const { chromium } = await import("/app/tests/dev-ui/node_modules/playwright");
  const browser = await chromium.launch({ headless: true, timeout: 20000 });
  try {
    const page = await browser.newPage();
    await page.goto("about:blank");
    await page.setContent("<title>cvm-image-proof</title>");
    if (await page.title() !== "cvm-image-proof") throw new Error("CONTROL_IMAGE_BROWSER_CONTENT_FAILED");
    console.log(JSON.stringify({ browserVersion: browser.version() }));
  } finally { await browser.close(); }
`)}], { deadlineMs: 55000, maxBytes: 8192 });
if (browser.exitCode !== 0) throw new Error("CONTROL_IMAGE_BROWSER_UNAVAILABLE:" + browser.stderr.slice(0, 1000));
const browserVersion = JSON.parse(browser.stdout.trim()).browserVersion;
const browserPins = JSON.parse(await readFile("tests/dev-ui/node_modules/playwright-core/browsers.json", "utf8"));
if (browserVersion !== browserPins.browsers.find(item => item.name === "chromium").browserVersion) throw new Error("CONTROL_IMAGE_BROWSER_VERSION_MISMATCH");
const runtimeEvidence = { hostSha256, skillsSha256: skills.sha256, workspaceBuilt: true, previewRuntimeLoaded: true, dockerVersion: docker.stdout.trim(), browserVersion };
${modalProbe}
console.log(JSON.stringify({ hashes, uid: process.getuid(), helpers: true, runtimeEvidence, ${modalBilling ? "modalEvidence" : "modalEvidence: undefined"} }));
`;
const probeName = `cvm-control-probe-${crypto.randomUUID()}`, bootName = `cvm-control-boot-${crypto.randomUUID()}`;
const names = [probeName, bootName];
let modalEvidence: unknown;
let runtimeEvidence: unknown;
const restrictions = ["--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--tmpfs", "/tmp/napplet-cvm:rw,noexec,nosuid,nodev,size=64m,uid=65532,gid=65532,mode=700"];
try {
  const inspected = await command(["image", "inspect", "--format", "{{.Id}}", image]);
  if (inspected.code || inspected.stdout.trim() !== image) throw new Error("CONTROL_IMAGE_IDENTITY_MISMATCH");
  const result = await command(["run", "--name", probeName, ...restrictions, "--entrypoint", "bun", image, "--eval", probe], 90_000);
  if (result.code) throw new Error(`CONTROL_IMAGE_PROBE_FAILED:${result.stderr.slice(0, 500)}`);
  const observed: unknown = JSON.parse(result.stdout);
  if (!observed || typeof observed !== "object" || !("hashes" in observed) || JSON.stringify(observed.hashes) !== JSON.stringify(expected)) throw new Error("CONTROL_IMAGE_SOURCE_MISMATCH");
  if (!("runtimeEvidence" in observed) || !observed.runtimeEvidence) throw new Error("CONTROL_IMAGE_RUNTIME_PROOF_MISSING");
  runtimeEvidence = observed.runtimeEvidence;
  if (modalBilling) {
    if (!("modalEvidence" in observed) || !observed.modalEvidence) throw new Error("MODAL_IMAGE_PROOF_MISSING");
    modalEvidence = observed.modalEvidence;
  }
  const boot = await command(["run", "--name", bootName, ...restrictions, image]);
  if (boot.code !== 1 || !boot.stderr.includes("SERVICE_MOUNT_UNAVAILABLE:/etc/napplet-cvm/service.json")) throw new Error(`CONTROL_IMAGE_BOOT_NOT_FAIL_CLOSED:${boot.stderr.slice(0, 500)}`);
} finally {
  for (const name of names) {
    await command(["rm", "--force", name]);
    const absent = await command(["inspect", "--type", "container", "--format", "{{.Id}}", name]);
    if (absent.code !== 1 || !/No such (?:object|container)/iu.test(absent.stderr)) throw new Error("CONTROL_IMAGE_CLEANUP_UNCONFIRMED");
  }
}
console.log(JSON.stringify({ localControlImage: image, network: "none", uid: 65532, pinnedHelpersLoaded: true, sourceHashes: expected, runtimeEvidence, missingConfiguration: "refused", cleanup: "confirmed-absent", releaseEvidence: false, ...(modalBilling ? { modalEvidence } : {}) }));
