import { loadAuthoringSkills } from "../../infra/dev-ui/authoring-skills";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runBoundedDevelopmentCommand } from "./local-napplet-worker";

const root = resolve(import.meta.dir, "../..");
const hash = (bytes: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const pins = Object.freeze({
  "infra/dev-ui/host-source.json": "ea7d291fd1a10a1967ba15ce728a1147bc018357729f96e47ba0d61af20c9819",
  "tests/dev-ui/package.json": "ff9ca24325a2fc29076cb835ef740105c60cac8024a779c5092dede7accae8fe",
  "tests/dev-ui/bun.lock": "d089183128467d63e5a60622eaf43705d907abe64ddbcd9f963f9ade1735502b",
});
// All 11 published dist files were compared byte-for-byte with the official npm
// archive after verifying host-source.json's SHA-512. This checks installed code,
// not merely its package.json version or a lockfile declaration.
const pajaTreeSha256 = "adf1158f2b6cd06ebbc02e35ff2a2b359dfaec60f3a14de093a64a163ee95c92";

export async function verifyDevelopmentHostFiles(projectRoot = root): Promise<string> {
  for (const [path, expected] of Object.entries(pins)) {
    if (hash(await readFile(join(projectRoot, path))) !== expected) throw new Error("DEV_HOST_PIN_MISMATCH");
  }
  for (const [name, version] of [["@kehto/paja", "0.19.0"], ["playwright", "1.62.1"], ["playwright-core", "1.62.1"]]) {
    const installed = JSON.parse(await readFile(join(projectRoot, "tests/dev-ui/node_modules", name!, "package.json"), "utf8"));
    if (installed.name !== name || installed.version !== version) throw new Error("DEV_HOST_PACKAGE_MISMATCH");
  }
  const dist = join(projectRoot, "tests/dev-ui/node_modules/@kehto/paja/dist"); const files: string[] = [];
  async function walk(path = "", depth = 0): Promise<void> {
    if (depth > 6) throw new Error("DEV_HOST_TREE_INVALID");
    for (const entry of await readdir(join(dist, path), { withFileTypes: true })) {
      const name = join(path, entry.name);
      if (entry.isDirectory()) await walk(name, depth + 1);
      else if (entry.isFile() && files.length < 128) files.push(name);
      else throw new Error("DEV_HOST_TREE_INVALID");
    }
  }
  await walk(); const facts: string[] = [];
  for (const path of files.sort()) {
    if ((await lstat(join(dist, path))).size > 4_000_000) throw new Error("DEV_HOST_TREE_INVALID");
    facts.push(`${path}:${hash(await readFile(join(dist, path)))}`);
  }
  if (hash(facts.join("\n")) !== pajaTreeSha256) throw new Error("DEV_HOST_CODE_MISMATCH");
  return hash(JSON.stringify({ pins, pajaTreeSha256 }));
}

export type DevelopmentRuntimeReadiness = Readonly<{ imageDigest: string; readinessProbeDigest: string; readyMonotonicMs: number; hostSha256: string; workerBrowserVersion: string }>;

/** Real, bounded no-network smoke probe. Invoke before admission/model spending. */
export class LocalDevelopmentRuntimeReadiness {
  constructor(private readonly options: Readonly<{ dockerBin?: string; image?: string; projectRoot?: string }> = {}) {}
  async assertReady(): Promise<DevelopmentRuntimeReadiness> {
    const projectRoot = this.options.projectRoot ?? root;
    const hostSha256 = await verifyDevelopmentHostFiles(projectRoot);
    const skills = await loadAuthoringSkills(join(projectRoot, "infra/dev-ui/authoring-skills"));
    const docker = this.options.dockerBin ?? "docker";
    const image = this.options.image ?? process.env.NAPPLET_CVM_DEV_WORKER_IMAGE ?? "napplet-cvm/dev-worker:development";
    const inspected = await runBoundedDevelopmentCommand([docker, "image", "inspect", image, "--format", "{{.Id}}|{{.Os}}|{{.Architecture}}"], { deadlineMs: 15_000, maxBytes: 16_000 });
    const [imageDigest, os, arch] = inspected.stdout.trim().split("|");
    if (inspected.exitCode !== 0 || !/^sha256:[a-f0-9]{64}$/u.test(imageDigest ?? "") || os !== "linux" || arch !== "arm64") throw new Error("DEV_WORKER_IMAGE_NOT_READY:build the linux/arm64 development worker image");
    const name = `napplet-cvm-dev-readiness-${crypto.randomUUID()}`;
    const script = `
      const {createRequire}=require('node:module'); const {realpathSync}=require('node:fs');
      const req=createRequire('/opt/template/package.json');
      const cliHash=new Bun.CryptoHasher('sha256').update(await Bun.file('/usr/local/bin/napplet').arrayBuffer()).digest('hex');
      const runnerHash=new Bun.CryptoHasher('sha256').update(await Bun.file('/usr/local/bin/run-proposal').arrayBuffer()).digest('hex');
      const skills=await (await import('/opt/authoring-skills.ts')).loadAuthoringSkills();
      const skillsLoaderHash=new Bun.CryptoHasher('sha256').update(await Bun.file('/opt/authoring-skills.ts').arrayBuffer()).digest('hex');
      const conf=req.resolve('@napplet/conformance-cli/package.json');
      const playwrightPath=req.resolve('playwright/package.json',{paths:[realpathSync(conf)]});
      const pw=createRequire(playwrightPath)('./index.js');
      const browser=await pw.chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
      try { const page=await browser.newPage(); await page.setContent('<button>ready</button>'); await page.getByRole('button',{name:'ready'}).click(); console.log(JSON.stringify({cliHash,runnerHash,skillsSha256:skills.sha256,skillsLoaderHash,browserVersion:browser.version(),playwright:require(playwrightPath).version,typescript:req('typescript/package.json').version,conformance:require(conf).version})); } finally {await browser.close();}
    `;
    let probe: { cliHash: string; runnerHash: string; skillsSha256: string; skillsLoaderHash: string; browserVersion: string; playwright: string; typescript: string; conformance: string };
    try {
      const result = await runBoundedDevelopmentCommand([docker, "run", "--name", name, "--rm", "--network", "none", "--read-only", "--user", "65532:65532", "--cpus", "2", "--memory", "1g", "--pids-limit", "256", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--tmpfs", "/tmp:rw,exec,nosuid,nodev,size=256m", "--tmpfs", "/home/napplet:rw,nosuid,nodev,size=64m", "--entrypoint", "bun", imageDigest!, "-e", script], { deadlineMs: 45_000, maxBytes: 32_000 });
      if (result.exitCode !== 0) throw new Error("DEV_WORKER_BROWSER_NOT_READY:rebuild the development worker image");
      probe = JSON.parse(result.stdout.trim());
      if (probe.skillsSha256 !== skills.sha256 || probe.skillsLoaderHash !== hash(await readFile(join(projectRoot, "infra/dev-ui/authoring-skills.ts"))) || probe.cliHash !== "35ffb0d21e75877e749d63569b4369e5b467967e48034c2ee7d0ae958ed5ee54" || probe.runnerHash !== hash(await readFile(join(projectRoot, "infra/dev-ui/run-proposal.ts"))) || probe.playwright !== "1.61.0" || probe.typescript !== "5.9.3" || probe.conformance !== "0.2.15" || !/^\d+\.\d+\.\d+\.\d+$/u.test(probe.browserVersion)) throw new Error("DEV_WORKER_TOOLCHAIN_MISMATCH:rebuild the development worker image");
    } finally {
      await runBoundedDevelopmentCommand([docker, "rm", "--force", name], { deadlineMs: 5_000, maxBytes: 8_000 }).catch(() => undefined);
    }
    // Keep Playwright's extra child-process pipes out of the long-lived service.
    // Isolate the reported Bun 1.3.14/Playwright child-pipe finalization issue
    // from listener and subprocess descriptors in the service process.
    // https://github.com/microsoft/playwright/issues/42692
    // Chromium can spend 30s in its own bounded shutdown before killing a
    // stalled child. Allow that cleanup after the 20s launch deadline.
    const hostProbe = await runBoundedDevelopmentCommand([process.execPath, "-e", `
      const { chromium } = await import(${JSON.stringify(join(projectRoot, "tests/dev-ui/node_modules/playwright"))});
      const browser = await chromium.launch({ headless: true, timeout: 20_000 });
      try { console.log(JSON.stringify({ browserVersion: browser.version() })); }
      finally { await browser.close(); }
    `], { deadlineMs: 55_000, maxBytes: 8_000 });
    if (hostProbe.exitCode !== 0) throw new Error("DEV_HOST_BROWSER_NOT_READY:install the pinned host Chromium");
    let hostBrowserVersion: unknown;
    try { hostBrowserVersion = JSON.parse(hostProbe.stdout.trim()).browserVersion; }
    catch { throw new Error("DEV_HOST_BROWSER_EVIDENCE_INVALID"); }
    if (typeof hostBrowserVersion !== "string" || !/^\d+\.\d+\.\d+\.\d+$/u.test(hostBrowserVersion)) throw new Error("DEV_HOST_BROWSER_EVIDENCE_INVALID");
    const evidence = { imageDigest, hostSha256, hostBrowserVersion, ...probe };
    return Object.freeze({ imageDigest: imageDigest!, hostSha256, readinessProbeDigest: `sha256:${hash(JSON.stringify(evidence))}`, workerBrowserVersion: probe.browserVersion, readyMonotonicMs: Math.floor(performance.now()) });
  }
}
