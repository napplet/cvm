import { LocalDevelopmentRuntimeReadiness } from "../src/dev/development-runtime-readiness";
import { LocalNappletWorker, runBoundedDevelopmentCommand, untrustedRuntimeArgs } from "../src/dev/local-napplet-worker";
import { collectArtifactFiles } from "../src/dev/local-artifact-verifier";
import { canonicalJson } from "../src/promotion/schema";

/**
 * Probes the configured build engine and OCI runtime with the exact worker
 * flags. This is deployment evidence for the actual runtime; it never reads
 * credentials and generates no paid model traffic.
 *
 *   bun scripts/probe-worker-runtime.ts --image <ref> --runtime runsc
 */
const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? (index > 0 ? process.argv[index + 1] : undefined);
};
const image = arg("image") ?? "napplet-cvm/dev-worker:development";
const runtime = arg("runtime");
if (!runtime || !/^[a-z][a-z0-9_.-]{1,31}$/u.test(runtime)) throw new Error("PROBE_RUNTIME_REQUIRED");

const started = performance.now();
const readiness = await new LocalDevelopmentRuntimeReadiness({ image, runtime }).assertReady();
const readinessMs = Math.round(performance.now() - started);

// The same isolation flags the worker uses, running an in-sandbox self check.
const name = `napplet-cvm-boundary-probe-${crypto.randomUUID()}`;
const inside = String.raw`
  const fs = require('node:fs'); const net = require('node:net'); const dns = require('node:dns/promises');
  const attempt = async (fn) => { try { await fn(); return 'allowed'; } catch { return 'denied'; } };
  const status = fs.readFileSync('/proc/self/status', 'utf8');
  const field = (key) => (status.match(new RegExp('^' + key + ':\\s*(\\S+)', 'm')) || [])[1];
  const tcp = (host) => new Promise((resolve, reject) => { const s = net.connect({ host, port: 443 }); s.once('connect', () => { s.destroy(); resolve(); }); s.once('error', reject); s.setTimeout(2000, () => { s.destroy(); reject(new Error('timeout')); }); });
  const result = {
    uid: process.getuid(), gid: process.getgid(), capEff: field('CapEff'), noNewPrivs: field('NoNewPrivs'),
    rootWrite: await attempt(async () => fs.writeFileSync('/probe-root-write', 'x')),
    tmpWrite: await attempt(async () => fs.writeFileSync('/tmp/probe', 'x')),
    dns: await attempt(() => dns.lookup('example.com')),
    publicTcp: await attempt(() => tcp('1.1.1.1')),
    privateTcp: await attempt(() => tcp('10.0.0.1')),
    metadata: await attempt(() => fetch('http://169.254.169.254/', { signal: AbortSignal.timeout(2000) })),
    interfaces: Object.keys(require('node:os').networkInterfaces()).sort(),
    kernel: fs.readFileSync('/proc/version', 'utf8').slice(0, 80),
  };
  console.log(JSON.stringify(result));
`;
const docker = ["docker", "run", ...untrustedRuntimeArgs(runtime), "--name", name, "--rm", "--network", "none", "--read-only", "--user", "65532:65532", "--cpus", "2", "--memory", "2g", "--pids-limit", "256", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--tmpfs", "/tmp:rw,exec,nosuid,nodev,size=256m", "--entrypoint", "bun", readiness.imageDigest, "-e", inside];
let boundary: Record<string, unknown>;
try {
  const result = await runBoundedDevelopmentCommand(docker, { deadlineMs: 60_000, maxBytes: 32_000 });
  if (result.exitCode !== 0) throw new Error(`PROBE_BOUNDARY_FAILED:${result.stderr.slice(-400)}`);
  boundary = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
} finally { await runBoundedDevelopmentCommand(["docker", "rm", "--force", name], { deadlineMs: 5_000, maxBytes: 4_000 }).catch(() => undefined); }

// One complete known-good build: create, install, build, verify, conformance.
const main = [
  "import './styles.css';",
  "import { runtimeHasDomain } from './domain-availability.js';",
  'const root = document.querySelector("#app");',
  'if (!root) throw new Error("APP_ROOT_MISSING");',
  'let count = 0;',
  'const value = document.createElement("output"); value.textContent = String(count);',
  'const button = document.createElement("button"); button.type = "button"; button.textContent = "Add";',
  'button.addEventListener("click", () => { count += 1; value.textContent = String(count); });',
  'const availability = document.createElement("p"); availability.textContent = runtimeHasDomain("storage") ? "Storage available" : "Storage unavailable";',
  'root.replaceChildren(value, button, availability);',
].join("\n");
const files = [
  { path: "src/capabilities.json" as const, content: JSON.stringify({ required: [], optional: [] }) },
  { path: "src/main.ts" as const, content: main },
  { path: "src/styles.css" as const, content: "html, body, #app { height: 100%; margin: 0; } button { margin: 0.5rem; }" },
];
const sha256 = new Bun.CryptoHasher("sha256").update(canonicalJson({ files })).digest("hex");
const buildStarted = performance.now();
const output = await new LocalNappletWorker({ image: readiness.imageDigest, runtime }).materialize({ proposalSha256: sha256, proposal: { reference: `proposal:sha256:${sha256}`, sha256, files } as never });
try {
  const inventory = await collectArtifactFiles(output.distRoot);
  const expected = { uid: 65532, capEff: "0000000000000000", noNewPrivs: "1", rootWrite: "denied", tmpWrite: "allowed", dns: "denied", publicTcp: "denied", privateTcp: "denied", metadata: "denied" } as const;
  const violations = Object.entries(expected).filter(([key, value]) => boundary[key] !== value).map(([key]) => key);
  if (JSON.stringify(boundary.interfaces) !== JSON.stringify(["lo"])) violations.push("interfaces");
  const report = {
    status: violations.length ? "failed" : "passed", runtime, image: readiness.imageDigest, readinessMs,
    buildMs: Math.round(performance.now() - buildStarted), stages: output.commandEvidence.map((stage) => `${stage.name}:${stage.exitCode}`),
    artifactFiles: inventory.length, boundary, violations,
  };
  console.log(JSON.stringify(report, null, 2));
  if (violations.length) process.exitCode = 1;
} finally { await output.cleanup(); }
